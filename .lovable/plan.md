
## Context

After the TLS-client switch, `_abck` reaches `~0~` after 3 sensor rounds — sensor passes. But `pdp_get` still 403s with an AkamaiGHost "reference code" page. The script tag in that 403 body is `/8vR.../...?v=` with an **empty `v=` value**, not `?v=<uuid>` — so it is **not** an SBSD challenge (per Hyper §3.4 SBSD requires `?v=<uuid>`).

That page is Akamai's edge-rejection page that embeds a **fresh sensor script path**. The correct response per Hyper's flow is to fetch that new script and run another sensor solve cycle against it, then retry the PDP. Our current adapter doesn't do that — it falls through to SBSD detection, finds no UUID, logs `sbsd_missing`, and gives up.

## What to change

### 1. `executor/adapters/kmart.js` — add an "AkamaiGHost reference page" handler

Before the SBSD branch (around line 244), add a new branch that fires when:
- `pdpStatus === 403` AND
- body matches `/Reference\s*#/i` or `/Access Denied/i` AND
- body matches `/src=["'](\/[A-Za-z0-9_\-\/.]+)\?v=["']/` (script path with empty `v=`).

When matched:
1. Extract the new sensor script path from the 403 body (the `src="..."` without query).
2. Fetch that script via `request(origin + path, { GET, referer: pdpUrl })` → `scriptBody`.
3. Run up to 3 `solveAkamaiSensor` rounds against `scriptBody`, POSTing to `origin + path` exactly like `warm_home`'s sensor loop already does. Break on `_abck` containing `~0~`.
4. Retry `pdp_get` (reuse existing pdp2 logic). Log as `pdp_get#retry`.
5. Loop the whole reference-page detect → resolve up to 2 times total (some Akamai installs serve a second reference page).

Reuse the existing sensor helper code path that already exists for the warm-home phase rather than duplicating it — extract the sensor-solve loop into a small local function `runSensorLoop(scriptUrl, scriptBody, pageUrl)` at the top of the adapter and call it from both warm-home and the new reference-page handler.

### 2. Tighten SBSD detection so the empty-`v=` case stops being misclassified

Change `SBSD_RE` in `kmart.js` line 18 from `([0-9a-f-]+)` to `([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})` — require a real UUID. This prevents future false positives and removes the misleading `sbsd_missing` step from logs when the page is actually a reference-code page.

### 3. Logging

Add steps:
- `pdp_403_reference` — note: extracted script path + first 200 chars of body.
- `pdp_sensor_fetch#N` — note: script bytes.
- `pdp_sensor#N.M` — note: abck state after each round (same shape as existing `akamai_sensor#N`).
- `pdp_get#retry#N` — note: status + first 400 chars.

### 4. Out of scope

- No SBSD wiring changes (existing code stays for the day it actually fires).
- No TLS / proxy changes.
- No `src/lib/*` or UI changes.
- No new env vars or secrets.

## Validation

1. Deploy; rerun the same Kmart PDP dry run.
2. Expect: warm-home sensor passes → pdp_get 403 → `pdp_403_reference` detected → new sensor loop runs → `pdp_get#retry#0` returns 200 with real HTML (or at least a much larger body than the reference page).
3. If retry still 403s, the next reference page may carry an actual SBSD `?v=<uuid>` — in which case the existing SBSD branch will handle it.
4. If we instead see a 429 with `{"t":"<token>"}`, that's Hyper §3.6 territory and a separate follow-up.

## Risks

- The sensor-script POST URL is the same as the GET URL minus query. Confirmed by the warm-home flow already in `kmart.js`. Same pattern reused.
- Some reference pages emit `defer` attribute or extra attrs around `src=` — the regex uses `["']` delimiters with non-greedy path matching, so it handles both.
- If Akamai serves >2 consecutive reference pages, we give up after 2 retries to avoid infinite loops; that's deliberate.
