const RouterBackup = require('../models/RouterBackup');
const MikrotikRouter = require('../models/MikrotikRouter');
const { executeCommand } = require('./routeros-command-service');

function normalizeExportOutput(result) {
    if (typeof result === 'string') {
        return result.trim();
    }
    if (Array.isArray(result)) {
        const lines = result.flatMap((entry) => {
            if (!entry) return [];
            if (typeof entry === 'string') return [entry];
            if (typeof entry['=output'] === 'string') return [entry['=output']];
            if (typeof entry.output === 'string') return [entry.output];
            return Object.entries(entry)
                .filter(([key, value]) => typeof value === 'string' && (key.includes('output') || key.includes('message')))
                .map(([, value]) => value);
        }).filter(Boolean);
        return lines.join('\n').trim();
    }
    if (result && typeof result === 'object') {
        return normalizeExportOutput(Object.values(result));
    }
    return '';
}

function createFilename(router, createdAt) {
    const safeName = String(router?.name || router?._id || 'router')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'router';
    const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
    return `${safeName}-${stamp}.rsc`;
}

function evaluateRestoreReadiness(exportText, router) {
    const normalized = String(exportText || '').trim();
    const signals = [];

    if (normalized.includes('/interface') || normalized.includes('/ip address') || normalized.includes('/ip route')) {
        signals.push('config_sections_present');
    }
    if (normalized.length > 200) {
        signals.push('export_length_sufficient');
    }
    if (router?.routerboardInfo?.serialNumber) {
        signals.push('serial_recorded');
    }
    if (router?.routerosVersion || router?.routerboardInfo?.firmware) {
        signals.push('version_recorded');
    }

    const restoreCompatible = signals.length >= 3;
    return {
        restoreCompatible,
        lastRestoreTestAt: restoreCompatible ? new Date() : null,
        restoreValidationSignals: signals
    };
}

async function fetchExportText(routerId) {
    const primary = await executeCommand(routerId, '/export', {}, { operationName: 'backup_export' }).catch(() => null);
    let exportText = normalizeExportOutput(primary);
    if (exportText) {
        return exportText;
    }

    const verbose = await executeCommand(routerId, '/export', { verbose: 'yes' }, { operationName: 'backup_export' }).catch(() => null);
    exportText = normalizeExportOutput(verbose);
    if (exportText) {
        return exportText;
    }

    throw new Error('Router export output was empty');
}

async function createBackup(routerId, { triggeredBy = 'manual', createdBy = 'admin', note = '' } = {}) {
    const router = await MikrotikRouter.findById(routerId).select('_id name routerosVersion routerboardInfo');
    if (!router) {
        throw new Error('Router not found');
    }

    const exportText = await fetchExportText(routerId);
    const createdAt = new Date();
    const readiness = evaluateRestoreReadiness(exportText, router);

    return RouterBackup.create({
        routerId,
        filename: createFilename(router, createdAt),
        exportText,
        sizeBytes: Buffer.byteLength(exportText, 'utf8'),
        triggeredBy,
        createdBy,
        note: String(note || '').trim(),
        metadata: {
            routerosVersion: router.routerosVersion || router.routerboardInfo?.firmware || null,
            boardName: router.routerboardInfo?.boardName || null,
            model: router.routerboardInfo?.model || null,
            serialNumber: router.routerboardInfo?.serialNumber || null,
            restoreCompatible: readiness.restoreCompatible,
            lastRestoreTestAt: readiness.lastRestoreTestAt,
            restoreValidationSignals: readiness.restoreValidationSignals
        },
        createdAt,
        updatedAt: createdAt
    });
}

async function listBackups(routerId, page = 1, limit = 20) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const [items, total] = await Promise.all([
        RouterBackup.find({ routerId })
            .sort({ createdAt: -1 })
            .skip((safePage - 1) * safeLimit)
            .limit(safeLimit),
        RouterBackup.countDocuments({ routerId })
    ]);

    return {
        items,
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit) || 1
        }
    };
}

async function getBackupContent(routerId, backupId) {
    const backup = await RouterBackup.findOne({ _id: backupId, routerId });
    if (!backup) {
        throw new Error('Backup not found');
    }
    return backup;
}

async function deleteBackup(routerId, backupId) {
    const backup = await RouterBackup.findOneAndDelete({ _id: backupId, routerId });
    if (!backup) {
        throw new Error('Backup not found');
    }
    return backup;
}

module.exports = {
    createBackup,
    listBackups,
    getBackupContent,
    deleteBackup
};
