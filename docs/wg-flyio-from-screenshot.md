# wg-flyio Test Notes

This config was transcribed from screenshots:

- `Screenshot 2026-03-27 113844_114113.png`
- `Screenshot 2026-03-27 113910_114115.png`

Files:

- `wg-flyio-from-screenshot.conf`

What it contains:

- interface `wg-flyio`
- listen port `51820`
- MTU `1350`
- Fly.io peer endpoint `bom1.gateway.6pn.dev:51820`
- peer allowed network `fdaa:f:b72::/48`

Important limitations:

- This is screenshot-derived OCR and should be verified against RouterOS before production use.
- The visible peer in the screenshot advertises only IPv6 (`fdaa:f:b72::/48`).
- It does not include the router IPv4 tunnel path such as `10.0.0.11/32` or `10.0.0.0/24`.
- If you want to test RouterOS API or SSH to the router over WireGuard using IPv4, the MikroTik peer must also advertise the required IPv4 allowed addresses.

Example test commands after bringing the tunnel up:

```bash
sudo wg-quick up ./wireguard-server-main/docs/wg-flyio-from-screenshot.conf
ip -6 route get fdaa:f:b72::1
ping -6 -c 3 fdaa:f:b72::1
```

If you need IPv4 router access, update the MikroTik peer configuration first so it includes the required IPv4 route, for example:

```routeros
/interface/wireguard/peers/set <peer-number> allowed-address=10.0.0.0/24,fdaa:f:b72::/48 persistent-keepalive=25s
```
