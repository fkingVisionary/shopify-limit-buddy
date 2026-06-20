# Test Kmart PDP through an AU residential proxy

## What we know
- Hyper sensors clear (`_abck ~0~`).
- PDP GET still returns 403 because Fly's datacenter IP is on Akamai's deny list for `kmart.com.au`.
- You supplied 10 sticky AU akamai-tagged sessions on `residential.wealthproxies.com:3128`.

## Constraint
Don't burn sessions. We test with **one** sticky session and only re-fire if a meaningful variable changed (headers, geo, code path).

## Steps

1. **Store one session as `PROXY_URL_RESI`** (secret), formatted as a proxy URL:

    ```
    http://j1mcollects:cz2M462wInWnVvq3-Sbf27c1c92be-akamai-AU@residential.wealthproxies.com:3128
    ```

    Using `update_secret` (it already exists). The other 9 sessions stay in your message history — we rotate to a fresh one only if this one gets flagged.

2. **Tiny exec-test patch** — accept an optional `proxyUrl` in the request body so we can override `PROXY_URL_RESI` per-call without rotating the secret each time. Falls back to env when omitted. ~3 lines.

3. **Single dry-run** with `useProxy: true` against the same Kmart PDP. Expected:
    - `resolve_ip` → AU residential IP (not 79.127.x)
    - sensors clear
    - `pdp_get` → **200**, ~150 KB

4. **Report back, do not iterate.** If 200: plan add-to-cart next. If 403: capture the response body and the egress IP, then decide between (a) header shape fix, (b) try one alternate session, or (c) inspect Hyper docs for missing input.

## Out of scope
Checkout, ATC, payments — gated on getting a clean PDP first.
