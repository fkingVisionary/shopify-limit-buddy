#!/usr/bin/env node
// ONE Premium Bandai AU account-gen attempt.
// SMSPool (US/UK) + IMAP catchall. Does not loop.
//
// Usage (secrets via env /tmp — never commit):
//   SMSPOOL_API_KEY=... \
//   IMAP_HOST=imap.gmail.com IMAP_USER=... IMAP_APP_PASSWORD=... \
//   EMAIL='buyer@bullposted.com' \
//   node scripts/bandai-agen-once.mjs
//
// Optional: SMSPOOL_COUNTRY=GB|US  PROXY_LINE=host:port:user:pass

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDispatcher, createJar } from "../http.js";
import { bandaiAdapter } from "../adapters/bandai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* ignore */
  }
}

loadEnvFile("/tmp/bandai-agen.env");
loadEnvFile(path.join(__dirname, "..", ".env.local"));
if (!process.env.SMSPOOL_API_KEY) {
  try {
    process.env.SMSPOOL_API_KEY = fs.readFileSync("/tmp/smspool.key", "utf8").trim();
  } catch {
    /* ignore */
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

const smspoolKey = String(process.env.SMSPOOL_API_KEY || "").trim();
const imapHost = String(process.env.IMAP_HOST || "").trim();
const imapUser = String(process.env.IMAP_USER || "").trim();
const imapPass = String(process.env.IMAP_APP_PASSWORD || "").trim();

if (!smspoolKey) {
  console.error("SMSPOOL_API_KEY missing");
  process.exit(1);
}
if (!imapHost || !imapUser || !imapPass) {
  console.error("IMAP_HOST / IMAP_USER / IMAP_APP_PASSWORD required for email OTP");
  process.exit(1);
}

const proxyRaw = toProxyUrl(firstProxy());
const email = String(process.env.EMAIL || "buyer@bullposted.com").trim().toLowerCase();
const dispatcher = makeDispatcher(proxyRaw, { forceUndici: true });
const jar = createJar();
const ctx = { dispatcher, jar, steps: [] };

const task = {
  taskId: `bandai-agen-once-${Date.now().toString(36)}`,
  storeUrl: "https://p-bandai.com/au/",
  bandaiMode: "account_gen",
  bandaiArea: "au",
  proxy: proxyRaw,
  dryRun: true,
  placeOrder: false,
  uniquifyEmail: true,
  smsProvider: "smspool",
  smspoolApiKey: smspoolKey,
  smspoolCountry: process.env.SMSPOOL_COUNTRY || "GB",
  otp: {
    smsProvider: "smspool",
    smspoolApiKey: smspoolKey,
    smspoolCountry: process.env.SMSPOOL_COUNTRY || "GB",
    imapHost,
    imapPort: Number(process.env.IMAP_PORT) || 993,
    imapUser,
    imapAppPassword: imapPass,
    imapMailbox: process.env.IMAP_MAILBOX || "INBOX",
  },
  profile: {
    email,
    first_name: "Alex",
    last_name: "Buyer",
    address1: "1 George Street",
    city: "Sydney",
    province: "NSW",
    zip: "2000",
    phone: null,
  },
};

console.log(
  JSON.stringify(
    {
      taskId: task.taskId,
      email,
      smspoolCountry: task.smspoolCountry,
      proxy: proxyRaw ? "set" : null,
      imapHost,
      imapUser,
    },
    null,
    2,
  ),
);

const result = await bandaiAdapter(task, ctx);
const outPath = process.env.OUT || "/tmp/bandai-agen-once-result.json";
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      ok: result?.ok,
      failedStep: result?.failedStep,
      error: result?.error,
      note: result?.note,
      account: result?.account
        ? {
            email: result.account.email,
            phone: result.account.phone,
            phoneCountry: result.account.phoneCountry,
            status: result.account.status,
            smsProvider: result.account.smsProvider,
            // password omitted from console summary; kept in OUT file for vault
            password: result.account.password,
          }
        : null,
      steps: result?.steps || ctx.steps,
    },
    null,
    2,
  ),
);

console.log(
  JSON.stringify(
    {
      ok: result?.ok,
      failedStep: result?.failedStep,
      error: result?.error,
      note: result?.note,
      accountEmail: result?.account?.email,
      phoneCountry: result?.account?.phoneCountry,
      steps: (result?.steps || []).map((s) => ({
        step: s.step,
        ok: s.ok,
        ms: s.ms,
        note: s.note,
      })),
      outPath,
    },
    null,
    2,
  ),
);

process.exit(result?.ok ? 0 : 2);
