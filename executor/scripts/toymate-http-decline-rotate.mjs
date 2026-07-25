#!/usr/bin/env node
// Rotate sticky proxies and run LIVE Toymate HTTP decline smokes.
// Stops on paymentDeclined / orderNumber. CapSolver cost: ~1–2 solves per attempt.
//
// Usage:
//   node scripts/toymate-http-decline-rotate.mjs [maxAttempts]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const local = path.join(__dirname, "..", "noontide.proxies.local");
const lines = fs
  .readFileSync(local, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const max = Math.min(
  Number(process.env.MAX_ATTEMPTS) || Number(process.argv[2]) || lines.length,
  lines.length,
);

function runOnce(index) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PROXY_INDEX: String(index),
    };
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "toymate-checkout-live-once.mjs")],
      { env, cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

console.log(
  JSON.stringify({
    phase: "rotate_start",
    lines: lines.length,
    maxAttempts: max,
    goal: "paymentDeclined|invalid card",
  }),
);

for (let i = 0; i < max; i++) {
  console.log(JSON.stringify({ phase: "attempt", index: i, host: lines[i]?.split(":")[0] }));
  const { code, out } = await runOnce(i);
  const last = out
    .trim()
    .split(/\n/)
    .filter((l) => l.startsWith("{"))
    .pop();
  let summary = null;
  try {
    summary = JSON.parse(last);
  } catch {
    /* ignore */
  }
  const win = Boolean(summary?.paymentDeclined || summary?.orderNumber);
  console.log(
    JSON.stringify({
      phase: "attempt_done",
      index: i,
      exit: code,
      paymentDeclined: summary?.paymentDeclined ?? null,
      placeNote: summary?.placeNote || summary?.error || null,
      win,
    }),
  );
  if (win) {
    console.log(JSON.stringify({ phase: "success", index: i }));
    process.exit(0);
  }
  // Brief cool-down so CapSolver/BC spam plane can breathe.
  await new Promise((r) => setTimeout(r, 8000));
}

console.log(JSON.stringify({ phase: "exhausted", tried: max }));
process.exit(3);
