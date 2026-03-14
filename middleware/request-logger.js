const { log } = require('../wg-core');

const QUIET_PATHS = new Set([
    '/api/health',
    '/favicon.ico'
]);

function getPathname(url = '') {
    return String(url).split('?')[0] || '/';
}

function shouldLogRequest(req, statusCode, durationMs) {
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = getPathname(req.originalUrl || req.url);
    const isAdminRoute = pathname.startsWith('/api/admin/');
    const isAuthRoute = pathname.startsWith('/api/auth/');
    const isStaticUpload = pathname.startsWith('/uploads/');
    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const isError = statusCode >= 400;
    const isSlow = durationMs >= 1200;
    const verbose = ['1', 'true', 'yes', 'on'].includes(String(process.env.API_LOG_VERBOSE || '').toLowerCase());

    if (method === 'OPTIONS') return false;
    if (isStaticUpload) return false;
    if (QUIET_PATHS.has(pathname) && !isError) return false;
    if (verbose) return true;

    return isAdminRoute || isAuthRoute || isMutation || isError || isSlow;
}

function requestLogger(req, res, next) {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const statusCode = res.statusCode || 200;

        if (!shouldLogRequest(req, statusCode, durationMs)) {
            return;
        }

        const pathname = getPathname(req.originalUrl || req.url);
        const actorUserId = req.user?.userId || req.user?._id || null;
        const actorAdminId = req.adminUser?._id || null;

        log(statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info', 'api_request', {
            method: String(req.method || 'GET').toUpperCase(),
            path: pathname,
            statusCode,
            durationMs: Math.round(durationMs),
            ip: req.ip || req.headers['x-forwarded-for'] || null,
            actorUserId,
            actorAdminId
        });
    });

    next();
}

module.exports = {
    requestLogger
};
