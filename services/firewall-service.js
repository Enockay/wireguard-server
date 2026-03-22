const { executeCommand } = require('./routeros-command-service');

function mapToRouterOs(attributes = {}) {
    const mapped = {};
    const fieldMap = {
        srcAddress: 'src-address',
        dstAddress: 'dst-address',
        dstPort: 'dst-port',
        inInterface: 'in-interface',
        toAddresses: 'to-addresses',
        toPorts: 'to-ports'
    };

    for (const [key, value] of Object.entries(attributes)) {
        if (value == null || value === '') continue;
        const routerOsKey = fieldMap[key] || key;
        mapped[routerOsKey] = value;
    }

    return mapped;
}

function parseDisabled(value) {
    return ['true', 'yes'].includes(String(value || '').toLowerCase());
}

function normalizeFilterRule(record = {}) {
    return {
        id: record['.id'] || '',
        routerosId: record['.id'] || '',
        chain: record.chain || '',
        action: record.action || '',
        protocol: record.protocol || '',
        srcAddress: record['src-address'] || '',
        dstAddress: record['dst-address'] || '',
        dstPort: record['dst-port'] || '',
        inInterface: record['in-interface'] || '',
        comment: record.comment || '',
        disabled: parseDisabled(record.disabled)
    };
}

function normalizeNatRule(record = {}) {
    return {
        id: record['.id'] || '',
        routerosId: record['.id'] || '',
        chain: record.chain || '',
        action: record.action || '',
        protocol: record.protocol || '',
        dstPort: record['dst-port'] || '',
        toAddresses: record['to-addresses'] || '',
        toPorts: record['to-ports'] || '',
        comment: record.comment || '',
        disabled: parseDisabled(record.disabled)
    };
}

function normalizeAddressListEntry(record = {}) {
    return {
        id: record['.id'] || '',
        routerosId: record['.id'] || '',
        list: record.list || '',
        address: record.address || '',
        comment: record.comment || '',
        creationTime: record.creationTime || record['creation-time'] || null
    };
}

async function listFilterRules(routerId, chain = '') {
    const attrs = chain ? { '?chain': chain } : {};
    const records = await executeCommand(routerId, '/ip/firewall/filter/print', attrs, {
        operationName: 'get_system_resource',
        scope: 'firewall'
    });
    return (records || []).map(normalizeFilterRule);
}

async function addFilterRule(routerId, ruleData) {
    const mapped = mapToRouterOs(ruleData);
    await executeCommand(routerId, '/ip/firewall/filter/add', mapped, {
        operationName: 'firewall_mutation',
        scope: 'firewall'
    });
    return { message: 'Filter rule added' };
}

async function updateFilterRule(routerId, routerosId, updates) {
    const mapped = mapToRouterOs(updates);
    await executeCommand(routerId, '/ip/firewall/filter/set', { '.id': routerosId, ...mapped }, {
        operationName: 'firewall_mutation',
        scope: 'firewall'
    });
    return { message: 'Filter rule updated' };
}

async function deleteFilterRule(routerId, routerosId) {
    await executeCommand(routerId, '/ip/firewall/filter/remove', { '.id': routerosId }, {
        operationName: 'firewall_mutation',
        scope: 'firewall'
    });
    return { message: 'Filter rule removed' };
}

async function toggleFilterRule(routerId, routerosId, disabled) {
    await executeCommand(routerId, '/ip/firewall/filter/set', { '.id': routerosId, disabled: disabled ? 'yes' : 'no' }, {
        operationName: 'firewall_mutation',
        scope: 'firewall'
    });
    return { message: disabled ? 'Filter rule disabled' : 'Filter rule enabled' };
}

async function listNatRules(routerId) {
    const records = await executeCommand(routerId, '/ip/firewall/nat/print', {}, {
        operationName: 'get_system_resource',
        scope: 'firewall'
    });
    return (records || []).map(normalizeNatRule);
}

async function addNatRule(routerId, ruleData) {
    const mapped = mapToRouterOs(ruleData);
    await executeCommand(routerId, '/ip/firewall/nat/add', mapped, {
        operationName: 'firewall_mutation',
        scope: 'firewall'
    });
    return { message: 'NAT rule added' };
}

async function deleteNatRule(routerId, routerosId) {
    await executeCommand(routerId, '/ip/firewall/nat/remove', { '.id': routerosId }, {
        operationName: 'firewall_mutation',
        scope: 'firewall'
    });
    return { message: 'NAT rule removed' };
}

async function listAddressLists(routerId, listName = '') {
    const attrs = listName ? { '?list': listName } : {};
    const records = await executeCommand(routerId, '/ip/firewall/address-list/print', attrs, {
        operationName: 'get_system_resource',
        scope: 'firewall'
    });
    return (records || []).map(normalizeAddressListEntry);
}

async function addToAddressList(routerId, payload) {
    const mapped = mapToRouterOs(payload);
    await executeCommand(routerId, '/ip/firewall/address-list/add', mapped, {
        operationName: 'firewall_mutation',
        scope: 'firewall'
    });
    return { message: 'Address list entry added' };
}

async function removeFromAddressList(routerId, routerosId) {
    await executeCommand(routerId, '/ip/firewall/address-list/remove', { '.id': routerosId }, {
        operationName: 'firewall_mutation',
        scope: 'firewall'
    });
    return { message: 'Address list entry removed' };
}

async function blockSubscriber(routerId, ipAddress, reason = '') {
    const comment = `blocked: ${reason || 'billing_enforcement'}`;
    await addToAddressList(routerId, { list: 'blocked', address: ipAddress, comment });
    return { message: 'Subscriber blocked' };
}

async function unblockSubscriber(routerId, ipAddress) {
    const entries = await listAddressLists(routerId, 'blocked');
    const matches = entries.filter((entry) => entry.address === ipAddress);
    await Promise.all(matches.map((entry) => removeFromAddressList(routerId, entry.routerosId)));
    return { message: 'Subscriber unblocked', removed: matches.length };
}

module.exports = {
    listFilterRules,
    addFilterRule,
    updateFilterRule,
    deleteFilterRule,
    toggleFilterRule,
    listNatRules,
    addNatRule,
    deleteNatRule,
    listAddressLists,
    addToAddressList,
    removeFromAddressList,
    blockSubscriber,
    unblockSubscriber
};
