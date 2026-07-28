/**
 * Tiny in-memory ring buffer for Vanta Lab Logs tab.
 * Process-local — clears on redeploy (same as polls/hits).
 */

const MAX = Math.max(50, Math.min(1000, Number(process.env.LAB_LOG_BUFFER) || 300));

/** @type {object[]} */
const lines = [];

/**
 * @param {string} source — monitor | bot | discord | system
 * @param {string} level — info | warn | err
 * @param {string} message
 * @param {object} [meta]
 */
export function labLog(source, level, message, meta = null) {
  const row = {
    at: new Date().toISOString(),
    source: String(source || "system"),
    level: String(level || "info"),
    message: String(message || "").slice(0, 500),
    ...(meta && typeof meta === "object" ? { meta } : {}),
  };
  lines.unshift(row);
  if (lines.length > MAX) lines.length = MAX;
  return row;
}

export function getLabLogs({ limit = 100, source = null, level = null } = {}) {
  const lim = Math.max(1, Math.min(MAX, Number(limit) || 100));
  let out = lines;
  if (source) {
    const s = String(source).toLowerCase();
    out = out.filter((r) => String(r.source).toLowerCase() === s);
  }
  if (level) {
    const l = String(level).toLowerCase();
    out = out.filter((r) => String(r.level).toLowerCase() === l);
  }
  return out.slice(0, lim);
}

export function clearLabLogs() {
  lines.length = 0;
  return { ok: true, cleared: true };
}

export function labLogStats() {
  return { size: lines.length, max: MAX };
}
