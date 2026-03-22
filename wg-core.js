const { exec, execFile } = require("child_process");

// Async mutex to serialize all wg operations and avoid races between
// background jobs and API handlers.
class WgMutex {
    constructor() {
        this._queue = Promise.resolve();
    }
    run(fn) {
        const task = this._queue.then(() => fn());
        // Ensure queue is not broken on rejection
        this._queue = task.catch(() => {});
        return task;
    }
}

const wgLock = new WgMutex();
let wgRuntimeAvailable = true;
let wgRuntimeDisableLogged = false;
const WIREGUARD_INTERFACE = String(process.env.WIREGUARD_INTERFACE || 'wg0').trim() || 'wg0';

// Structured JSON logger used across the service
function log(level, msg, data = {}) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        msg,
        ...data
    };
    console[level === "error" ? "error" : "log"](JSON.stringify(entry));
}

function isWgPermissionDeniedError(error) {
    const message = String(error?.message || error || '');
    return /operation not permitted|permission denied/i.test(message);
}

function isWgUnavailableError(error) {
    return Boolean(error && (error.code === 'EWGDISABLED' || isWgPermissionDeniedError(error)));
}

function disableWgRuntime(reason) {
    wgRuntimeAvailable = false;
    if (!wgRuntimeDisableLogged) {
        wgRuntimeDisableLogged = true;
        log('warn', 'wg_runtime_disabled', { reason });
    }
}

function isWgRuntimeAvailable() {
    return wgRuntimeAvailable;
}

// Shared timing / behaviour constants
const KEEPALIVE_TIME = 25;           // seconds
const STARTING_CLIENT_IP = 6;        // start at 10.0.0.6
const STATS_UPDATE_INTERVAL = 30000; // ms
const CLEANUP_INTERVAL = 300000;     // ms
const RECONCILE_INTERVAL = 120000;   // ms

// Validate and normalize persistent keepalive value
function validateKeepalive(value) {
    const keepalive = parseInt(value);
    if (isNaN(keepalive) || keepalive < 0 || keepalive > 65535) {
        return KEEPALIVE_TIME;
    }
    return keepalive;
}

// Strip CIDR suffix (e.g. 10.0.0.6/32 -> 10.0.0.6)
function stripCidr(ip) {
    if (typeof ip === "string" && ip.includes("/")) {
        return ip.split("/")[0];
    }
    return ip;
}

// WireGuard keys are exactly 44 chars of base64 (43 chars + trailing '=')
function isValidWgKey(key) {
    return typeof key === "string" && /^[A-Za-z0-9+/]{43}=$/.test(key);
}

function isValidCidr(ip) {
    return typeof ip === "string" && /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(ip);
}

// Execute generic shell command with timeout and structured errors
function runCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                const err = new Error(stderr.trim() || error.message);
                err.code = error.code;
                log("error", "cmd_exec_error", { error: err.message });
                return reject(err);
            }
            resolve(stdout);
        });
    });
}

// Direct binary execution for wg commands (no shell)
function runWgCommand(args) {
    return new Promise((resolve, reject) => {
        if (!wgRuntimeAvailable) {
            const err = new Error('WireGuard runtime is unavailable');
            err.code = 'EWGDISABLED';
            return reject(err);
        }
        execFile("wg", args, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                const err = new Error(stderr.trim() || error.message);
                err.code = error.code;
                if (isWgPermissionDeniedError(err)) {
                    disableWgRuntime(err.message);
                }
                log("error", "wg_cmd_error", { subcommand: args[0], error: err.message });
                return reject(err);
            }
            resolve(stdout);
        });
    });
}

// Wait for WireGuard interface with exponential backoff
async function waitForWireGuard(maxRetries = 10) {
    for (let i = 0; i < maxRetries; i++) {
        if (!wgRuntimeAvailable) {
            return false;
        }
        try {
            await runWgCommand(["show", WIREGUARD_INTERFACE]);
            return true;
        } catch (e) {
            if (isWgUnavailableError(e)) {
                return false;
            }
            const delay = Math.min(2000 * (i + 1), 15000);
            log("info", "wg_wait_retry", { attempt: i + 1, maxRetries, delayMs: delay });
            await new Promise(r => setTimeout(r, delay));
        }
    }
    return false;
}

// Cache for server public key (never changes during container lifetime)
let cachedServerPublicKey = null;

async function getServerPublicKey() {
    if (cachedServerPublicKey) return cachedServerPublicKey;
    if (!wgRuntimeAvailable) return "REPLACE_WITH_SERVER_PUBLIC_KEY";

    // Method 1: wg show wg0 public-key
    try {
        const key = (await wgLock.run(() => runWgCommand(["show", WIREGUARD_INTERFACE, "public-key"]))).trim();
        if (isValidWgKey(key)) {
            cachedServerPublicKey = key;
            log("info", "server_pubkey_cached", { method: "public-key", key: key.substring(0, 8) + "..." });
            return cachedServerPublicKey;
        }
        log("warn", "server_pubkey_invalid", { raw: key, method: "public-key" });
    } catch (error) {
        if (isWgUnavailableError(error)) {
            return "REPLACE_WITH_SERVER_PUBLIC_KEY";
        }
        log("warn", "server_pubkey_cmd_failed", { method: "public-key", error: error.message });
    }

    // Method 2: wg show wg0 dump (first line, second field)
    try {
        const dump = (await wgLock.run(() => runWgCommand(["show", WIREGUARD_INTERFACE, "dump"]))).trim();
        const firstLine = dump.split("\n")[0];
        if (firstLine) {
            const fields = firstLine.split("\t");
            const key = (fields[1] || "").trim();
            if (isValidWgKey(key)) {
                cachedServerPublicKey = key;
                log("info", "server_pubkey_cached", { method: "dump", key: key.substring(0, 8) + "..." });
                return cachedServerPublicKey;
            }
            log("warn", "server_pubkey_invalid", { raw: key, method: "dump", fieldCount: fields.length });
        }
    } catch (error) {
        if (isWgUnavailableError(error)) {
            return "REPLACE_WITH_SERVER_PUBLIC_KEY";
        }
        log("warn", "server_pubkey_cmd_failed", { method: "dump", error: error.message });
    }

    log("error", "server_pubkey_unavailable", { note: "all methods exhausted" });
    return "REPLACE_WITH_SERVER_PUBLIC_KEY";
}

function getServerEndpoint() {
    return process.env.SERVER_ENDPOINT || "YOUR_SERVER_IP:51820";
}

module.exports = {
    // primitives
    WgMutex,
    wgLock,
    log,

    // constants
    KEEPALIVE_TIME,
    WIREGUARD_INTERFACE,
    STARTING_CLIENT_IP,
    STATS_UPDATE_INTERVAL,
    CLEANUP_INTERVAL,
    RECONCILE_INTERVAL,

    // helpers
    validateKeepalive,
    stripCidr,
    isValidWgKey,
    isValidCidr,
    runCommand,
    runWgCommand,
    waitForWireGuard,
    getServerPublicKey,
    getServerEndpoint,
    isWgPermissionDeniedError,
    isWgUnavailableError,
    isWgRuntimeAvailable,
    disableWgRuntime
};
