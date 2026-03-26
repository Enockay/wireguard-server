#!/usr/bin/env node
require('dotenv').config();

const mongoose = require('mongoose');
const {
    discoverDownstreamMikrotiks,
    discoverDownstreamMikrotiksForEligibleRouters
} = require('../services/downstream-mikrotik-discovery-service');

function parseArgs(argv) {
    const args = {
        routerId: null,
        all: false,
        dryRun: false,
        verbose: false,
        previewTargets: false,
        maxProbeTargets: undefined,
        timeoutMs: undefined,
        allowedSubnetCidrs: [],
        excludeCidrs: []
    };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--router' && argv[index + 1]) {
            args.routerId = argv[index + 1];
            index += 1;
        } else if (token === '--all') {
            args.all = true;
        } else if (token === '--dry-run') {
            args.dryRun = true;
        } else if (token === '--verbose') {
            args.verbose = true;
        } else if (token === '--preview-targets') {
            args.previewTargets = true;
        } else if (token === '--max-probe-targets' && argv[index + 1]) {
            args.maxProbeTargets = Number(argv[index + 1]);
            index += 1;
        } else if (token === '--timeout-ms' && argv[index + 1]) {
            args.timeoutMs = Number(argv[index + 1]);
            index += 1;
        } else if (token === '--allowed-subnet' && argv[index + 1]) {
            args.allowedSubnetCidrs.push(String(argv[index + 1]).trim());
            index += 1;
        } else if (token === '--exclude-subnet' && argv[index + 1]) {
            args.excludeCidrs.push(String(argv[index + 1]).trim());
            index += 1;
        }
    }

    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI is required');
    }
    if (!args.routerId && !args.all) {
        throw new Error('Provide --router <routerId> or --all');
    }

    await mongoose.connect(process.env.MONGO_URI);

    const options = {
        dryRun: args.dryRun,
        maxProbeTargets: args.maxProbeTargets,
        timeoutMs: args.timeoutMs,
        allowedSubnetCidrs: args.allowedSubnetCidrs,
        excludeCidrs: args.excludeCidrs
    };

    let result;
    if (args.all) {
        result = await discoverDownstreamMikrotiksForEligibleRouters(options, {
            actor: 'cli',
            actorType: 'worker'
        });
    } else {
        result = await discoverDownstreamMikrotiks(args.routerId, options, {
            actor: 'cli',
            actorType: 'worker'
        });
    }

    if (args.previewTargets) {
        const payload = Array.isArray(result)
            ? result.map((item) => ({
                routerId: item.routerId,
                success: item.success,
                previewTargets: item.result?.previewTargets || []
            }))
            : {
                routerId: result.parentRouterId,
                previewTargets: result.previewTargets || []
            };
        console.log(JSON.stringify(payload, null, args.verbose ? 2 : 0));
        await mongoose.disconnect();
        return;
    }

    console.log(JSON.stringify(result, null, args.verbose ? 2 : 0));
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error(error.message || String(error));
    try {
        await mongoose.disconnect();
    } catch {}
    process.exit(1);
});
