const crypto = require('crypto');
const SecurityEvent = require('../models/SecurityEvent');
const UserSession = require('../models/UserSession');
const { log } = require('../wg-core');

function getRequestIp(req) {
    return req?.ip || req?.headers?.['x-forwarded-for'] || '';
}

function getRequestUserAgent(req) {
    return req?.headers?.['user-agent'] || '';
}

async function recordSecurityEvent(payload = {}) {
    try {
        return await SecurityEvent.create({
            eventType: payload.eventType,
            category: payload.category || 'auth',
            severity: payload.severity || 'medium',
            source: payload.source || 'system',
            success: payload.success !== false,
            userId: payload.userId || null,
            actorUserId: payload.actorUserId || null,
            sessionId: payload.sessionId || '',
            ipAddress: payload.ipAddress || '',
            userAgent: payload.userAgent || '',
            reason: payload.reason || '',
            metadata: payload.metadata || {}
        });
    } catch (error) {
        log('error', 'security_event_record_failed', { error: error.message, eventType: payload.eventType });
        return null;
    }
}

async function createUserSession({ userId, req, source = 'login' }) {
    const sessionId = crypto.randomUUID();
    const session = await UserSession.create({
        sessionId,
        userId,
        source,
        ipAddress: getRequestIp(req),
        userAgent: getRequestUserAgent(req),
        issuedAt: new Date(),
        lastSeenAt: new Date(),
        status: 'active'
    });

    await recordSecurityEvent({
        eventType: 'session_issued',
        category: 'session',
        severity: 'low',
        source: 'system',
        success: true,
        userId,
        sessionId,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        metadata: { source }
    });

    return session;
}

async function touchSession(sessionId) {
    if (!sessionId) return null;
    return UserSession.findOneAndUpdate(
        { sessionId },
        { $set: { lastSeenAt: new Date() } },
        { new: true }
    );
}

async function revokeSession(sessionId, actorEmail = 'system', reason = '', actorUserId = null) {
    const session = await UserSession.findOne({ sessionId });
    if (!session) return null;
    session.status = 'revoked';
    session.revokedAt = new Date();
    session.revokedBy = actorEmail;
    session.revokeReason = reason || '';
    await session.save();

    await recordSecurityEvent({
        eventType: 'session_revoked',
        category: 'session',
        severity: 'medium',
        source: actorUserId ? 'admin' : 'system',
        success: true,
        userId: session.userId,
        actorUserId,
        sessionId: session.sessionId,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        reason,
        metadata: {}
    });

    return session;
}

async function revokeAllUserSessions(userId, actorEmail = 'system', reason = '', actorUserId = null) {
    const now = new Date();
    const sessions = await UserSession.find({ userId, status: 'active' });
    if (!sessions.length) return [];
    await UserSession.updateMany(
        { userId, status: 'active' },
        {
            $set: {
                status: 'revoked',
                revokedAt: now,
                revokedBy: actorEmail,
                revokeReason: reason || ''
            }
        }
    );

    await recordSecurityEvent({
        eventType: 'all_sessions_revoked',
        category: 'session',
        severity: 'high',
        source: actorUserId ? 'admin' : 'system',
        success: true,
        userId,
        actorUserId,
        reason,
        metadata: { count: sessions.length }
    });

    return sessions;
}

module.exports = {
    recordSecurityEvent,
    createUserSession,
    touchSession,
    revokeSession,
    revokeAllUserSessions,
    getRequestIp,
    getRequestUserAgent
};
