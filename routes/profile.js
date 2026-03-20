const User = require('../models/User');
const { log } = require('../wg-core');
const { authenticateToken } = require('./auth');
const { buildOtpAuthUri, generateTotpSecret, verifyTotpCode } = require('../utils/totp');
const { recordSecurityEvent, getRequestIp, getRequestUserAgent } = require('../services/security-event-service');

function ensureAdminTwoFactorAccess(user, res) {
    if (user.role !== 'admin') {
        res.status(403).json({
            success: false,
            error: 'Two-factor authentication is only available for admin accounts'
        });
        return false;
    }

    return true;
}

function registerProfileRoutes(app) {
    // Get user profile
    app.get('/api/profile', authenticateToken, async (req, res) => {
        try {
            const user = await User.findById(req.user.userId).select('-password +twoFactorTempSecret');
            
            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'User not found'
                });
            }

            res.json({
                success: true,
                user: {
                    ...user.toJSON(),
                    twoFactorEnabled: user.role === 'admin' ? Boolean(user.twoFactorEnabled) : false,
                    twoFactorPendingSetup: user.role === 'admin' ? Boolean(user.twoFactorTempSecret) : false,
                }
            });
        } catch (error) {
            log('error', 'get_profile_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get profile',
                details: error.message
            });
        }
    });

    // Update user profile
    app.put('/api/profile', authenticateToken, async (req, res) => {
        try {
            const { name, currentPassword, newPassword } = req.body;
            const user = await User.findById(req.user.userId);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'User not found'
                });
            }

            // Update name if provided
            if (name) {
                user.name = name;
            }

            // Update password if provided
            if (newPassword) {
                if (!currentPassword) {
                    return res.status(400).json({
                        success: false,
                        error: 'Current password is required to change password'
                    });
                }

                const isValidPassword = await user.comparePassword(currentPassword);
                if (!isValidPassword) {
                    return res.status(401).json({
                        success: false,
                        error: 'Current password is incorrect'
                    });
                }

                if (newPassword.length < 6) {
                    return res.status(400).json({
                        success: false,
                        error: 'New password must be at least 6 characters'
                    });
                }

                user.password = newPassword; // Will be hashed by pre-save hook
            }

            await user.save();

            res.json({
                success: true,
                message: 'Profile updated successfully',
                user: user.toJSON()
            });
        } catch (error) {
            log('error', 'update_profile_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to update profile',
                details: error.message
            });
        }
    });

    app.post('/api/profile/2fa/setup', authenticateToken, async (req, res) => {
        try {
            const { currentPassword } = req.body;
            const user = await User.findById(req.user.userId).select('+twoFactorSecret +twoFactorTempSecret');

            if (!user) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }

            if (!ensureAdminTwoFactorAccess(user, res)) {
                return;
            }

            if (!currentPassword) {
                return res.status(400).json({ success: false, error: 'Current password is required' });
            }

            const passwordValid = await user.comparePassword(currentPassword);
            if (!passwordValid) {
                return res.status(401).json({ success: false, error: 'Current password is incorrect' });
            }

            const secret = generateTotpSecret();
            user.twoFactorTempSecret = secret;
            await user.save();

            await recordSecurityEvent({
                eventType: 'two_factor_setup_started',
                category: 'auth',
                severity: 'medium',
                source: 'user',
                success: true,
                userId: user._id,
                ipAddress: getRequestIp(req),
                userAgent: getRequestUserAgent(req)
            });

            return res.json({
                success: true,
                setup: {
                    secret,
                    otpauthUrl: buildOtpAuthUri({
                        secret,
                        label: user.email,
                        issuer: 'Mikrotik Admin'
                    }),
                    manualEntryKey: secret,
                    issuer: 'Mikrotik Admin'
                }
            });
        } catch (error) {
            log('error', 'two_factor_setup_error', { error: error.message });
            return res.status(500).json({ success: false, error: 'Failed to start two-factor setup', details: error.message });
        }
    });

    app.post('/api/profile/2fa/enable', authenticateToken, async (req, res) => {
        try {
            const { code } = req.body;
            const user = await User.findById(req.user.userId).select('+twoFactorSecret +twoFactorTempSecret');

            if (!user) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }

            if (!ensureAdminTwoFactorAccess(user, res)) {
                return;
            }

            if (!user.twoFactorTempSecret) {
                return res.status(400).json({ success: false, error: 'Two-factor setup has not been started' });
            }

            if (!verifyTotpCode(user.twoFactorTempSecret, code)) {
                return res.status(401).json({ success: false, error: 'Invalid authentication code' });
            }

            user.twoFactorSecret = user.twoFactorTempSecret;
            user.twoFactorTempSecret = undefined;
            user.twoFactorEnabled = true;
            user.twoFactorEnabledAt = new Date();
            user.twoFactorLastVerifiedAt = new Date();
            await user.save();

            await recordSecurityEvent({
                eventType: 'two_factor_enabled',
                category: 'auth',
                severity: 'high',
                source: 'user',
                success: true,
                userId: user._id,
                ipAddress: getRequestIp(req),
                userAgent: getRequestUserAgent(req)
            });

            return res.json({
                success: true,
                message: 'Two-factor authentication enabled successfully',
                user: {
                    ...user.toJSON(),
                    twoFactorEnabled: true,
                    twoFactorPendingSetup: false,
                }
            });
        } catch (error) {
            log('error', 'two_factor_enable_error', { error: error.message });
            return res.status(500).json({ success: false, error: 'Failed to enable two-factor authentication', details: error.message });
        }
    });

    app.post('/api/profile/2fa/disable', authenticateToken, async (req, res) => {
        try {
            const { currentPassword, code } = req.body;
            const user = await User.findById(req.user.userId).select('+twoFactorSecret +twoFactorTempSecret');

            if (!user) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }

            if (!ensureAdminTwoFactorAccess(user, res)) {
                return;
            }

            if (!user.twoFactorEnabled || !user.twoFactorSecret) {
                return res.status(400).json({ success: false, error: 'Two-factor authentication is not enabled' });
            }

            if (!currentPassword) {
                return res.status(400).json({ success: false, error: 'Current password is required' });
            }

            const passwordValid = await user.comparePassword(currentPassword);
            if (!passwordValid) {
                return res.status(401).json({ success: false, error: 'Current password is incorrect' });
            }

            if (!verifyTotpCode(user.twoFactorSecret, code)) {
                return res.status(401).json({ success: false, error: 'Invalid authentication code' });
            }

            user.twoFactorEnabled = false;
            user.twoFactorSecret = undefined;
            user.twoFactorTempSecret = undefined;
            await user.save();

            await recordSecurityEvent({
                eventType: 'two_factor_disabled',
                category: 'auth',
                severity: 'high',
                source: 'user',
                success: true,
                userId: user._id,
                ipAddress: getRequestIp(req),
                userAgent: getRequestUserAgent(req)
            });

            return res.json({
                success: true,
                message: 'Two-factor authentication disabled successfully',
                user: {
                    ...user.toJSON(),
                    twoFactorEnabled: false,
                    twoFactorPendingSetup: false,
                }
            });
        } catch (error) {
            log('error', 'two_factor_disable_error', { error: error.message });
            return res.status(500).json({ success: false, error: 'Failed to disable two-factor authentication', details: error.message });
        }
    });
}

module.exports = registerProfileRoutes;
