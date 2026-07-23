/* Store adapter contract (future stores plug in here).

Each adapter module should export:
  id: string
  label: string
  validateTask(task) -> { ok, error? }
  buildRunPayload({ task, profile, proxyRaw, placeOrder }) -> { ok, data?, error? }

v1 ships Kmart + Bandai (+ Toymate / Pokémon Centre) via ../job-runner.cjs
(`buildKmartPayload`, `buildBandaiPayload`, …). The local executor sidecar runs
the matching executor/adapters/*.js chain (Bandai: Fast HTTP GE / Safe Playwright GE).
*/
