// Desktop-side enqueue audit — same JSONL as executor/pay-forensics.js.
// Behavior-neutral. Used to classify dual Revolut: 1 Start → N jobs?

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function logPath() {
  const env = String(process.env.PAY_FORENSICS_PATH || "").trim();
  if (env) return env;
  return path.join(os.tmpdir(), "j1m-pay-forensics.jsonl");
}

function cardLast4(profile) {
  const card = profile?.card || profile?.payment || {};
  const n = String(card.number || card.pan || profile?.card_number || "").replace(/\s+/g, "");
  return n.length >= 4 ? n.slice(-4) : null;
}

function append(event, fields = {}) {
  const row = {
    t: new Date().toISOString(),
    ts: Date.now(),
    event: String(event || "unknown"),
    ...fields,
  };
  const line = JSON.stringify(row);
  try {
    console.log(`[pay-forensics] ${line}`);
  } catch {
    /* ignore */
  }
  try {
    fs.appendFileSync(logPath(), `${line}\n`, "utf8");
  } catch {
    /* ignore */
  }
  return row;
}

/**
 * One line per Start batch + one line per job.
 * @param {object[]} jobs — { task, profile, runId? }[]
 * @param {object} [meta]
 */
function auditEnqueueBatch(jobs, meta = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  append("desktop_enqueue_batch", {
    jobCount: list.length,
    taskIds: [...new Set(list.map((j) => j?.task?.id).filter(Boolean))],
    stores: [...new Set(list.map((j) => j?.task?.store).filter(Boolean))],
    quantities: list.map((j) => Number(j?.task?.quantity) || 1),
    source: meta.source || null,
    stagger: meta.stagger === true,
  });
  for (let i = 0; i < list.length; i++) {
    const job = list[i];
    const task = job?.task || {};
    const profile = job?.profile || {};
    append("desktop_enqueue_job", {
      jobIndex: i,
      jobCount: list.length,
      desktopTaskId: task.id || null,
      desktopRunId: job.runId || null,
      store: task.store || null,
      quantity: Number(task.quantity) || 1,
      profileId: task.profileId || profile.id || null,
      cardLast4: cardLast4(profile),
      pdpUrl: String(task.pdpUrl || task.input || "").slice(0, 160) || null,
      source: meta.source || null,
    });
  }
}

module.exports = { auditEnqueueBatch, append, logPath };