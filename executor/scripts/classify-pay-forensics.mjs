#!/usr/bin/env node
/**
 * Classify dual-Revolut forensics JSONL into:
 *   two_runs | two_psp_posts | one_post_two_bank_suspect | no_psp
 *
 * Usage:
 *   node executor/scripts/classify-pay-forensics.mjs [path.jsonl]
 *   PAY_FORENSICS_PATH=… node executor/scripts/classify-pay-forensics.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file =
  process.argv[2] ||
  process.env.PAY_FORENSICS_PATH ||
  path.join(os.tmpdir(), "j1m-pay-forensics.jsonl");

if (!fs.existsSync(file)) {
  console.error("missing", file);
  process.exit(2);
}

const rows = attachOrphanPsp(
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean),
);

const enqueues = rows.filter((r) => r.event === "desktop_enqueue_batch");
const jobs = rows.filter((r) => r.event === "desktop_enqueue_job");
const runs = rows.filter((r) => r.event === "run_start");
const pspStarts = rows.filter((r) => r.event === "psp_post_start");
const pspEnds = rows.filter((r) => r.event === "psp_post_end");
const httpMutates = rows.filter((r) => r.event === "http_mutate");

function groupKey(r) {
  return (
    r.desktopRunId ||
    r.desktopTaskId ||
    r.executorTaskId ||
    r.cardLast4 ||
    null
  );
}

/** If PSP rows lack desktop ids (older adapters), attach to nearest run_start within 3 min. */
function attachOrphanPsp(rows) {
  const starts = rows.filter((r) => r.event === "run_start").sort((a, b) => a.ts - b.ts);
  return rows.map((r) => {
    if (r.event !== "psp_post_start" && r.event !== "psp_post_end") return r;
    if (groupKey(r)) return r;
    const near = starts
      .filter((s) => s.ts <= r.ts && r.ts - s.ts < 180_000)
      .sort((a, b) => b.ts - a.ts)[0];
    if (!near) return r;
    return {
      ...r,
      desktopRunId: near.desktopRunId || r.desktopRunId,
      desktopTaskId: near.desktopTaskId || r.desktopTaskId,
      executorTaskId: near.executorTaskId || r.executorTaskId,
      _linkedFromRunStart: true,
    };
  });
}

const byRun = new Map();
for (const r of runs) {
  const k = groupKey(r) || "unknown";
  if (!byRun.has(k)) byRun.set(k, { run_start: [], psp_post_start: [], psp_post_end: [] });
  byRun.get(k).run_start.push(r);
}
for (const r of pspStarts) {
  const k = groupKey(r) || "unknown";
  if (!byRun.has(k)) byRun.set(k, { run_start: [], psp_post_start: [], psp_post_end: [] });
  byRun.get(k).psp_post_start.push(r);
}
for (const r of pspEnds) {
  const k = groupKey(r) || "unknown";
  if (!byRun.has(k)) byRun.set(k, { run_start: [], psp_post_start: [], psp_post_end: [] });
  byRun.get(k).psp_post_end.push(r);
}

const classes = [];
for (const [k, g] of byRun) {
  const runN = g.run_start.length;
  const pspN = g.psp_post_start.length;
  let cls = "unknown";
  if (runN >= 2) cls = "two_runs";
  else if (runN <= 1 && pspN >= 2) cls = "two_psp_posts";
  else if (runN === 1 && pspN === 1) cls = "one_post_two_bank_suspect";
  else if (pspN === 0) cls = "no_psp";
  classes.push({
    key: k,
    class: cls,
    run_start: runN,
    psp_post_start: pspN,
    stores: [...new Set([...g.run_start, ...g.psp_post_start].map((x) => x.store).filter(Boolean))],
    bankSignals: g.psp_post_end.filter((x) => x.bankSignal).length,
  });
}

const payHostMutates = httpMutates.filter((r) => r.payHost);
const summary = {
  file,
  enqueueBatches: enqueues.length,
  enqueueJobs: jobs.length,
  runStarts: runs.length,
  pspPostStarts: pspStarts.length,
  httpMutates: httpMutates.length,
  payHostMutates: payHostMutates.length,
  byClass: classes.reduce((acc, c) => {
    acc[c.class] = (acc[c.class] || 0) + 1;
    return acc;
  }, {}),
  groups: classes,
  recentEnqueues: enqueues.slice(-5),
  recentPsp: pspStarts.slice(-8).map((r) => ({
    t: r.t,
    store: r.store,
    via: r.via,
    bodyBytes: r.bodyBytes,
    desktopTaskId: r.desktopTaskId,
    desktopRunId: r.desktopRunId,
  })),
  recentPayMutates: payHostMutates.slice(-20).map((r) => ({
    t: r.t,
    method: r.method,
    host: r.host,
    path: r.path,
    bodyBytes: r.bodyBytes,
  })),
};

console.log(JSON.stringify(summary, null, 2));
if (summary.byClass.one_post_two_bank_suspect) {
  console.log(
    "\nNOTE: one_post_two_bank_suspect = 1 client PSP POST. If Revolut shows 2, class is PSP/acquirer dual-rail (or missing uninstrumented second POST).",
  );
}
if (payHostMutates.length > pspStarts.length) {
  console.log(
    `\nNOTE: pay-host http_mutate (${payHostMutates.length}) > psp_post_start (${pspStarts.length}) — possible uninstrumented second pay hop.`,
  );
}
