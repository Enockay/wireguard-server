function normalizeIpv4Route(value, fallbackMask = 32) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const cidrMatch = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
    if (cidrMatch) {
        const mask = Number(cidrMatch[2]);
        if (mask >= 0 && mask <= 32) {
            return `${cidrMatch[1]}/${mask}`;
        }
        return null;
    }

    const ipMatch = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (ipMatch) {
        return `${ipMatch[1]}/${fallbackMask}`;
    }

    return null;
}

function toArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function buildClientPeerAllowedIps(client, routers = []) {
    const collected = new Set();
    const clientRoute = normalizeIpv4Route(client?.ip, 32);
    if (clientRoute) {
        collected.add(clientRoute);
    }

    for (const router of toArray(routers)) {
        const preferredSubnet = normalizeIpv4Route(router?.remoteBootstrap?.preferredManagementSubnet, 32);
        if (preferredSubnet) {
            collected.add(preferredSubnet);
        }

        const discoveryAddress = normalizeIpv4Route(router?.discoveryInfo?.localAddress, 32);
        if (discoveryAddress) {
            collected.add(discoveryAddress);
        }

        for (const endpoint of toArray(router?.managementEndpoints)) {
            const endpointHost = normalizeIpv4Route(endpoint?.host, 32);
            if (endpointHost) {
                collected.add(endpointHost);
            }
        }
    }

    return [...collected].join(',');
}

function getAdditionalServerPeerRoutes(client, routers = []) {
    const allowedIps = buildClientPeerAllowedIps(client, routers)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    const clientRoute = normalizeIpv4Route(client?.ip, 32);
    return allowedIps.filter((route) => route !== clientRoute);
}

module.exports = {
    buildClientPeerAllowedIps,
    getAdditionalServerPeerRoutes,
    normalizeIpv4Route
};
