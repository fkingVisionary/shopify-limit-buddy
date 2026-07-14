/* Store adapter contract (future stores plug in here).

Each adapter module should export:
  id: string
  label: string
  validateTask(task) -> { ok, error? }
  buildRunPayload({ task, profile, proxyRaw, placeOrder }) -> { ok, data?, error? }

v1 ships Kmart only (see ../job-runner.cjs buildKmartPayload).
The local executor sidecar still runs the proven executor/adapters/kmart.js chain.
*/
