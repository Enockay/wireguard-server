# Router Discovery Agent

This project supports discovery-assisted router onboarding in three modes:

1. `Discover on this network`
2. `Bootstrap claim script`
3. `Direct/manual provisioning`

The discovery path can run in two ways:

- `Server-hosted scan`
  The API container scans subnets visible from the backend host.
- `Local discovery agent`
  A small helper runs on the admin's LAN and exposes scan/verify endpoints to the backend.

Use the local discovery agent when the API server is not on the same network as the routers being onboarded.

## What the agent does

The agent provides:

- `POST /scan`
  Scans supplied IPv4 CIDR subnets for likely MikroTik devices by probing:
  - `8291` Winbox
  - `8728` API
  - `8729` API-SSL
  - `22` SSH
  - `80` / `443` WebFig hints
- `POST /verify`
  Uses SSH credentials to verify that a candidate is a reachable MikroTik router and fetch safe metadata.
- `GET /health`
  Basic health response plus locally detected subnets.
- `GET /capabilities`
  Agent feature summary and visible local subnets.

The agent does not persist router credentials.

## Run locally

From [`wireguard-server-main`](/home/digital/Desktop/MIkrotik-admin/wireguard-server-main):

```bash
npm run discovery-agent
```

Default settings:

- `ROUTER_DISCOVERY_AGENT_PORT=8787`
- `ROUTER_DISCOVERY_AGENT_TOKEN` optional bearer token

Example:

```bash
ROUTER_DISCOVERY_AGENT_PORT=8787 \
ROUTER_DISCOVERY_AGENT_TOKEN=replace-me \
npm run discovery-agent
```

## Backend configuration

If you want the main API to use the local helper, set:

```bash
ROUTER_DISCOVERY_AGENT_URL=http://agent-host-or-ip:8787
ROUTER_DISCOVERY_AGENT_TOKEN=replace-me
```

When `ROUTER_DISCOVERY_AGENT_URL` is configured:

- discovery scans are delegated to the agent
- credential verification is delegated to the agent
- import/adoption still happens in the main backend using the normal router provisioning flow

When `ROUTER_DISCOVERY_AGENT_URL` is not configured:

- the API server scans from its own network interfaces
- verification runs from the API host directly

## Recommended deployment pattern

For remote SaaS hosting:

- run the main API in the datacenter/cloud
- run the discovery agent on a workstation, jump host, or small VM inside the customer/admin LAN
- expose the agent only to the backend if possible
- always use `ROUTER_DISCOVERY_AGENT_TOKEN`

For on-prem or same-LAN hosting:

- backend-side scanning may be enough
- the discovery agent is optional

## Validation and safety

- discovery results are stored as short-lived discovery sessions
- verification is time-limited before import
- import blocks duplicate routers where detected
- imported routers still go through the existing `createRouterAdmin()` provisioning path
- credentials are used only for verification and are not stored in discovery sessions

## Operational checks

Health:

```bash
curl http://127.0.0.1:8787/health
```

Capabilities:

```bash
curl http://127.0.0.1:8787/capabilities
```

Authorized scan example:

```bash
curl -X POST http://127.0.0.1:8787/scan \
  -H "Authorization: Bearer replace-me" \
  -H "Content-Type: application/json" \
  -d '{"subnets":["192.168.88.0/24"]}'
```

## Current limitations

- verification currently relies on SSH for authenticated metadata fetch
- vendor detection is best-effort
- subnet scanning is intentionally bounded to avoid runaway scans
- API/Winbox ports are used for fingerprinting/readiness, not yet full authenticated metadata retrieval

## Recommended future work

- add RouterOS API authenticated verification as a second verification path
- add MAC vendor enrichment
- add a dedicated admin discovery queue page for batch adoption
