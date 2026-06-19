## Plan

The likely issue is that the code is sending your third-party proxy via Browserless’s built-in `proxy` parameter. Browserless documentation now expects external proxies to be passed as `externalProxyServer=http://user:pass@host:port`; using `proxy=` is for Browserless-managed residential/datacenter proxy modes and can return 400s.

## Changes to make

1. Update `supabase/functions/run-checkout/index.ts`
   - Keep the existing normalization for your format:
     `premium-proxy.ipfist.com:1818:username:password`
   - Convert it to:
     `http://username:password@premium-proxy.ipfist.com:1818`
   - Send it to Browserless as `externalProxyServer`, not `proxy`.
   - Remove `proxySticky` for external proxies because Browserless stickiness applies to their managed proxy network, not your provider.

2. Add safer diagnostics
   - Store a sanitized proxy summary in the job result/error path, such as `external proxy premium-proxy.ipfist.com:1818`, without logging username/password.
   - If Browserless returns 400, preserve the upstream response body so the UI shows the exact Browserless rejection reason.

3. Improve proxy input help/testing in the app
   - Update the proxy placeholder/help text so raw authenticated proxies are accepted for Browserless checkout.
   - Adjust the current “Server test” messaging so raw proxies don’t misleadingly fail with “missing {url}”; instead show that raw proxies are used by Browserless checkout, while `{url}` templates are used by fetch-based product checks.

4. Deploy and verify
   - Deploy the `run-checkout` function after the code change.
   - Check recent function logs and a test checkout job to confirm the 400 is gone or that the remaining error is from the proxy provider/store rather than Browserless parameter validation.