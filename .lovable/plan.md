## Goal
Break the Kmart `akamai_sensor success=false` loop while keeping the route as: **sticky residential proxy + Hyper sensor solving**, not Oxylabs Web Unblocker.

## Key finding from the current code
The executor is only using the Chrome TLS client when either:
- `EXECUTOR_HTTP_TRANSPORT=tls`, or
- Oxylabs mode is enabled and an explicit proxy is supplied.

So if Oxylabs is now disabled and you are passing sticky residential proxies, the current code can still route those sticky proxies through `undici` instead of the Chrome-impersonated TLS client. That means the IP is residential, but the TLS/HTTP fingerprint is still non-browser, which is exactly the kind of mismatch that makes Akamai accept the POST but return `success=false` / keep `_abck` unsolved.

## Plan
1. **Lock the intended transport behavior**
   - Treat any explicit proxy as a browser-like TLS session by default.
   - Keep direct/no-proxy behavior configurable, but do not let sticky proxy runs silently fall back to `undici`.
   - Add the selected transport into executor timelines so every run says whether it used `tls`, `undici`, or `oxylabs`.

2. **Remove misleading fallback assumptions**
   - Stop recommending “use stickies” as if that alone solves it.
   - Update the executor docs/setup notes to reflect the real requirement: sticky residential IP **plus** Chrome TLS fingerprint **plus** matching Hyper inputs.

3. **Add a focused Akamai sensor diagnostic mode**
   - Capture compact per-round fields: transport, proxy present, egress IP, `_abck` marker, `bm_sz` marker, Hyper context length, target POST status, target body success flag, Set-Cookie names.
   - Include enough data to distinguish:
     - Hyper generated a payload but target rejected it,
     - target did not rotate cookies,
     - IP drifted,
     - cookie/header/TLS mismatch,
     - wrong script path/body/context.

4. **Re-check the sensor input ordering against the installed Hyper SDK**
   - Confirm the `SensorInput` constructor argument order in the actual installed SDK, not just the old notes.
   - If the wrapper is passing fields in the wrong order, fix it and add a small self-check/log so we can verify payloads start as expected for Akamai v3.

5. **Test the exact product URL through localhost / executor**
   - Use `https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/`.
   - Run with a sticky proxy path and compare against direct only as a control.
   - Success criteria for this phase: sensor rounds produce a valid `_abck` or the output clearly identifies the remaining mismatch.

6. **Only then continue to PDP/cart**
   - Do not keep changing category/PDP/cart behavior until the sensor loop is solved.
   - Once `_abck` reaches valid, proceed to verify PDP 200, then cart/API host separately.