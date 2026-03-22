const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { log } = require('../wg-core');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/email-service');
const UserSession = require('../models/UserSession');
const { recordSecurityEvent, createUserSession, touchSession, revokeSession, getRequestIp, getRequestUserAgent } = require('../services/security-event-service');
const { verifyTotpCode } = require('../utils/totp');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';
const TWO_FACTOR_CHALLENGE_EXPIRY = '10m';
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'mikrotik_admin_session';
const REMEMBER_DEVICE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

function buildSessionUser(user) {
    return {
        ...user.toJSON(),
        adminRole: user.adminRole || null,
        twoFactorEnabled: user.role === 'admin' ? Boolean(user.twoFactorEnabled) : false,
    };
}

function createSessionToken({ user, sessionId }) {
    return jwt.sign(
        { userId: user._id, email: user.email, sid: sessionId },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
}

function createTwoFactorChallengeToken({ user, req, rememberDevice = false }) {
    return jwt.sign(
        {
            userId: user._id,
            email: user.email,
            purpose: '2fa_login',
            rememberDevice: Boolean(rememberDevice),
            ipAddress: getRequestIp(req),
            userAgent: getRequestUserAgent(req),
        },
        JWT_SECRET,
        { expiresIn: TWO_FACTOR_CHALLENGE_EXPIRY }
    );
}

function parseCookies(cookieHeader = '') {
    return String(cookieHeader || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((cookies, part) => {
            const separatorIndex = part.indexOf('=');
            if (separatorIndex === -1) return cookies;
            const key = part.slice(0, separatorIndex).trim();
            const value = part.slice(separatorIndex + 1).trim();
            if (key) {
                cookies[key] = decodeURIComponent(value);
            }
            return cookies;
        }, {});
}

function getTokenExpiry(token) {
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded !== 'object' || !decoded.exp) {
        return null;
    }

    return new Date(decoded.exp * 1000).toISOString();
}

function setAuthCookie(res, token, rememberDevice = false) {
    res.cookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        ...(rememberDevice ? { maxAge: REMEMBER_DEVICE_MAX_AGE_MS } : {})
    });
}

function clearAuthCookie(res) {
    res.clearCookie(AUTH_COOKIE_NAME, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
    });
}

function resolveAuthToken(req) {
    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader && authHeader.split(' ')[1];
    if (bearerToken) {
        return bearerToken;
    }

    const cookies = parseCookies(req.headers.cookie || '');
    return cookies[AUTH_COOKIE_NAME] || null;
}

