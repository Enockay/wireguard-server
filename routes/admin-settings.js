const Settings = require("../models/Settings");
const { authenticateToken, requireAdmin } = require("./auth");
const { log } = require("../wg-core");
const { refreshConfigCache } = require("../config-cache");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function serializeSettings(settings) {
    return {
        routerMonthlyPrice: settings.routerMonthlyPrice,
        trialDays: settings.trialDays,
        serverEndpoint: settings.serverEndpoint || '',
        proxyPortRangeStart: settings.proxyPortRangeStart,
        proxyPortRangeEnd: settings.proxyPortRangeEnd,
        emailSenderName: settings.emailSenderName || '',
        emailSenderEmail: settings.emailSenderEmail || '',
        emailReplyToEmail: settings.emailReplyToEmail || '',
        mikrotikSystemUsername: settings.mikrotikSystemUsername || '',
        // Never echo real secrets back to the browser - just whether one is set.
        mikrotikSystemPasswordSet: !!settings.mikrotikSystemPassword,
        paystackPublicKey: settings.paystackPublicKey || '',
        paystackSecretKeySet: !!settings.paystackSecretKey,
        paystackEnabled: !!settings.paystackEnabled,
        updatedAt: settings.updatedAt
    };
}

function registerAdminSettingsRoutes(app, getDbInitialized) {
    app.get("/api/admin/settings", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const settings = await Settings.getSingleton();
            res.json({ success: true, settings: serializeSettings(settings) });
        } catch (error) {
            log('error', 'admin_get_settings_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to load settings", details: error.message });
        }
    });

    app.patch("/api/admin/settings", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const {
                routerMonthlyPrice,
                trialDays,
                serverEndpoint,
                proxyPortRangeStart,
                proxyPortRangeEnd,
                emailSenderName,
                emailSenderEmail,
                emailReplyToEmail,
                mikrotikSystemUsername,
                mikrotikSystemPassword,
                paystackPublicKey,
                paystackSecretKey,
                paystackEnabled
            } = req.body;

            if (routerMonthlyPrice !== undefined && (Number.isNaN(Number(routerMonthlyPrice)) || Number(routerMonthlyPrice) < 0)) {
                return res.status(400).json({ success: false, error: "routerMonthlyPrice must be a non-negative number" });
            }
            if (trialDays !== undefined && (Number.isNaN(Number(trialDays)) || Number(trialDays) < 0)) {
                return res.status(400).json({ success: false, error: "trialDays must be a non-negative number" });
            }
            if (serverEndpoint !== undefined && serverEndpoint !== '' && !/^[^\s:]+:\d{1,5}$/.test(serverEndpoint)) {
                return res.status(400).json({ success: false, error: "serverEndpoint must be in host:port format" });
            }
            // Proxy port range: kept to 4-digit ports (1024-9999), and split
            // into three equal thirds (winbox/ssh/api) by port-allocator.js -
            // both bounds must be provided together so that split is always
            // well-defined, and must actually leave room to allocate from.
            const rangeStartProvided = proxyPortRangeStart !== undefined;
            const rangeEndProvided = proxyPortRangeEnd !== undefined;
            if (rangeStartProvided !== rangeEndProvided) {
                return res.status(400).json({ success: false, error: "proxyPortRangeStart and proxyPortRangeEnd must be set together" });
            }
            if (rangeStartProvided) {
                const start = Number(proxyPortRangeStart);
                const end = Number(proxyPortRangeEnd);
                if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 9999) {
                    return res.status(400).json({ success: false, error: "proxy port range must use 4-digit ports between 1024 and 9999" });
                }
                if (end - start + 1 < 30) {
                    return res.status(400).json({ success: false, error: "proxy port range must span at least 30 ports (10 per winbox/ssh/api)" });
                }
            }
            if (emailSenderEmail !== undefined && emailSenderEmail !== '' && !EMAIL_RE.test(emailSenderEmail)) {
                return res.status(400).json({ success: false, error: "emailSenderEmail must be a valid email address" });
            }
            if (emailReplyToEmail !== undefined && emailReplyToEmail !== '' && !EMAIL_RE.test(emailReplyToEmail)) {
                return res.status(400).json({ success: false, error: "emailReplyToEmail must be a valid email address" });
            }
            if (paystackPublicKey !== undefined && paystackPublicKey !== '' && !paystackPublicKey.startsWith('pk_')) {
                return res.status(400).json({ success: false, error: "paystackPublicKey should start with pk_" });
            }
            if (paystackSecretKey && !paystackSecretKey.startsWith('sk_')) {
                return res.status(400).json({ success: false, error: "paystackSecretKey should start with sk_" });
            }

            const settings = await Settings.getSingleton();
            if (routerMonthlyPrice !== undefined) settings.routerMonthlyPrice = Number(routerMonthlyPrice);
            if (trialDays !== undefined) settings.trialDays = Number(trialDays);
            if (serverEndpoint !== undefined) settings.serverEndpoint = serverEndpoint;
            if (rangeStartProvided) {
                settings.proxyPortRangeStart = Number(proxyPortRangeStart);
                settings.proxyPortRangeEnd = Number(proxyPortRangeEnd);
            }
            if (emailSenderName !== undefined) settings.emailSenderName = emailSenderName;
            if (emailSenderEmail !== undefined) settings.emailSenderEmail = emailSenderEmail;
            if (emailReplyToEmail !== undefined) settings.emailReplyToEmail = emailReplyToEmail;
            if (mikrotikSystemUsername !== undefined) settings.mikrotikSystemUsername = mikrotikSystemUsername;
            if (paystackPublicKey !== undefined) settings.paystackPublicKey = paystackPublicKey;
            if (paystackEnabled !== undefined) settings.paystackEnabled = !!paystackEnabled;
            // Secrets: only overwrite if a real new value was submitted - an
            // empty/absent field means "leave unchanged", since the frontend
            // never has the real value to round-trip back to us.
            if (mikrotikSystemPassword) settings.mikrotikSystemPassword = mikrotikSystemPassword;
            if (paystackSecretKey) settings.paystackSecretKey = paystackSecretKey;
            settings.updatedBy = req.user.userId;
            await settings.save();

            // Live-apply: getServerEndpoint()/email sender/PayStack getters read
            // this cache, not the DB, so changes take effect without a restart.
            await refreshConfigCache();

            log('info', 'admin_settings_updated', {
                by: req.user.email,
                routerMonthlyPrice: settings.routerMonthlyPrice,
                trialDays: settings.trialDays,
                serverEndpoint: settings.serverEndpoint,
                paystackEnabled: settings.paystackEnabled
            });

            res.json({
                success: true,
                message: "Settings updated successfully",
                settings: serializeSettings(settings)
            });
        } catch (error) {
            log('error', 'admin_update_settings_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to update settings", details: error.message });
        }
    });

    // Read-only operational status for the Settings page
    app.get("/api/admin/system-status", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const mongoose = require("mongoose");
            const wgEnabled = !["0", "false", "no", "off"].includes(String(process.env.WG_ENABLED || "true").toLowerCase());

            res.json({
                success: true,
                status: {
                    dbConnected: mongoose.connection.readyState === 1,
                    wgEnabled,
                    nodeEnv: process.env.NODE_ENV || 'development',
                    uptimeSeconds: Math.floor(process.uptime()),
                    serverTime: new Date().toISOString()
                }
            });
        } catch (error) {
            log('error', 'admin_system_status_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to load system status", details: error.message });
        }
    });
}

module.exports = registerAdminSettingsRoutes;
