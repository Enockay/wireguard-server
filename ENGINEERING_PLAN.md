# WireGuard Server -- Post-Deployment Verification Tests

All engineering changes (Phases 1-5) have been implemented. Run these
tests after deployment to confirm handshake failures are resolved.

---

## Test 1: Handshake stability (validates Phase 1)

**What it proves:** The stats job no longer removes peers during active
handshakes, the mutex serializes all `wg` operations, and `syncconf`
preserves handshake state during bulk loads.

**On a MikroTik peer behind NAT:**

```
/interface wireguard peers print
```

Watch the `last-handshake` field. It should update every ~2 minutes
without gaps. Run this for at least 10 minutes.

**Pass criteria:**
- No gaps > 3 minutes between handshake updates.
- No "failed handshake" messages on the MikroTik side.

**Fail criteria:**
- Any gap > 5 minutes indicates the old contention problem persists.
- Multiple consecutive `(none)` values for last-handshake.

---

## Test 2: Peer reconciliation after manual removal (validates Phase 2.1)

**What it proves:** The reconciliation loop detects missing peers and
re-adds them within 120 seconds.

**SSH into the wireguard container:**

```bash
# 1. Note a known peer's public key
wg show wg0 | head -20

# 2. Manually remove that peer
wg set wg0 peer <peer-public-key> remove

# 3. Confirm it's gone
wg show wg0 | grep <first-8-chars-of-key>
# Should return nothing

# 4. Wait up to 120 seconds, then check again
sleep 130
wg show wg0 | grep <first-8-chars-of-key>
# Should show the peer is back
```

**Pass criteria:**
- Peer reappears within 120 seconds.
- Container logs show: `{"msg":"peers_missing",...}` followed by
  `{"msg":"reconcile_complete",...}`.

**Fail criteria:**
- Peer does not reappear after 3 minutes.
- No reconciliation log entries appear.

---

## Test 3: Container restart recovery (validates Phases 1.2, 3.3, 3.4)

**What it proves:** After `wg-quick down/up`, the monitoring loop signals
the API to reload, and even if that fails, the reconciliation loop
catches any missing peers. The 3-failure threshold prevents false
restarts.

```bash
# 1. Note current peer count
wg show wg0 | grep -c "^peer:"

# 2. Restart the wireguard container
docker restart wireguard

# 3. Wait 60-90 seconds for recovery
sleep 90

# 4. Check peers are back
docker exec wireguard wg show wg0 | grep -c "^peer:"
# Should match the count from step 1
```

**On the MikroTik side:**

```
/interface wireguard peers print
```

**Pass criteria:**
- All peers restored within 90 seconds of restart.
- Handshakes resume on MikroTik within ~2 minutes of peers being restored.
- Container logs show `wg_ready` followed by `syncconf_complete`.

**Fail criteria:**
- Peers missing after 3 minutes.
- Handshakes do not resume on MikroTik.

---

## Test 4: Startup race condition (validates Phase 3.4)

**What it proves:** The API waits for WireGuard to be ready before
loading peers, using exponential backoff.

```bash
# 1. Stop everything
docker compose down

# 2. Start fresh
docker compose up -d

# 3. Immediately watch the API container logs
docker logs -f wireguard-api
```

**Pass criteria:**
- Logs show `wg_wait_retry` entries with increasing delays.
- Eventually shows `wg_ready` followed by `syncconf_complete`.
- All enabled peers are loaded on first startup.

**Fail criteria:**
- `db_initialized` appears but no `syncconf_complete` follows.
- Peers are not loaded until the first reconciliation cycle (30s+).

---

## Test 5: Performance under load (validates Phase 4)

**What it proves:** Batched MongoDB writes and `execFile` reduce overhead.
The stats cycle completes quickly even with many peers.

**Requires 50+ peers configured. Measure from inside the container:**

```bash
# Time a single stats cycle
docker exec wireguard-api node -e "
  const start = Date.now();
  require('http').get('http://localhost:5000/api/admin/stats', (r) => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      console.log('Status:', r.statusCode);
      console.log('Time:', Date.now() - start, 'ms');
      const parsed = JSON.parse(d);
      console.log('Peers:', parsed.stats?.wireguard?.connected);
    });
  });
"
```

**Pass criteria:**
- Stats endpoint responds in < 500ms with 50+ peers.
- No timeout errors in container logs during the stats cycle.

**Fail criteria:**
- Response takes > 2 seconds.
- `stats_update_error` entries in logs indicating timeouts.

---

## Test 6: Health endpoint stale peer detection (validates Phase 5.2)

**What it proves:** The `/api/health` endpoint correctly identifies
peers whose last handshake was > 3 minutes ago.

```bash
# 1. With all peers healthy
curl -s http://localhost:5000/api/health | jq '.stalePeers'
# Should return [] (empty array)

# 2. Disconnect a MikroTik peer (disable its WG interface)
# Wait 4 minutes, then check again
curl -s http://localhost:5000/api/health | jq '.stalePeers'
# Should list the disconnected peer with lastHandshakeSec > 180
```

**Pass criteria:**
- Healthy peers: `stalePeers` is an empty array.
- After disconnecting a peer for > 3 minutes: that peer appears in
  `stalePeers` with `lastHandshakeSec` > 180.
- Status code is 200 when DB and WG are both up, 503 otherwise.

**Fail criteria:**
- `stalePeers` always empty even with a disconnected peer.
- `stalePeers` lists active peers with recent handshakes.

---

## Test 7: Input validation (validates Phase 2.2)

**What it proves:** Malformed keys and IPs are rejected before reaching
the WireGuard binary.

