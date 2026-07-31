// Rolling JSONL log for monitor → SA / Watchdog firings (survives beyond in-memory SA lastLog).

const fs = require("fs");
const path = require("path");

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_TAIL_BYTES = 512 * 1024;

function resolveLogPath(dataDir) {
  const dir = path.join(String(dataDir || ""), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "sa-monitor.jsonl");
}

function rotateIfNeeded(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (st.size <= MAX_BYTES) return;
    const fd = fs.openSync(filePath, "r");
    try {
      const start = Math.max(0, st.size - KEEP_TAIL_BYTES);
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      const cut = text.indexOf("\n");
      const tail = cut >= 0 ? text.slice(cut + 1) : text;
      fs.writeFileSync(`${filePath}.tmp`, tail, "utf8");
      fs.renameSync(`${filePath}.tmp`, filePath);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Append one monitor orchestration event.
 * @param {string} dataDir userData/j1ms-desktop
 * @param {object} entry
 */
function appendMonitorEvent(dataDir, entry = {}) {
  if (!dataDir) return false;
  try {
    const filePath = resolveLogPath(dataDir);
    const row = {
      at: Date.now(),
      ...entry,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
    rotateIfNeeded(filePath);
    return true;
  } catch {
    return false;
  }
}

function readMonitorEvents(dataDir, { limit = 100 } = {}) {
  const filePath = resolveLogPath(dataDir);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const slice = lines.slice(-Math.max(1, Math.min(2000, Number(limit) || 100)));
    return slice
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  appendMonitorEvent,
  readMonitorEvents,
  resolveLogPath,
};
