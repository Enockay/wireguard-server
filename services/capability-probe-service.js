function capabilityBoolean(records) {
    return Array.isArray(records);
}

async function probeCapabilities(executor, routerId) {
    const probe = async (operationName, command, attributes = {}) => {
        try {
            const result = await executor(routerId, operationName, { command, attributes });
            return { ok: true, data: result.data || result.records || result || [] };
        } catch (error) {
            return { ok: false, error };
        }
    };

    const [system, identity, interfaces, queues, hotspot, pppoe, firewall, routes, wireguard, logs] = await Promise.all([
        probe('get_system_resource', '/system/resource/print'),
        probe('get_system_resource', '/system/identity/print'),
        probe('get_interfaces', '/interface/print'),
        probe('get_system_resource', '/queue/simple/print'),
        probe('get_system_resource', '/ip/hotspot/user/print'),
        probe('get_system_resource', '/ppp/secret/print'),
        probe('get_system_resource', '/ip/firewall/filter/print'),
        probe('get_system_resource', '/ip/route/print'),
        probe('get_system_resource', '/interface/wireguard/print'),
        probe('get_logs', '/log/print', { '.proplist': 'time,topics,message' })
    ]);

    return {
        probedAt: new Date(),
        authMethod: system.ok ? (system.transport || null) : null,
        principal: null,
        systemRead: system.ok,
        identityRead: identity.ok,
        interfacesRead: interfaces.ok,
        queuesRead: queues.ok,
        hotspotRead: hotspot.ok,
        pppoeRead: pppoe.ok,
        firewallRead: firewall.ok,
        routesRead: routes.ok,
        wireguardRead: wireguard.ok,
        logsRead: logs.ok,
        queueWrite: queues.ok,
        hotspotWrite: hotspot.ok,
        pppoeWrite: pppoe.ok,
        firewallWrite: firewall.ok,
        routesWrite: routes.ok,
        interfaceWrite: interfaces.ok,
        wireguardWrite: wireguard.ok,
        reboot: system.ok,
        rawRead: true,
        rawWrite: false
    };
}

module.exports = {
    probeCapabilities
};
