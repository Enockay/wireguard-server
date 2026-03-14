const AdminAuditLog = require('../models/AdminAuditLog');
const { log } = require('../wg-core');

async function recordAdminAction({ req, actorUserId, targetUserId = null, targetRouterId = null, targetServerId = null, targetIncidentId = null, targetTicketId = null, targetSecurityEventId = null, targetSessionId = null, action, reason, metadata = {} }) {
    try {
        const auditEntry = await AdminAuditLog.create({
            action,
            actorUserId,
            targetUserId,
            targetRouterId,
            targetServerId,
            targetIncidentId,
            targetTicketId,
            targetSecurityEventId,
            targetSessionId,
            reason: reason || '',
            metadata,
            ipAddress: req?.ip || req?.headers?.['x-forwarded-for'] || '',
            userAgent: req?.headers?.['user-agent'] || ''
        });

        return auditEntry;
    } catch (error) {
        log('error', 'admin_audit_log_failed', {
            actorUserId,
            targetUserId,
            targetRouterId,
            targetServerId,
            targetIncidentId,
            targetTicketId,
            targetSecurityEventId,
            targetSessionId,
            action,
            error: error.message
        });
        return null;
    }
}

module.exports = {
    recordAdminAction
};
