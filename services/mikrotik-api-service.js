const net = require('net');
const { exec } = require('child_process');
const { promisify } = require('util');
const { log } = require('../wg-core');

const execAsync = promisify(exec);

/**
 * MikroTik RouterOS API Client
 * Connects to MikroTik routers via their VPN IP to retrieve routerboard information
 * Uses SSH to execute RouterOS commands and get uptime/resources
 */

/**
 * Execute a RouterOS command via SSH
 * Uses ssh command-line tool to connect and execute commands
 */
async function executeRouterOSCommand(vpnIp, command, username = 'admin', password = '', timeout = 5000) {
    try {
        // Check if ssh command is available
        try {
            await execAsync('which ssh', { timeout: 1000 });
        } catch (err) {
            log('error', 'ssh_command_not_found', { vpnIp, error: 'ssh command not available in container' });
            return {
                success: false,
                error: 'SSH client not available. Please install openssh-client in the container.',
                code: 'ENOENT',
                vpnIp,
                command
            };
        }

        // Use sshpass if password is provided, otherwise use SSH keys
        // For security, we'll use SSH keys in production, but support password for now
        let sshCommand;
        
        if (password) {
            // Check if sshpass is available
            try {
                await execAsync('which sshpass', { timeout: 1000 });
            } catch (err) {
                log('warn', 'sshpass_not_found', { vpnIp, message: 'sshpass not available, trying key-based auth' });
                password = ''; // Fall back to key-based auth
            }
        }
        
        if (password) {
            // Use sshpass (requires sshpass to be installed)
            // Format: sshpass -p 'password' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 user@host command
            sshCommand = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o UserKnownHostsFile=/dev/null -o PasswordAuthentication=yes ${username}@${vpnIp} "${command}"`;
        } else {
            // Use SSH without password (key-based auth or interactive)
            // Note: This will fail if no keys are set up and password auth is disabled
            sshCommand = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o UserKnownHostsFile=/dev/null -o PasswordAuthentication=no -o BatchMode=yes ${username}@${vpnIp} "${command}"`;
        }

        log('info', 'executing_routeros_command', { vpnIp, command: command.substring(0, 50), method: password ? 'password' : 'key' });

        const { stdout, stderr } = await execAsync(sshCommand, {
            timeout,
            maxBuffer: 1024 * 1024 // 1MB buffer
        });

        if (stderr && !stderr.includes('Warning: Permanently added') && !stderr.includes('Host key verification failed')) {
            log('warn', 'routeros_command_stderr', { vpnIp, stderr: stderr.substring(0, 100) });
        }

        return {
            success: true,
            output: stdout.trim(),
            error: stderr || null,
            vpnIp,
            command
        };
    } catch (error) {
        // Check if it's an authentication error
        const isAuthError = error.message.includes('Permission denied') || 
                           error.message.includes('Authentication failed') ||
                           error.message.includes('Host key verification failed') ||
                           error.message.includes('Permission denied (publickey');
        
        log('error', 'routeros_command_error', { 
            vpnIp, 
            command: command.substring(0, 50),
            error: error.message,
            code: error.code,
            isAuthError
        });
        
        return {
            success: false,
            error: error.message,
            code: error.code,
            isAuthError,
            vpnIp,
            command
        };
    }
}

/**
 * Get routerboard information using SSH
 * Retrieves uptime, resources, and other system information
 */
async function getRouterboardInfoSSH(vpnIp, username = null, password = null) {
    // Use system user credentials from environment variables
    if (!username) {
        username = process.env.MIKROTIK_SYSTEM_USERNAME || 'wgmonitor';
    }
    if (!password) {
        password = process.env.MIKROTIK_SYSTEM_PASSWORD || '';
    }
    try {
        // Get system resource information
        const resourceCommand = '/system resource print';
        const resourceResult = await executeRouterOSCommand(vpnIp, resourceCommand, username, password);
        
        if (!resourceResult.success) {
            // If SSH fails due to missing command or auth, fall back to API port check
            if (resourceResult.code === 'ENOENT' || resourceResult.isAuthError) {
                log('info', 'ssh_fallback_to_api_port', { vpnIp, reason: resourceResult.code === 'ENOENT' ? 'ssh_not_found' : 'auth_failed' });
                return await checkAPIPortOpen(vpnIp);
            }
            // For other errors, still try API port check as fallback
            log('warn', 'ssh_command_failed_fallback', { vpnIp, error: resourceResult.error });
            return await checkAPIPortOpen(vpnIp);
        }

        // Get routerboard information
        const routerboardCommand = '/system routerboard print';
        const routerboardResult = await executeRouterOSCommand(vpnIp, routerboardCommand, username, password);

        // Parse resource output (RouterOS format)
        const resourceInfo = parseRouterOSOutput(resourceResult.output);
        const routerboardInfo = routerboardResult.success ? parseRouterOSOutput(routerboardResult.output) : {};

        return {
            success: true,
            vpnIp,
            reachable: true,
            method: 'ssh',
            uptime: resourceInfo.uptime || resourceInfo['uptime'] || null,
            cpuLoad: resourceInfo['cpu-load'] || resourceInfo.cpuLoad || null,
            memoryUsage: resourceInfo['used-memory'] || resourceInfo.usedMemory || null,
            totalMemory: resourceInfo['total-memory'] || resourceInfo.totalMemory || null,
            freeMemory: resourceInfo['free-memory'] || resourceInfo.freeMemory || null,
            boardName: routerboardInfo['board-name'] || routerboardInfo.boardName || null,
            model: routerboardInfo.model || null,
            serialNumber: routerboardInfo['serial-number'] || routerboardInfo.serialNumber || null,
            firmware: routerboardInfo['current-firmware'] || routerboardInfo.currentFirmware || null,
            resources: resourceInfo,
            routerboard: routerboardInfo,
            timestamp: new Date()
        };
    } catch (error) {
        log('error', 'get_routerboard_info_ssh_error', { 
            vpnIp, 
            error: error.message 
        });
        
        // Fallback to API port check
        return await checkAPIPortOpen(vpnIp);
    }
}