function registerAuthRoutes(app) {
    // User signup
    app.post('/api/auth/signup', async (req, res) => {
        try {
            const { email, password, name } = req.body;

            if (!email || !password || !name) {
                return res.status(400).json({
                    success: false,
                    error: 'Email, password, and name are required'
                });
            }

            if (password.length < 6) {
                return res.status(400).json({
                    success: false,
                    error: 'Password must be at least 6 characters'
                });
            }

            // Check if user exists
            const existing = await User.findOne({ email: email.toLowerCase() });
            if (existing) {
                return res.status(409).json({
                    success: false,
                    error: 'User with this email already exists'
                });
            }

            // Handle referral code if provided (from query or body)
            let referrerId = null;
            const referrerCode = req.body.referralCode || req.query.referralCode || req.query.ref;
            if (referrerCode) {
                const referrer = await User.findOne({ referralCode: referrerCode.toUpperCase() });
                if (referrer) {
                    referrerId = referrer._id;
                }
            }

            // Generate referral code for the new user
            const userReferralCode = crypto.randomBytes(8).toString('hex').toUpperCase();

            // Create user
            const user = new User({
                email: email.toLowerCase(),
                password,
                name,
                referralCode: userReferralCode
            });

            // Generate verification token
            const verificationToken = user.generateVerificationToken();
            await user.save();

            // Create referral record if referred
            if (referrerId) {
                const Referral = require('../models/Referral');
                const referral = new Referral({
                    referrerId,
                    referredId: user._id,
                    referralCode: user.referralCode,
                    status: 'pending'
                });
                await referral.save();
                log('info', 'referral_created', { referrerId, referredId: user._id });
            }

            // Send verification email
            try {
                await sendVerificationEmail(user, verificationToken);
                user.lastVerificationEmailSentAt = new Date();
                await user.save();
                log('info', 'verification_email_sent', { userId: user._id, email: user.email });
            } catch (emailError) {
                log('error', 'verification_email_failed', { 
                    userId: user._id, 
                    email: user.email,
                    error: emailError.message 
                });
                // Don't fail signup if email fails, but log it
            }

            user.lastLoginAt = new Date();
            user.failedLoginCount = 0;
            await user.save();

            const session = await createUserSession({ userId: user._id, req, source: 'signup' });
            await recordSecurityEvent({
                eventType: 'signup',
                category: 'auth',
                severity: 'low',
                source: 'user',
                success: true,
                userId: user._id,
                sessionId: session.sessionId,
                ipAddress: getRequestIp(req),
                userAgent: getRequestUserAgent(req),
                metadata: { email: user.email }
            });

            // Generate JWT token
            const token = jwt.sign(
                { userId: user._id, email: user.email, sid: session.sessionId },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRY }
            );

            res.status(201).json({
                success: true,
                message: 'User created successfully. Please check your email to verify your account.',
                data: {
                    user: buildSessionUser(user),
                    token
                }
            });
        } catch (error) {
            log('error', 'signup_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to create user',
                details: error.message
            });
        }
    });

    // Verify email
    app.get('/api/auth/verify-email', async (req, res) => {
        try {
            const { token } = req.query;

            if (!token) {
                return res.status(400).json({
                    success: false,
                    error: 'Verification token is required'
                });
            }

            const user = await User.findOne({
                emailVerificationToken: token,
                emailVerificationExpires: { $gt: new Date() }
            });

            if (!user) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid or expired verification token'
                });
            }

            user.emailVerified = true;
            user.emailVerifiedAt = new Date();
            user.emailVerificationToken = undefined;
            user.emailVerificationExpires = undefined;
            await user.save();

            await recordSecurityEvent({
                eventType: 'email_verified',
                category: 'account',
                severity: 'low',
                source: 'user',
                success: true,
                userId: user._id,
                metadata: { email: user.email }
            });

            res.json({
                success: true,
                message: 'Email verified successfully'
            });
        } catch (error) {
            log('error', 'verify_email_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to verify email',
                details: error.message
            });
        }
    });

    // Resend verification email
    app.post('/api/auth/resend-verification', authenticateToken, async (req, res) => {
        try {
            const user = await User.findById(req.user.userId);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'User not found'
                });
            }

            if (user.emailVerified) {
                return res.status(400).json({
                    success: false,
                    error: 'Email already verified'
                });
            }

            const verificationToken = user.generateVerificationToken();
            await user.save();

            try {
                await sendVerificationEmail(user, verificationToken);
                user.lastVerificationEmailSentAt = new Date();
                await user.save();
                await recordSecurityEvent({
                    eventType: 'verification_email_sent',
                    category: 'account',
                    severity: 'low',
                    source: 'user',
                    success: true,
                    userId: user._id,
                    ipAddress: getRequestIp(req),
                    userAgent: getRequestUserAgent(req)
                });
                log('info', 'verification_email_resent', { userId: user._id, email: user.email });
            } catch (emailError) {
                log('error', 'resend_verification_email_failed', { 
                    userId: user._id, 
                    error: emailError.message 
                });
                return res.status(500).json({
                    success: false,
                    error: 'Failed to send verification email',
                    details: emailError.message
                });
            }

            res.json({
                success: true,
                message: 'Verification email sent successfully'
            });
        } catch (error) {
            log('error', 'resend_verification_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to resend verification email',
                details: error.message
            });
        }
    });

    // User login
    app.post('/api/auth/login', async (req, res) => {
        try {
            const { email, password, rememberDevice = false } = req.body;

            if (!email || !password) {
                return res.status(400).json({
                    success: false,
                    error: 'Email and password are required'
                });
            }

            // Find user
            const user = await User.findOne({ email: email.toLowerCase() }).select('+twoFactorSecret');
            if (!user) {
                await recordSecurityEvent({
                    eventType: 'login_failed',
                    category: 'auth',
                    severity: 'medium',
                    source: 'user',
                    success: false,
                    ipAddress: getRequestIp(req),
                    userAgent: getRequestUserAgent(req),
                    reason: 'User not found',
                    metadata: { email: email.toLowerCase() }
                });
                return res.status(401).json({
                    success: false,
                    error: 'Invalid email or password'
                });
            }

            // Check password
            const isValid = await user.comparePassword(password);
            if (!isValid) {
                user.lastFailedLoginAt = new Date();
                user.failedLoginCount = (user.failedLoginCount || 0) + 1;
                await user.save();
                await recordSecurityEvent({
                    eventType: 'login_failed',
                    category: 'auth',
                    severity: user.failedLoginCount >= 5 ? 'high' : 'medium',
                    source: 'user',
                    success: false,
                    userId: user._id,
                    ipAddress: getRequestIp(req),
                    userAgent: getRequestUserAgent(req),
                    reason: 'Invalid password',
                    metadata: { failedLoginCount: user.failedLoginCount }
                });
                return res.status(401).json({
                    success: false,
                    error: 'Invalid email or password'
                });
            }

            // Check if user is active
            if (!user.isActive) {
                await recordSecurityEvent({
                    eventType: 'login_blocked',
                    category: 'auth',
                    severity: 'high',
                    source: 'system',
                    success: false,
                    userId: user._id,
                    ipAddress: getRequestIp(req),
                    userAgent: getRequestUserAgent(req),
                    reason: 'Account is deactivated'
                });
                return res.status(403).json({
                    success: false,
                    error: 'Account is deactivated'
                });
            }

            if (user.role === 'admin' && user.twoFactorEnabled && user.twoFactorSecret) {
                user.failedLoginCount = 0;
                await user.save();
                await recordSecurityEvent({
                    eventType: 'login_challenged',
                    category: 'auth',
                    severity: 'low',
                    source: 'user',
                    success: true,
                    userId: user._id,
                    ipAddress: getRequestIp(req),
                    userAgent: getRequestUserAgent(req),
                    metadata: { twoFactorRequired: true }
                });

                return res.status(202).json({
                    success: true,
                    message: 'Two-factor authentication required',
                    data: {
                        requiresTwoFactor: true,
                        challengeToken: createTwoFactorChallengeToken({ user, req, rememberDevice }),
                        user: buildSessionUser(user),
                    }
                });
            }

            user.lastLoginAt = new Date();
            user.failedLoginCount = 0;
            await user.save();

            const session = await createUserSession({ userId: user._id, req, source: 'login' });
            await recordSecurityEvent({
                eventType: 'login_succeeded',
                category: 'auth',
                severity: 'low',
                source: 'user',
                success: true,
                userId: user._id,
                sessionId: session.sessionId,
                ipAddress: getRequestIp(req),
                userAgent: getRequestUserAgent(req)
            });

            const token = createSessionToken({ user, sessionId: session.sessionId });
            setAuthCookie(res, token, rememberDevice);

            res.json({
                success: true,
                message: 'Login successful',
                data: {
                    user: buildSessionUser(user),
                    sessionExpiresAt: getTokenExpiry(token)
                }
            });
        } catch (error) {
            log('error', 'login_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to login',
                details: error.message
            });
        }
    });

    app.post('/api/auth/login/2fa', async (req, res) => {
        try {
            const { challengeToken, code } = req.body;

            if (!challengeToken || !code) {
                return res.status(400).json({
                    success: false,
                    error: 'Challenge token and verification code are required'
                });
            }

            let challenge;
            try {
                challenge = jwt.verify(challengeToken, JWT_SECRET);
            } catch (error) {
                return res.status(401).json({
                    success: false,
                    error: 'Invalid or expired two-factor challenge'
                });
            }

            if (!challenge || challenge.purpose !== '2fa_login' || !challenge.userId) {
                return res.status(401).json({
                    success: false,
                    error: 'Invalid two-factor challenge'
                });
            }

            const rememberDevice = Boolean(challenge.rememberDevice);
            const user = await User.findById(challenge.userId).select('+twoFactorSecret');
            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'User not found'
                });
            }

            if (!user.isActive) {
                return res.status(403).json({
                    success: false,
                    error: 'Account is deactivated'
                });
            }

            if (user.role !== 'admin') {
                return res.status(403).json({
                    success: false,
                    error: 'Two-factor authentication is only available for admin accounts'
                });
            }

            if (!user.twoFactorEnabled || !user.twoFactorSecret) {
                return res.status(400).json({
                    success: false,
                    error: 'Two-factor authentication is not enabled for this account'
                });
            }

            if (!verifyTotpCode(user.twoFactorSecret, code)) {
                user.lastFailedLoginAt = new Date();
                user.failedLoginCount = (user.failedLoginCount || 0) + 1;
                await user.save();
                await recordSecurityEvent({
                    eventType: 'login_failed',
                    category: 'auth',
                    severity: user.failedLoginCount >= 5 ? 'high' : 'medium',
                    source: 'user',
                    success: false,
                    userId: user._id,
                    ipAddress: getRequestIp(req),
                    userAgent: getRequestUserAgent(req),
                    reason: 'Invalid two-factor code',
                    metadata: { failedLoginCount: user.failedLoginCount }
                });
                return res.status(401).json({
                    success: false,
                    error: 'Invalid authentication code'
                });
            }

            user.lastLoginAt = new Date();
            user.failedLoginCount = 0;
            user.twoFactorLastVerifiedAt = new Date();
            await user.save();

            const session = await createUserSession({ userId: user._id, req, source: 'login' });
            await recordSecurityEvent({
                eventType: 'login_succeeded',
                category: 'auth',
                severity: 'low',
                source: 'user',
                success: true,
                userId: user._id,
                sessionId: session.sessionId,
                ipAddress: getRequestIp(req),
                userAgent: getRequestUserAgent(req),
                metadata: { twoFactorVerified: true }
            });

            const token = createSessionToken({ user, sessionId: session.sessionId });
            setAuthCookie(res, token, rememberDevice);

            res.json({
                success: true,
                message: 'Two-factor login successful',
                data: {
                    user: buildSessionUser(user),
                    sessionExpiresAt: getTokenExpiry(token),
                }
            });
        } catch (error) {
            log('error', 'login_2fa_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to complete two-factor login',
                details: error.message
            });
        }
    });

    // Get current user profile
    app.get('/api/auth/me', authenticateToken, async (req, res) => {
        try {
            if (!req.user || !req.user.userId) {
                return res.status(401).json({
                    success: false,
                    error: 'Invalid authentication token'
                });
            }

            const user = await User.findById(req.user.userId);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'User not found'
                });
            }

            // Use toJSON method if available, otherwise manually exclude password
            let userData;
            if (typeof user.toJSON === 'function') {
                userData = user.toJSON();
            } else {
                userData = user.toObject();
                delete userData.password;
                delete userData.emailVerificationToken;
            }

            userData.adminRole = user.adminRole || null;
            userData.twoFactorEnabled = Boolean(user.twoFactorEnabled);

            res.json({
                success: true,
                user: userData,
                sessionExpiresAt: req.user.exp ? new Date(req.user.exp * 1000).toISOString() : null,
            });
        } catch (error) {
            log('error', 'get_user_error', { error: error.message, stack: error.stack });
            res.status(500).json({
                success: false,
                error: 'Failed to get user',
                details: error.message
            });
        }
    });

    app.post('/api/auth/logout', authenticateToken, async (req, res) => {
        try {
            if (req.user?.sid) {
                await revokeSession(req.user.sid, req.user.email || 'system', 'User logged out', req.user.userId || null);
            }

            clearAuthCookie(res);

            return res.json({
                success: true,
                message: 'Logged out successfully'
            });
        } catch (error) {
            log('error', 'logout_error', { error: error.message });
            return res.status(500).json({
                success: false,
                error: 'Failed to logout',
                details: error.message
            });
        }
    });

    // Request password reset
    app.post('/api/auth/forgot-password', async (req, res) => {
        try {
            const { email } = req.body;

            if (!email) {
                return res.status(400).json({
                    success: false,
                    error: 'Email is required'
                });
            }

            const user = await User.findOne({ email: email.toLowerCase() });
            
            // Always return success to prevent email enumeration
            if (!user) {
                return res.json({
                    success: true,
                    message: 'If an account exists with this email, a password reset link has been sent.'
                });
            }

            // Generate reset token
            const resetToken = user.generatePasswordResetToken();
            user.passwordResetRequestedAt = new Date();
            await user.save();
            await recordSecurityEvent({
                eventType: 'password_reset_requested',
                category: 'account',
                severity: 'medium',
                source: 'user',
                success: true,
                userId: user._id,
                ipAddress: getRequestIp(req),
                userAgent: getRequestUserAgent(req)
            });

            // Send password reset email
            try {
                await sendPasswordResetEmail(user, resetToken);
            } catch (emailError) {
                log('error', 'password_reset_email_failed', { error: emailError.message });
                // Don't fail the request if email fails
            }

            res.json({
                success: true,
                message: 'If an account exists with this email, a password reset link has been sent.'
            });
        } catch (error) {
            log('error', 'forgot_password_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to process password reset request',
                details: error.message
            });
        }
    });

    // Reset password with token
    app.post('/api/auth/reset-password', async (req, res) => {
        try {
            const { token, password } = req.body;

            if (!token || !password) {
                return res.status(400).json({
                    success: false,
                    error: 'Token and password are required'
                });
            }

            if (password.length < 6) {
                return res.status(400).json({
                    success: false,
                    error: 'Password must be at least 6 characters'
                });
            }

            const user = await User.findOne({
                passwordResetToken: token,
                passwordResetExpires: { $gt: Date.now() }
            });

            if (!user) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid or expired password reset token'
                });
            }

            // Set new password
            user.password = password;
            user.passwordResetCompletedAt = new Date();
            user.passwordResetToken = undefined;
            user.passwordResetExpires = undefined;
            await user.save();
            await recordSecurityEvent({
                eventType: 'password_reset_completed',
                category: 'account',
                severity: 'high',
                source: 'user',
                success: true,
                userId: user._id,
                ipAddress: getRequestIp(req),
                userAgent: getRequestUserAgent(req)
            });

            res.json({
                success: true,
                message: 'Password has been reset successfully'
            });
        } catch (error) {
            log('error', 'reset_password_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to reset password',
                details: error.message
            });
        }
    });
}

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
    const token = resolveAuthToken(req);

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Authentication token required'
        });
    }

    jwt.verify(token, JWT_SECRET, async (err, user) => {
        if (err) {
            return res.status(403).json({
                success: false,
                error: 'Invalid or expired token'
            });
        }

        try {
            const dbUser = await User.findById(user.userId).select('_id email role isActive sessionsRevokedAt');
            if (!dbUser) {
                return res.status(401).json({
                    success: false,
                    error: 'User not found'
                });
            }

            if (!dbUser.isActive) {
                return res.status(403).json({
                    success: false,
                    error: 'Account is deactivated'
                });
            }

            const issuedAtMs = user.iat ? user.iat * 1000 : 0;
            if (dbUser.sessionsRevokedAt && issuedAtMs && issuedAtMs <= new Date(dbUser.sessionsRevokedAt).getTime()) {
                return res.status(403).json({
                    success: false,
                    error: 'Token has been revoked'
                });
            }

            if (user.sid) {
                const session = await UserSession.findOne({ sessionId: user.sid }).select('status revokedAt');
                if (session && session.status === 'revoked') {
                    return res.status(403).json({
                        success: false,
                        error: 'Session has been revoked'
                    });
                }
                await touchSession(user.sid);
            }

            req.user = {
                ...user,
                role: dbUser.role,
                email: dbUser.email
            };
            next();
        } catch (lookupError) {
            return res.status(500).json({
                success: false,
                error: 'Failed to validate authentication token',
                details: lookupError.message
            });
        }
    });
}

module.exports = { registerAuthRoutes, authenticateToken };
