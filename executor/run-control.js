/**
 * In-flight /run cancellation registry.
 * Desktop Stop used to only destroy the HTTP client — the sidecar kept paying.
 * POST /cancel aborts the AbortSignal registered for that taskId.
 */

/** @type {Map<string, AbortController>} */
const controllers = new Map();

/**
 * @param {string} taskId
 * @returns {AbortController}
 */
export function beginRun(taskId) {
  const id = String(taskId || "").trim();
  if (!id) {
    const ac = new AbortController();
    return ac;
  }
  const prev = controllers.get(id);
  if (prev && !prev.signal.aborted) {
    try {
      prev.abort();
    } catch {
      /* ignore */
    }
  }
  const ac = new AbortController();
  controllers.set(id, ac);
  return ac;
}

/**
 * @param {string} taskId
 * @param {AbortController} [ac]
 */
export function endRun(taskId, ac) {
  const id = String(taskId || "").trim();
  if (!id) return;
  if (!ac || controllers.get(id) === ac) controllers.delete(id);
}

/**
 * @param {string} taskId
 * @returns {{ ok: boolean, found: boolean, alreadyAborted?: boolean }}
 */
export function cancelRun(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return { ok: false, found: false };
  const ac = controllers.get(id);
  if (!ac) return { ok: false, found: false };
  if (ac.signal.aborted) return { ok: true, found: true, alreadyAborted: true };
  try {
    ac.abort();
  } catch {
    /* ignore */
  }
  return { ok: true, found: true };
}

/**
 * @param {string} taskId
 * @returns {AbortSignal | null}
 */
export function runSignal(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return null;
  return controllers.get(id)?.signal || null;
}

/**
 * @param {AbortSignal | null | undefined} signal
 * @returns {boolean}
 */
export function isRunAborted(signal) {
  return Boolean(signal?.aborted);
}

/**
 * Throw a typed abort error for adapters to surface as stopped.
 * @param {AbortSignal | null | undefined} signal
 */
export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const err = new Error("run_cancelled");
  err.code = "RUN_CANCELLED";
  err.cancelled = true;
  throw err;
}
