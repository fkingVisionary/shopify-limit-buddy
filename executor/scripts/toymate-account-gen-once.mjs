#!/usr/bin/env node
// ONE Toymate account-gen attempt. CapSolver spend: ~1 CF + ~1 reCAPTCHA.
// Does not loop / retry proxies.
//
// Usage:
//   CAPSOLVER_API_KEY=... node scripts/toymate-account-gen-once.mjs
// Optional: PROXY_LINE='host:port:user:pass' EMAIL=you@example.com

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDispatcher, createJar } from "../http.js";
import { toymateAdapter } from "../adapters/toymate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadKey() {
  if (process.env.CAPSOLVER_API_KEY) return;
  for (const p of [
    path.join(__dirname, "..", "..", ".env.local"),
    path.join(__dirname, "..", ".env.local"),
  ]) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const m = raw.match(/^CAPSOLVER_API_KEY=(.+)$/m);
      if (m) process.env.CAPSOLVER_API_KEY = m[1].trim();
    } catch {
      /* ignore */
    }
  }
}

function firstProxy() {
  if (process.env.PROXY_LINE) return process.env.PROXY_LINE.trim();
  const lines = fs
    .readFileSync(path.join(__dirname, "..", "resi.proxies"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return lines[0] || null;
}

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const parts = raw.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  return raw;
}

loadKey();
if (!process.env.CAPSOLVER_API_KEY) {
  console.error("CAPSOLVER_API_KEY missing");
  process.exit(1);
}

const proxyRaw = toProxyUrl(firstProxy());
const email = process.env.EMAIL || "test@bullposted.com";
const dispatcher = makeDispatcher(proxyRaw, { forceUndici: true });
const jar = createJar();
const ctx = { dispatcher, jar, steps: [] };

const task = {
  taskId: `agen-once-${Date.now().toString(36)}`,
  storeUrl: "https://www.toymate.com.au",
  toymateMode: "account_gen",
  proxy: proxyRaw,
  accountPassword: "Password1",
  placeOrder: false,
  dryRun: true,
  profile: {
    email,
    first_name: "Test",
    last_name: "Buyer",
    phone: "0412345678",
    address1: "10 George Street",
    city: "Sydney",
    province: "NSW",
    zip: "2000",
  },
};

console.log(
  JSON.stringify({
    phase: "start",
    mode: "account_gen",
    proxyHost: proxyRaw ? new URL(proxyRaw).hostname : null,
    emailBase: email,
    note: "single attempt — no retry spray",
  }),
);

const t0 = Date.now();
try {
  const out = await toymateAdapter.run(task, ctx);
  console.log(
    JSON.stringify({
      phase: "done",
      ok: out.ok,
      ms: Date.now() - t0,
      account: out.account || null,
      error: out.error || null,
      failedStep: out.failedStep || null,
      steps: (out.steps || []).map((s) => ({
        step: s.step,
        ok: s.ok,
        status: s.status,
        note: String(s.note || "").slice(0, 160),
      })),
    }),
  );
  process.exit(out.ok ? 0 : 2);
} catch (e) {
  console.log(JSON.stringify({ phase: "throw", error: e?.message || String(e), ms: Date.now() - t0 }));
  process.exit(3);
} finally {
  try {
    await dispatcher.close?.();
  } catch {
    /* ignore */
  }
}
