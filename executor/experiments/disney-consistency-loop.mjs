#!/usr/bin/env node
/**
 * Disney AU — N× timed fake-decline runs for consistency + speed stats.
 *
 *   RUNS=3 PROXY_LINE=0 node experiments/disney-consistency-loop.mjs
 *   RUNS=5 PROXY_ROTATE=1 node experiments/disney-consistency-loop.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNS = Math.max(1, Math.min(20, Number(process.env.RUNS || 3) | 0));
const rotate = process.env.PROXY_ROTATE === "1";
const baseLine = Math.max(0, Number(process.env.PROXY_LINE || 0) | 0);
const outRoot = process.env.DISNEY_OUT || `/tmp/disney-consistency-${Date.now()}`;
fs.mkdirSync(outRoot, { recursive: true });

function runOnce(i) {
  const outDir = path.join(outRoot, `run-${i}`);
  const env = {
    ...process.env,
    DISNEY_OUT: outDir,
    DISNEY_NO_PAGE: process.env.DISNEY_NO_PAGE || "1",
    PROXY_LINE: String(rotate ? baseLine + i : baseLine),
  };
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(
      process.execPath,
      ["experiments/disney-timed-checkout.mjs"],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      let summary = null;
      try {
        summary = JSON.parse(fs.readFileSync(path.join(outDir, "summary.json"), "utf8"));
      } catch {
        /* ignore */
      }
      resolve({
        i,
        code,
        ms: Date.now() - t0,
        summary,
        tail: (stdout || stderr).slice(-500),
      });
    });
  });
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

console.log(JSON.stringify({ outRoot, RUNS, rotate, baseLine }, null, 2));

const results = [];
for (let i = 0; i < RUNS; i++) {
  console.log(`\n--- run ${i + 1}/${RUNS} ---`);
  const r = await runOnce(i);
  results.push(r);
  const s = r.summary;
  console.log(
    JSON.stringify(
      {
        exit: r.code,
        ok: s?.ok,
        decline: s?.decline,
        totalSec: s?.totalSec,
        toCheckoutV2Sec: s?.timing?.startToCheckoutV2Sec,
        toIssuerSec: s?.timing?.startToIssuerSec,
        fraud: s?.possibleFraudDetected,
        sameCart: s?.isSameCartToken,
        failedStep: s?.failedStep,
        tx: s?.transactionId,
      },
      null,
      2,
    ),
  );
}

const wins = results.filter((r) => r.summary?.decline || r.summary?.ok);
const totals = wins
  .map((r) => r.summary?.totalMs)
  .filter((n) => typeof n === "number")
  .sort((a, b) => a - b);
const toV2 = wins
  .map((r) => r.summary?.timing?.startToCheckoutV2Ms)
  .filter((n) => typeof n === "number")
  .sort((a, b) => a - b);

const report = {
  runs: RUNS,
  wins: wins.length,
  winRate: Math.round((wins.length / RUNS) * 1000) / 10,
  totalMs: {
    p50: pct(totals, 50),
    p90: pct(totals, 90),
    min: totals[0] ?? null,
    max: totals[totals.length - 1] ?? null,
  },
  toCheckoutV2Ms: {
    p50: pct(toV2, 50),
    p90: pct(toV2, 90),
    min: toV2[0] ?? null,
    max: toV2[toV2.length - 1] ?? null,
  },
  failures: results
    .filter((r) => !(r.summary?.decline || r.summary?.ok))
    .map((r) => ({
      i: r.i,
      failedStep: r.summary?.failedStep || null,
      note: r.summary?.note || r.tail?.slice(0, 160),
    })),
  runsDetail: results.map((r) => ({
    i: r.i,
    ok: r.summary?.ok,
    decline: r.summary?.decline,
    totalSec: r.summary?.totalSec,
    toCheckoutV2Sec: r.summary?.timing?.startToCheckoutV2Sec,
    toIssuerSec: r.summary?.timing?.startToIssuerSec,
    sameCart: r.summary?.isSameCartToken,
    fraud: r.summary?.possibleFraudDetected,
    tx: r.summary?.transactionId,
    failedStep: r.summary?.failedStep,
  })),
};

fs.writeFileSync(path.join(outRoot, "report.json"), JSON.stringify(report, null, 2));
console.log("\n=== CONSISTENCY REPORT ===");
console.log(JSON.stringify(report, null, 2));
console.log(`wrote ${outRoot}`);
process.exit(wins.length > 0 ? 0 : 1);
