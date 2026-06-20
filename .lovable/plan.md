## Root cause

The 403 we're getting on `pdp_get` is a **hard SBSD challenge page**, not an AkamaiGHost terminal block. It contains a `<script src="/path?v=<token>&t=<token>">` tag, and Hyper supports solving it. Our current detection misses it because:

1. `SBSD_RE` (kmart.js:22) requires `v` to be a **strict UUID** (`[0-9a-f]{8}-...`). The `v` value Akamai actually sends on these challenges is some other token format, so the regex never matches.
2. The `sbsdDetected` precondition on kmart.js:316 has the same UUID-shape gate (`\?v=[0-9a-f-]{8,}`), so even a loosened `SBSD_RE` would still be gated out.
3. The previously-added "reference-page recovery" and "cross-site retry" branches consume the 403 first and produce noise. They should be removed — the 403 body IS the SBSD challenge, no recovery needed.

The downstream SBSD code (script fetch → Hyper `/sbsd` POST → POST payload → retry PDP) is already correct and already handles the hard-challenge case (`rounds = sbsd.t ? 1 : 2`).

## Changes to `executor/adapters/kmart.js`

1. **Loosen `SBSD_RE`** to match the Hyper-documented pattern:
   ```
   src=["']([a-z\d/\-_.]+)\?v=(.*?)(?:&.*?t=(.*?))?["']
   ```
   Captures `path`, `v` (any token), optional `t` (any token).

2. **Loosen the `sbsdDetected` precondition** (line 316) so it doesn't gate on UUID shape. Trigger SBSD flow whenever:
   - `pdpStatus === 403`, OR
   - `parseSbsd(pdpHtml)` returns a hit (any 200/403 with the script tag).

3. **Delete the dead reference-script branch**: `REFERENCE_SCRIPT_RE`, `parseReferenceScript()`, and the `if (pdpStatus === 403 && /Reference\s*#.../) { pdp_403_hardblock + pdp_get#retry_xsite }` block. Both turned out to be misdiagnoses.

4. **Keep `verify_ip` step** — it's useful diagnostics now that IP-pinning is verified.

5. **Comment update** above `SBSD_RE` to reflect that `v` is NOT necessarily a UUID — it's an opaque token, and the presence of `t=` is what distinguishes hard challenge (1 round) from passive (2 rounds), per Hyper docs §3.3 / §3.4.

## Expected new dry-run trace

```
resolve_ip            → IP
warm_home             → 200
akamai_script_fetch   → 200
akamai_sensor#1..3    → _abck=~0~
akamai_solved
pdp_get               → 403, body has ?v=…&t=…
verify_ip             → same=true
sbsd_script_fetch     → 200, NNNNNNb
sbsd_round#0          → 200 (hard challenge = single round because t is set)
pdp_get#2             → 200, ~1.6MB PDP HTML
sku_extract           → sku=NNNNNNN
```

If `pdp_get#2` still 403s with the new flow, the next step is to inspect the Hyper `/sbsd` response body and the `sbsd_o`/`bm_so` cookie state — but per your note, this is the documented happy path and should work.

## Files touched

- `executor/adapters/kmart.js` — regex, detection gate, removal of two dead branches, comment.

No other files change.