```bash
# 1. Try to add a peer with an invalid public key
curl -s -X POST http://localhost:5000/add-peer \
  -H "Content-Type: application/json" \
  -d '{"publicKey": "not-a-valid-key", "allowedIPs": "10.0.0.99/32"}'
# Should return 400 with "Invalid WireGuard public key format"

# 2. Try to add a peer with an invalid CIDR
curl -s -X POST http://localhost:5000/add-peer \
  -H "Content-Type: application/json" \
  -d '{"publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "allowedIPs": "not-an-ip"}'
# Should return 400 with "Invalid CIDR format for allowedIPs"

# 3. Try shell injection via public key (should be blocked by both
#    validation AND execFile, but validation catches it first)
curl -s -X POST http://localhost:5000/add-peer \
  -H "Content-Type: application/json" \
  -d '{"publicKey": "; rm -rf / #AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "allowedIPs": "10.0.0.99/32"}'
# Should return 400
```

**Pass criteria:**
- All three requests return HTTP 400 with descriptive error messages.
- No shell commands are executed.
- Container logs show no `wg_cmd_error` entries for these requests.

**Fail criteria:**
- Any request returns 200 or 500 (means validation was bypassed).
- Container logs show `wg_cmd_error` (means the invalid input reached `wg`).

---

## Test 8: Structured logging (validates Phase 5.1)

**What it proves:** All log output is machine-parsable JSON.

```bash
# Capture 30 seconds of logs
docker logs --since 30s wireguard-api 2>&1 | head -20
```

**Pass criteria:**
- Every line is valid JSON with `ts`, `level`, and `msg` fields.
- No unstructured `console.log` lines (no bare strings, no emoji-prefixed
  messages like `"... Loading clients..."`).

**Fail criteria:**
- Any line that is not valid JSON.
- Lines starting with emoji characters or plain text.

---

## Test 9: Monitoring loop false-positive resistance (validates Phase 3.3)

**What it proves:** A single transient `wg show` failure does not trigger
an unnecessary interface restart.

**SSH into the wireguard container:**

```bash
# Watch the monitoring loop output
docker logs -f wireguard

# Simulate a transient failure by briefly blocking wg (if possible),
# or just watch normal operation and confirm:
# - "WireGuard check failed (1/3)" does NOT trigger a restart
# - Only "WireGuard check failed (3/3)" triggers a restart
```

**Pass criteria:**
- Logs show `(1/3)` and `(2/3)` without a restart following.
- Restart only occurs after `(3/3)`.
- After restart, `curl -s -X POST http://localhost:5000/reload` is
  attempted (visible in logs).

**Fail criteria:**
- A single failure triggers immediate restart.
- No `/reload` curl after restart.

---

## Test 10: Disabled peer cleanup isolation (validates Phase 1.1)

**What it proves:** Disabled peers are cleaned up on a 5-minute interval,
not during the 30-second stats cycle.

```bash
# 1. Create and then disable a client
curl -s -X POST http://localhost:5000/api/clients \
  -H "Content-Type: application/json" \
  -d '{"name": "test-cleanup"}'

curl -s -X POST http://localhost:5000/api/clients/test-cleanup/disable

# 2. Manually re-add the peer to WireGuard to simulate a stuck peer
docker exec wireguard-api node -e "
  const { execFileSync } = require('child_process');
  const Client = require('./models/Client');
  const db = require('./db');
  (async () => {
    await db.connect();
    const c = await Client.findOne({ name: 'test-cleanup' });
    console.log('Re-adding disabled peer:', c.publicKey);
    execFileSync('wg', ['set', 'wg0', 'peer', c.publicKey, 'allowed-ips', c.ip]);
    console.log('Peer re-added to kernel');
    process.exit(0);
  })();
"

# 3. Confirm it's in the kernel
docker exec wireguard wg show wg0 | grep -c "peer:"

# 4. Wait for cleanup (up to 5 minutes)
# Watch logs for "removed_disabled_peer"
docker logs -f wireguard-api 2>&1 | grep -E "removed_disabled|cleanup"

# 5. After cleanup runs, confirm peer is gone
docker exec wireguard wg show wg0 | grep <first-8-chars>
```

**Pass criteria:**
- The disabled peer is NOT removed during a 30-second stats cycle.
- The disabled peer IS removed within 5 minutes by `cleanupDisabledPeers`.
- Logs show `removed_disabled_peer` (not during a stats update).

**Fail criteria:**
- Peer removed within 30 seconds (means stats job is still doing removal).
- Peer never removed (cleanup function not running).

---

## Test 11: Alpine version pinning (validates Phase 3.2)

**Quick sanity check on all three Dockerfiles.**

```bash
grep "^FROM" Dockerfile Dockerfile.api Dockerfile.wireguard
```

**Pass criteria:**
- All three show `FROM alpine:3.20` (not `alpine:latest`).

**Fail criteria:**
- Any Dockerfile uses `alpine:latest`.

---

## Test 12: wg0.conf route removal (validates Phase 3.1)

```bash
cat wg0.conf
```

**Pass criteria:**
- PostUp contains only iptables rules (FORWARD + MASQUERADE).
- No `ip route add` command referencing `10.0.0.4` or any client IP.
- PostDown mirrors PostUp (only iptables -D rules).

**Fail criteria:**
- Any `ip route` command in PostUp or PostDown.

---

## Acceptance threshold

All 12 tests must pass. Tests 1-3 are the critical handshake stability
tests. If any of those fail, the core problem is not resolved. Tests
4-12 validate supporting improvements and can be re-tested after fixes.

Recommended monitoring after all tests pass: watch `/api/health`
`stalePeers` array for 48 hours. It should remain empty for all active
peers. Any peer appearing there for > 5 minutes indicates a regression.
