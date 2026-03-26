const { requireAdminPermission } = require('../middleware/admin-auth');
const { ADMIN_ROUTER_PERMISSIONS } = require('../services/admin-router-service');
const RouterBackup = require('../models/RouterBackup');
const {
    createBackup,
    listBackups,
    getBackupContent,
    deleteBackup
} = require('../services/backup-service');

function registerBackupRoutes(app) {
    app.get('/api/admin/routers/:routerId/backups', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await listBackups(req.params.routerId, req.query.page, req.query.limit);
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(error.message === 'Router not found' ? 404 : 500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/admin/routers/:routerId/backups', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const backup = await createBackup(req.params.routerId, {
                note: req.body?.note || '',
                createdBy: req.adminUser?.email || 'admin',
                triggeredBy: req.body?.triggeredBy || 'manual'
            });
            return res.status(201).json({ success: true, data: backup });
        } catch (error) {
            return res.status(error.message === 'Router not found' ? 404 : 500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/admin/routers/:routerId/backups/:backupId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const backup = await RouterBackup.findOne({
                _id: req.params.backupId,
                routerId: req.params.routerId
            }).lean();

            if (!backup) {
                return res.status(404).json({ success: false, error: 'Backup not found' });
            }

            const { exportText, ...metadata } = backup;
            return res.json({
                success: true,
                backup: {
                    ...metadata,
                    id: String(metadata._id),
                    routerId: String(metadata.routerId)
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/admin/routers/:routerId/backups/:backupId/content', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const backup = await getBackupContent(req.params.routerId, req.params.backupId);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(backup.exportText || '');
        } catch (error) {
            return res.status(error.message === 'Backup not found' ? 404 : 500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/admin/routers/:routerId/backups/:backupId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            await deleteBackup(req.params.routerId, req.params.backupId);
            return res.json({ success: true, message: 'Backup deleted' });
        } catch (error) {
            return res.status(error.message === 'Backup not found' ? 404 : 500).json({ success: false, error: error.message });
        }
    });
}

module.exports = registerBackupRoutes;