/**
 * Parse RouterOS command output
 * RouterOS outputs key-value pairs, e.g., "uptime: 5d 3h 2m 15s"
 */
function parseRouterOSOutput(output) {
    const result = {};
    
    if (!output) return result;

    // Split by lines and parse key: value pairs
    output.split('\n').forEach(line => {
        const match = line.match(/^\s*([^:]+):\s*(.+)$/);
        if (match) {
            const key = match[1].trim().replace(/\s+/g, '-').toLowerCase();
            const value = match[2].trim();
            result[key] = value;
            // Also store with original key format
            result[match[1].trim()] = value;
        }
    });

    return result;
}

/**
 * Check if MikroTik API port (8728) is open
 * Fallback method when SSH is not available
 */
function checkAPIPortOpen(vpnIp, timeout = 3000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeout);

        socket.on('connect', () => {
            log('info', 'mikrotik_api_port_open', { vpnIp });
            socket.destroy();
            resolve({ 
                success: true,
                reachable: true, 
                method: 'api_port_check',
                apiPortOpen: true,
                vpnIp,
                timestamp: new Date()
            });
        });

        socket.on('error', (err) => {
            if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH') {
                resolve({ 
                    success: false,
                    reachable: false, 
                    error: err.code,
                    apiPortOpen: false,
                    vpnIp,
                    timestamp: new Date()
                });
            } else {
                resolve({ 
                    success: false,
                    reachable: false, 
                    error: err.message,
                    code: err.code,
                    apiPortOpen: false,
                    vpnIp,
                    timestamp: new Date()
                });
            }
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve({ 
                success: false,
                reachable: false, 
                error: 'timeout',
                apiPortOpen: false,
                vpnIp,
                timestamp: new Date()
            });
        });

        socket.connect(8728, vpnIp);
    });
}

/**
 * Get routerboard uptime and resources
 * This is the main function that checks if a router is active
 */
async function getRouterboardInfo(vpnIp, options = {}) {
    const {
        username = 'admin',
        password = '',
        timeout = 5000,
        method = 'ssh' // 'ssh', 'api_port'
    } = options;

    try {
        log('info', 'checking_routerboard_info', { vpnIp, method });

        // Method 1: Use SSH to get detailed info (preferred)
        if (method === 'ssh' || !method) {
            const result = await getRouterboardInfoSSH(vpnIp, username, password);
            return result;
        }

        // Method 2: Check if API port is open (fallback)
        if (method === 'api_port') {
            return await checkAPIPortOpen(vpnIp, timeout);
        }

    } catch (error) {
        log('error', 'get_routerboard_info_error', { 
            vpnIp, 
            error: error.message,
            code: error.code
        });
        
        // Fallback to API port check
        return await checkAPIPortOpen(vpnIp, timeout);
    }
}

/**
 * Check if router is active by connecting to it and getting routerboard info
 */
async function checkRouterActive(vpnIp, options = {}) {
    try {
        const info = await getRouterboardInfo(vpnIp, options);
        
        return {
            isActive: info.success && info.reachable,
            info: info,
            checkedAt: new Date()
        };
    } catch (error) {
        log('error', 'check_router_active_error', { 
            vpnIp, 
            error: error.message 
        });
        
        return {
            isActive: false,
            error: error.message,
            checkedAt: new Date()
        };
    }
}

module.exports = {
    getRouterboardInfo,
    checkRouterActive,
    getRouterboardInfoSSH,
    executeRouterOSCommand,
    checkAPIPortOpen
};
