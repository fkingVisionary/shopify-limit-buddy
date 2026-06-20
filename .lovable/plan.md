## Smoke-test the Kmart dry-run

Add a minimal internal test endpoint so I can fire the dry-run from here and show you the result.

### One new file: `src/routes/api/public/exec-test.ts`

A `POST /api/public/exec-test` route that:
- Reads `EXECUTOR_URL` + `EXECUTOR_TOKEN` from Lovable secrets
- Forwards `{ storeUrl, variantId }` to `https://j1ms-bot-executor.fly.dev/run` with `dryRun: true`
- Returns the executor's step chain + final status

That's it. ~30 lines, no other code touched.

### What I'll run after approval

```
POST /api/public/exec-test
{
  "storeUrl": "https://www.kmart.com.au/product/18cm-disney-and-pixar-toy-story-action-figures-assorted-43726646/",
  "variantId": 43726646
}
```

### What success looks like

Step chain ending with:
- `akamai_solved` ✅
- `pdp_get` status `200`

### Failure modes I'll diagnose for you

- `antibot_misconfigured` → `HYPER_API_KEY` not set on Fly (re-run workflow)
- `pdp_get` 403 → proxy isn't residential AU (swap provider)
- `akamai_unsolved` → sensor pipeline needs tuning (next batch of work)
- 401 / network error → executor not reachable, check Fly Machines

After the test works I can leave the route in (handy for future spot-checks) or delete it — your call.
