## Direction

We stop treating this as a proxy problem. The current evidence says at least one residential path reaches Kmart’s Akamai bot-manager layer and receives the required cookies, but Hyper-generated sensor posts are being rejected with `success:false` and `_abck` staying `~-1~`.

So the next milestone is not “find more proxies” or “try Oxylabs”; it is:

> Get one clean Kmart browser/session trace, then diff its Akamai sensor request context against our executor/Hyper request context until the rejection reason is isolated.

## What we will do next

1. **Freeze the known-good test lane**
   - Pick the proxy/session that reached `warm_home 200` and returned `_abck`, `bm_sz`, `ak_bmsc`, `bm_sc`, `bm_so`.
   - Use it only as the controlled lab lane.
   - Do not switch providers unless this lane returns `EDGE_DENY`.

2. **Remove Oxylabs from the decision path**
   - Oxylabs transport can remain available as a transport option, but it should not be the main strategy.
   - The default investigation path should be the direct Chrome-131 TLS executor path plus the provided sticky residential proxy.

3. **Capture a real Kmart Akamai baseline**
   - Run a real browser session through the same proxy where possible.
   - Capture HAR and cookies for:
     - initial home/PDP document
     - Akamai script fetch
     - the real `sensor_data` POST
     - response body and Set-Cookie rotation
   - If Playwright/browser gets edge-denied while executor TLS does not, we treat the browser HAR as unavailable and instead capture the executor’s full HTTP trace.

4. **Build the diff machine around Akamai sensor context**
   Compare real/expected versus executor/Hyper on:
   - document request headers
   - script request headers
   - sensor POST headers
   - referer/origin/path
   - cookie header order and values
   - `bm_sz` / `_abck` state before each sensor round
   - Akamai script URL and script body hash
   - Hyper input shape: page URL, script URL, script body, UA, language, IP, previous context
   - Hyper output shape: payload prefix/length/context length
   - response status/body/Set-Cookie names

5. **Change the lab output from screenshots into evidence**
   - Add a downloadable JSON/trace output for each lab run.
   - Add compact diff sections instead of huge wrapped table text on mobile.
   - Make `SENSOR_REJECTED` show exactly what differed from the baseline.

6. **Only then fix the executor**
   Based on the diff, adjust only the mismatching layer:
   - wrong URL/referer/script source
   - wrong cookie carry-forward/order
   - wrong sensor POST body shape
   - wrong Hyper previous context handling
   - wrong TLS/header profile
   - wrong warm-up sequence

## Success criteria

We know this is moving forward when the lab can answer one of these precisely:

- `EDGE_DENY`: this proxy/IP never reached Akamai sensor; change IP.
- `SENSOR_REJECTED`: edge accepted the session but rejected Hyper payload; diff shows the mismatched request/context.
- `SENSOR_STALE`: cookies rotated but `_abck` never became valid; compare cookie/context progression.
- `SOLVED`: `_abck` reaches `~0~`; continue into cart/checkout flow.

## Immediate implementation plan

1. Add an executor trace mode for the Kmart Akamai lab that records normalized request/response evidence without leaking proxy credentials or card data.
2. Add a baseline/diff utility that compares a saved HAR-like trace to the current lab run.
3. Update the Kmart lab UI to show the classification, rejection reason, and a downloadable trace/diff instead of unreadable wrapped logs.
4. Run the lab through the known-good sticky proxy lane and use the diff to make the next targeted fix.

## What we are explicitly not doing

- Not chasing random new proxies.
- Not treating Oxylabs as the fix.
- Not attempting checkout again until `_abck` is solved.
- Not blaming Hyper for `EDGE_DENY`.
- Not changing multiple layers at once.