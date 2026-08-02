#!/usr/bin/env node
/**
 * Classify dual-Revolut forensics JSONL into:
 *   two_runs | two_psp_posts | one_post_two_bank_suspect | no_psp
 *
 * Also reports angles A/B/C:
 *   A) fan-out fields on psp_post_end (transactionId / redirectHost)
 *   B) prepay vs issuer http_mutate / http_mutate_response
 *   C) stock Fast scoreboard (via=page-ge-issuer)
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
const httpMutateResponses = rows.filter((r) => r.event === "http_mutate_response");

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
function attachOrphanPsp(all) {
  const starts = all.filter((r) => r.event === "run_start").sort((a, b) => a.ts - b.ts);
  return all.map((r) => {
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
  if (!byRun.has(k)) {
    byRun.set(k, {
      run_start: [],
      psp_post_start: [],
      psp_post_end: [],
    });
  }
  byRun.get(k).run_start.push(r);
}
for (const r of pspStarts) {
  const k = groupKey(r) || "unknown";
  if (!byRun.has(k)) {
    byRun.set(k, { run_start: [], psp_post_start: [], psp_post_end: [] });
  }
  byRun.get(k).psp_post_start.push(r);
}
for (const r of pspEnds) {
  const k = groupKey(r) || "unknown";
  if (!byRun.has(k)) {
    byRun.set(k, { run_start: [], psp_post_start: [], psp_post_end: [] });
  }
  byRun.get(k).psp_post_end.push(r);
}

const classes = [];
for (const [k, g] of byRun) {
  const runN = g.run_start.length;
  const pspN = g.psp_post_start.length;
  let cls = "unknown";
  if (runN >= 2) cls = "two_runs";
  else if (pspN >= 2) cls = "two_psp_posts";
  else if (pspN === 1) cls = "one_post_two_bank_suspect";
  else if (pspN === 0) cls = "no_psp";
  const ends = g.psp_post_end;
  const vias = [...new Set(g.psp_post_start.map((x) => x.via).filter(Boolean))];
  // Stock Fast pay = undici http-ge-issuer (hard no Playwright pay).
  // page-ge-issuer is Safe/opt-in only — do not treat as Fast scoreboard.
  const stockFast = vias.includes("http-ge-issuer");
  classes.push({
    key: k,
    class: cls,
    run_start: runN,
    psp_post_start: pspN,
    stores: [
      ...new Set(
        [...g.run_start, ...g.psp_post_start].map((x) => x.store).filter(Boolean),
      ),
    ],
    vias,
    stockFast,
    bankSignals: ends.filter((x) => x.bankSignal).length,
    // Angle A
    fanout: {
      transactionIds: [
        ...new Set(ends.map((x) => x.transactionId).filter(Boolean)),
      ],
      redirectHosts: [
        ...new Set(ends.map((x) => x.redirectHost).filter(Boolean)),
      ],
      statusTypes: [...new Set(ends.map((x) => x.statusType).filter(Boolean))],
      locationLooksAcs: ends.some((x) => x.locationLooksAcs),
    },
  });
}

const payHostMutates = httpMutates.filter((r) => r.payHost);
const issuerLikeMutates = httpMutates.filter((r) => r.issuerLike);
const prepayMutates = httpMutates.filter((r) => r.stage === "prepay");
const issuerStageMutates = httpMutates.filter((r) => r.stage === "issuer");
const acsLocations = httpMutateResponses.filter((r) => r.locationLooksAcs);

const summary = {
  file,
  enqueueBatches: enqueues.length,
  enqueueJobs: jobs.length,
  runStarts: runs.length,
  pspPostStarts: pspStarts.length,
  httpMutates: httpMutates.length,
  httpMutateResponses: httpMutateResponses.length,
  payHostMutates: payHostMutates.length,
  issuerLikeMutates: issuerLikeMutates.length,
  // Angle B
  prepayMutates: prepayMutates.length,
  issuerStageMutates: issuerStageMutates.length,
  acsOrRedirectLocations: acsLocations.length,
  byClass: classes.reduce((acc, c) => {
    acc[c.class] = (acc[c.class] || 0) + 1;
    return acc;
  }, {}),
  // Angle C
  stockFastGroups: classes.filter((c) => c.stockFast).length,
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
  recentPspEnds: pspEnds.slice(-8).map((r) => ({
    t: r.t,
    store: r.store,
    via: r.via,
    status: r.status,
    transactionId: r.transactionId || null,
    redirectHost: r.redirectHost || null,
    statusType: r.statusType || null,
    scoreboard: r.scoreboard || null,
  })),
  recentPrepay: prepayMutates.slice(-20).map((r) => ({
    t: r.t,
    method: r.method,
    host: r.host,
    path: r.path,
    bodyBytes: r.bodyBytes,
    stage: r.stage,
  })),
  recentMutateResponses: httpMutateResponses.slice(-15).map((r) => ({
    t: r.t,
    status: r.status,
    host: r.host,
    path: r.path,
    locationHost: r.locationHost,
    locationPath: r.locationPath,
    locationLooksAcs: r.locationLooksAcs,
    stage: r.stage,
    undiciAttempts: r.undiciAttempts,
    payTransport: r.payTransport || null,
  })),
  issuerPayTransports: [
    ...new Set(
      httpMutateResponses
        .filter((r) => r.stage === "issuer" && r.payTransport)
        .map((r) => r.payTransport),
    ),
  ],
};

console.log(JSON.stringify(summary, null, 2));
if (summary.byClass.one_post_two_bank_suspect) {
  console.log(
    "\nNOTE [A]: one_post_two_bank_suspect = 1 client PSP POST. If Revolut shows 2, look at fanout.transactionIds / redirectHosts — merchant/PSP fan-out, not a second client POST.",
  );
}
if (issuerLikeMutates.length > pspStarts.length) {
  console.log(
    `\nNOTE [B]: issuerLike http_mutate (${issuerLikeMutates.length}) > psp_post_start (${pspStarts.length}) — possible uninstrumented second issuer hop.`,
  );
}
if (prepayMutates.length) {
  console.log(
    `\nNOTE [B]: ${prepayMutates.length} prepay pay-host mutates logged (handleaction/save/etc). Diff these vs a manual HAR if dual persists.`,
  );
}
if (summary.stockFastGroups) {
  console.log(
    `\nNOTE [C]: ${summary.stockFastGroups} group(s) used stock Fast page-ge-issuer — prefer these for Revolut 1 vs 2 scoring.`,
  );
}
