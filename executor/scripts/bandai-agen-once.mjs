#!/usr/bin/env node
// ONE Premium Bandai AU account-gen attempt.
// SMSPool (US/UK) + IMAP (Hide My Email → primary inbox). Does not loop signups.
//
// Usage (secrets via env /tmp — never commit):
//   SMSPOOL_API_KEY=... \
//   IMAP_HOST=imap.mail.me.com IMAP_USER=jimposted@icloud.com IMAP_APP_PASSWORD=... \
//   EMAIL='alias@icloud.com' \
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

function proxyLines() {
  if (process.env.PROXY_LINE) return [process.env.PROXY_LINE.trim()];
  const fromFile = [];
  try {
    const saved = fs.readFileSync("/tmp/bandai-agen-proxy.txt", "utf8").trim();
    if (saved) fromFile.push(saved);
  } catch {
    /* ignore */
  }
  const lines = fs
    .readFileSync(path.join(__dirname, "..", "resi.proxies"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  // Prefer saved first, then rotate through pool (cap retries — do not spray)
  const max = Number(process.env.PROXY_TRIES) || 6;
  const merged = [...fromFile, ...lines.filter((l) => l !== fromFile[0])];
  return merged.slice(0, max);
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

function isProxyFailure(result) {
  const step = String(result?.failedStep || "");
  const err = String(result?.error || "");
  if (!/^(warm|email_auth|throw)$/.test(step) && step) return false;
  return /proxy|fetch failed|cancelled|ECONN|tunnel|403|TLS|socket|UND_ERR/i.test(
    `${step} ${err}`,
  );
}

function pastEmailAuth(result) {
  const steps = result?.steps || [];
  return steps.some((s) => s.step === "email_auth" && s.ok);
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

const email = String(process.env.EMAIL || imapUser).trim().toLowerCase();
const uniquify =
  process.env.UNIQUIFY_EMAIL === "1" ||
  process.env.UNIQUIFY_EMAIL === "true" ||
  (/bullposted\.com$/i.test(email) && process.env.UNIQUIFY_EMAIL !== "0");

const proxies = proxyLines();
let result = null;
let usedHost = null;

for (let i = 0; i < proxies.length; i++) {
  const proxyRaw = toProxyUrl(proxies[i]);
  usedHost = String(proxies[i] || "").split(":")[0] || null;
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
    uniquifyEmail: uniquify,
    signupEmail: email,
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
    JSON.stringify({
      phase: "try",
      attempt: i + 1,
      taskId: task.taskId,
      email,
      proxyHost: usedHost,
      imapUser,
      note: "OTP matched by To: alias; proxy retries stop after email_auth",
    }),
  );

  try {
    result = await bandaiAdapter.run(task, ctx);
  } catch (e) {
    result = {
      ok: false,
      failedStep: "throw",
      error: e?.cause?.message || e?.message || String(e),
      steps: ctx.steps,
    };
  }

  if (result?.ok) break;
  // Never rotate proxies after Bandai has emailed an OTP for this alias.
  if (pastEmailAuth(result)) break;
  if (!isProxyFailure(result)) break;
  console.log(
    JSON.stringify({
      phase: "proxy_retry",
      failedStep: result?.failedStep,
      error: result?.error,
      next: i + 1 < proxies.length,
    }),
  );
}

const outPath = process.env.OUT || "/tmp/bandai-agen-once-result.json";
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      ok: result?.ok,
      failedStep: result?.failedStep,
      error: result?.error,
      note: result?.note,
      proxyHost: usedHost,
      account: result?.account
        ? {
            email: result.account.email,
            phone: result.account.phone,
            phoneCountry: result.account.phoneCountry,
            status: result.account.status,
            smsProvider: result.account.smsProvider,
            password: result.account.password,
          }
        : null,
      steps: result?.steps || [],
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
      proxyHost: usedHost,
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
