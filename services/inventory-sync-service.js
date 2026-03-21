const crypto = require('crypto');
const RouterInventory = require('../models/RouterInventory');
const MikrotikRouter = require('../models/MikrotikRouter');

function hashValue(value) {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function normalizeInventoryRecord(domain, record = {}) {
    const routerosId = record['.id'] || null;
    const itemKey = String(
        record.name ||
        record.address ||
        record['dst-address'] ||
        record.user ||
        record.interface ||
        routerosId ||
        hashValue(record)
    );

    return {
        domain,
        itemKey,
        routerosId,
        normalized: { ...record },
        raw: record,
        hash: hashValue(record)
    };
}

async function storeInventoryDomain(routerId, domain, records = []) {
    const syncedAt = new Date();
    const normalized = records.map((record) => normalizeInventoryRecord(domain, record));

    await Promise.all(normalized.map((item) => RouterInventory.updateOne(
        { routerId, domain, itemKey: item.itemKey },
        { $set: { ...item, routerId, syncedAt } },
        { upsert: true }
    )));

    return normalized;
}

async function finalizeInventorySync(routerId, summary) {
    const payloadHash = hashValue(summary);
    await MikrotikRouter.findByIdAndUpdate(routerId, {
        'inventorySnapshotMeta.lastInventorySyncAt': new Date(),
        'inventorySnapshotMeta.lastInventoryHash': payloadHash
    }).catch(() => undefined);
    return payloadHash;
}

module.exports = {
    normalizeInventoryRecord,
    storeInventoryDomain,
    finalizeInventorySync
};
