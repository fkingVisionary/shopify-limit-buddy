/**
 * Behavior-neutral double-charge forensics.
 * Append-only JSON lines: every /run start + every PSP issuer POST we know about.
 * Correlates desktop runId/taskId with executor taskId + card last4 + timestamps.
 *
 * Does NOT change checkout / retry / pay behavior.
 *
 * Log path: PAY_FORENSICS_PATH or <tmpdir>/j1m-pay-forensics.jsonl
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function logPath() {
  const env = String(process.env.PAY_FORENSICS_PATH || "").trim();
  if (env) return env;
  return path.join(os.tmpdir(), "j1m-pay-forensics.jsonl");
}

function maskLast4(card) {
  const n = String(card?.number || "").replace(/\s+/g, "");
  return n.length >= 4 ? n.slice(-4) : null;
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} fields
 */
export function payForensics(event, fields = {}) {
  const row = {
    t: new Date().toISOString(),
    ts: Date.now(),
    event: String(event || "unknown"),
    ...fields,
  };
  // Never persist PAN/CVV if a caller accidentally passes card.
  if (row.card && typeof row.card === "object") {
    row.cardLast4 = maskLast4(row.card);
    delete row.card;
  }
  const line = JSON.stringify(row);
  try {
    console.log(`[pay-forensics] ${line}`);
  } catch {
    /* ignore */
  }
  try {
    fs.appendFileSync(logPath(), `${line}\n`, "utf8");
  } catch {
    /* ignore — forensics must never break checkout */
  }
  return row;
}

export function payForensicsPath() {
  return logPath();
}

export default { payForensics, payForensicsPath };
