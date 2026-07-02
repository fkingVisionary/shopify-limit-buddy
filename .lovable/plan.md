# Add manual proxy field to JB Hi-Fi recon

## Problem
- The `/jbhifi` page fires a sweep on mount with `useProxy: false`, so requests go from Fly's egress IP straight to jbhifi.com.au. That IP is almost certainly on their blocklist — hence the instant HTTP 404 (Shopify + JB Hi-Fi's CDN return 404 rather than 403 for blocked origins).
- Rotating through your saved residential proxy groups just to test wastes them.

## Change
One small UI addition on `src/routes/_paired/jbhifi.tsx` — a **Proxy** textbox above the Search row. Whatever the user types is passed through as `proxy` all the way to the executor, which already accepts a per-request proxy string (`user:pass@host:port` or full URL).

Also: **don't auto-run on mount** anymore. First render shows an empty state with the proxy field focused. The sweep only fires when the user clicks Search or Refresh. Prevents burning any pool by accident on page load.

## Files touched
- `src/routes/_paired/jbhifi.tsx`
  - Add `proxy` state + `<Input>` labelled "Proxy (optional — `user:pass@host:port`)".
  - Remove the `useEffect(() => run(), [])` auto-run.
  - Pass `proxy: proxy.trim() || null` in the `runFn({ data })` payload.
  - Show a small hint under the field: "Leave blank to use the executor's default egress. Paste one proxy to test without touching your groups."
- `src/lib/jbhifi-recon.functions.ts`
  - Add `proxy: z.string().min(7).max(300).nullable().optional()` to `InputSchema` and forward it in the request body.

No executor changes — `/jbhifi/recon` already reads `body.proxy` first, falling back to `PROXY_URL_RESI` only when `useProxy: true`.

## Out of scope
- No dropdown of saved proxy groups (that's the whole point — you want to type one in).
- No proxy validation beyond min-length; the executor will surface any connection error in the endpoint diagnostics panel.
- No changes to Kmart or checkout flows.