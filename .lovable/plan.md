## New plan: stop the regressions, isolate Akamai, then move forward

### Goal
Get Kmart out of the `_abck` / `akamai_sensor success=false` loop reliably using the intended route: sticky residential proxy + Chrome-like TLS + Hyper Solutions. No more PDP/cart/checkout changes until the sensor layer is proven stable.

### What changes now
1. **Freeze the checkout surface**
   - Stop changing PDP, cart, GraphQL, and checkout behavior.
   - Treat every current failure as an Akamai preflight failure until `_abck` reaches a valid state consistently.

2. **Add a dedicated Akamai lab endpoint**
   - Add an executor endpoint that only does:
     - open the exact Kmart PDP URL,
     - collect initial cookies,
     - fetch the Akamai script,
     - call Hyper,
     - POST sensor data,
     - repeat a fixed number of rounds,
     - return a compact diagnostic report.
   - It will not continue to PDP/cart logic, so results are not polluted by later code paths.

3. **Make transport impossible to misread**
   - Every diagnostic round will report:
     - requested proxy present: yes/no,
     - actual transport: `tls`, `undici`, or `oxylabs`,
     - egress IP,
     - whether IP changed between rounds,
     - user agent and accept-language family.
   - If the UI says `transport=oxylabs` while you expected sticky proxy, that becomes a hard fail in the diagnostic, not something hidden in logs.

4. **Verify Hyper input shape against the installed SDK**
   - Inspect the installed `hyper-sdk-js` package directly.
   - Confirm `SensorInput` argument order from the actual package code/types.
   - Add a startup/self-check diagnostic that reports the input order assumptions without exposing secrets.

5. **Compare three controlled variants only**
   - Direct TLS control.
   - Sticky residential proxy through Chrome TLS.
   - Existing Oxylabs path only as a negative/legacy control, not the main route.

6. **Record round-by-round Akamai facts**
   Each sensor round should show:
   - HTTP status,
   - body success flag,
   - Set-Cookie names,
   - `_abck` marker before/after,
   - `bm_sz` marker before/after,
   - Hyper payload length,
   - Hyper context length in/out,
   - script URL/path used,
   - whether `_abck` reached `~0~`.

7. **Add a regression guard**
   - Add a small local executor test/script for the lab endpoint so we can rerun the exact same Kmart URL after each change.
   - This prevents “one step forward, one step back” because the Akamai layer becomes the acceptance gate.

### Acceptance gate before touching PDP/cart again
We only resume product/cart/checkout work after the Akamai lab returns one of these:

```text
PASS: sticky proxy + tls transport + stable IP + Hyper sensor POST success=true + _abck contains ~0~
```

or a precise remaining blocker, for example:

```text
FAIL: sticky proxy was not actually used
FAIL: transport was oxylabs/undici instead of tls
FAIL: IP changed between sensor rounds
FAIL: Hyper context generated but Kmart rejected sensor body
FAIL: script URL/body mismatch
FAIL: _abck rotates but never reaches valid marker
```

### First implementation pass
- Add the dedicated `/akamai/lab` executor endpoint.
- Wire a Lovable server function/button or reuse the existing diagnostic UI to call it.
- Do not modify checkout flow behavior in this pass.
- Run it against:
  `https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/`

### Why this should stop the back-and-forth
Right now the same run mixes Akamai solving, PDP retry, SBSD detection, cart logic, proxy routing, and UI display. That makes each fix able to regress another layer. This plan splits Akamai into its own repeatable test so we can prove the exact layer that is failing before touching anything else.