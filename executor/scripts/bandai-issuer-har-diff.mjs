#!/usr/bin/env node
/**
 * Diff Chromium GE issuer HAR vs bot Fast / Autocheckout-test issuer shape.
 *
 * Usage:
 *   node executor/scripts/bandai-issuer-har-diff.mjs --har artifacts/bandai-chrome-browser.har
 *   node executor/scripts/bandai-issuer-har-diff.mjs --har … --bot-capture /tmp/bandai-ge-issuer-capture.json
 *   node executor/scripts/bandai-issuer-har-diff.mjs --har … --forensics %TEMP%/j1m-pay-forensics.jsonl
 *
 * Never prints PAN/CVV. Redacts machineId / tokens to lengths.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const BOT_KEYS = [
  "hiddenInputForCC",
  "PaymentData.cardNum",
  "PaymentData.cardExpiryMonth",
  "PaymentData.cardExpiryYear",
  "PaymentData.cvdNumber",
  "PaymentData.checkoutV2",
  "PaymentData.cartToken",
  "PaymentData.gatewayId",
  "PaymentData.paymentMethodId",
  "PaymentData.machineId",
  "PaymentData.createTransaction",
  "PaymentData.checkoutCDNEnabled",
  "PaymentData.recapchaToken",
  "PaymentData.recapchaTime",
  "PaymentData.customerScreenColorDepth",
  "PaymentData.customerScreenWidth",
  "PaymentData.customerScreenHeight",
  "PaymentData.customerTimeZoneOffset",
  "PaymentData.customerLanguage",
  "PaymentData.UrlStructureTokenEncoded",
  "PaymentData.IsValidationMessagesV2",
  "PaymentData.CustomFields",
];

function parseForm(text) {
  const out = {};
  for (const part of String(text || "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeURIComponent(eq >= 0 ? part.slice(0, eq) : part);
    const v = decodeURIComponent(eq >= 0 ? part.slice(eq + 1) : "");
    out[k] = v;
  }
  return out;
}

function redactVal(key, val) {
  const v = String(val ?? "");
  if (/cardNum|cvdNumber|cvv|pan/i.test(key)) {
    const digits = v.replace(/\D/g, "");
    return digits.length >= 4 ? `…${digits.slice(-4)}` : "<redacted>";
  }
  if (/machineId|recapcha|token|CustomFields|UrlStructure/i.test(key)) {
    return `<len:${v.length}>`;
  }
  return v.slice(0, 120);
}

function loadHarIssuers(harPath) {
  const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
  const entries = har?.log?.entries || [];
  return entries
    .filter((e) => /HandleCreditCard/i.test(e?.request?.url || ""))
    .map((e, idx) => {
      const fields = parseForm(e.request?.postData?.text);
      const headers = Object.fromEntries(
        (e.request?.headers || []).map((h) => [String(h.name).toLowerCase(), h.value]),
      );
      return {
        idx,
        started: e.startedDateTime,
        method: e.request?.method,
        url: e.request?.url,
        status: e.response?.status,
        mode: (String(e.request?.url || "").match(/[?&]mode=([^&]+)/) || [])[1] || null,
        fields,
        fieldKeys: Object.keys(fields),
        headers: {
          contentType: headers["content-type"] || null,
          origin: headers.origin || null,
          referer: headers.referer || null,
          secFetchSite: headers["sec-fetch-site"] || null,
          secFetchMode: headers["sec-fetch-mode"] || null,
          secFetchDest: headers["sec-fetch-dest"] || null,
          accept: headers.accept || null,
          cookieCount: headers.cookie ? String(headers.cookie).split(";").length : 0,
          ua: headers["user-agent"] ? String(headers["user-agent"]).slice(0, 100) : null,
        },
      };
    });
}

function loadBotCapture(p) {
  if (!p || !fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const body = raw.body || raw.postBody || raw.issuerBody || null;
  const url = raw.url || raw.issuerUrl || null;
  const fields = body ? parseForm(body) : raw.fields || null;
  return { url, fields, fieldKeys: fields ? Object.keys(fields) : [], rawKeys: Object.keys(raw) };
}

function loadForensics(p) {
  if (!p || !fs.existsSync(p)) return null;
  const rows = fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const posts = rows.filter((r) => r.event === "psp_post_start" || r.event === "psp_post_end");
  return {
    path: p,
    runStarts: rows.filter((r) => r.event === "run_start").length,
    pspPosts: posts,
    chargePairs: posts.filter((r) => r.event === "psp_post_start").length,
  };
}

const harPath =
  arg("--har") ||
  process.env.BANDAI_F5_HAR_PATH ||
  path.join(root, "artifacts", "bandai-chrome-browser.har");
const botCapture =
  arg("--bot-capture") ||
  process.env.BANDAI_GE_ISSUER_CAPTURE ||
  (fs.existsSync("/tmp/bandai-ge-issuer-capture.json")
    ? "/tmp/bandai-ge-issuer-capture.json"
    : path.join(os.tmpdir(), "bandai-ge-issuer-capture.json"));
const forensicsPath =
  arg("--forensics") ||
  process.env.PAY_FORENSICS_PATH ||
  path.join(os.tmpdir(), "j1m-pay-forensics.jsonl");
const outPath =
  arg("--out") || path.join(root, "artifacts", "bandai-issuer-har-diff.json");

if (!fs.existsSync(harPath)) {
  console.error(`HAR not found: ${harPath}`);
  console.error("Capture first: node executor/scripts/bandai-chrome-har-capture.mjs");
  process.exit(1);
}

const issuers = loadHarIssuers(harPath);
const bot = loadBotCapture(botCapture);
const forensics = loadForensics(forensicsPath);
const primary = issuers[0] || null;

const browserKeys = primary?.fieldKeys || [];
const missingInBrowser = BOT_KEYS.filter((k) => !browserKeys.includes(k));
const extraInBrowser = browserKeys.filter((k) => !BOT_KEYS.includes(k));
const valueDiffs = [];
if (primary?.fields && bot?.fields) {
  for (const k of new Set([...BOT_KEYS, ...browserKeys, ...bot.fieldKeys])) {
    if (/cardNum|cvdNumber/i.test(k)) continue;
    const bv = primary.fields[k];
    const ov = bot.fields[k];
    if (bv == null && ov == null) continue;
    if (String(bv ?? "") !== String(ov ?? "")) {
      valueDiffs.push({
        key: k,
        browser: bv == null ? null : redactVal(k, bv),
        bot: ov == null ? null : redactVal(k, ov),
      });
    }
  }
}

const report = {
  at: new Date().toISOString(),
  harPath,
  botCapture: fs.existsSync(botCapture) ? botCapture : null,
  forensicsPath: fs.existsSync(forensicsPath) ? forensicsPath : null,
  verdict: {
    browserIssuerPosts: issuers.length,
    botCountedPspPosts: forensics?.chargePairs ?? null,
    note:
      issuers.length === 1
        ? "Browser HAR shows a single HandleCreditCard POST — dual Revolut is bot-path specific, not GE always-dual."
        : issuers.length === 0
          ? "No HandleCreditCard in HAR — capture may have failed before pay."
          : `Browser HAR shows ${issuers.length} HandleCreditCard POSTs — dual-rail also exists in Chromium for this run.`,
  },
  browserIssuers: issuers.map((i) => ({
    idx: i.idx,
    started: i.started,
    status: i.status,
    mode: i.mode,
    url: i.url,
    headers: i.headers,
    fields: Object.fromEntries(
      Object.entries(i.fields).map(([k, v]) => [k, redactVal(k, v)]),
    ),
  })),
  schemaVsBotBuilder: {
    botExpectedKeys: BOT_KEYS,
    browserKeys,
    missingInBrowser,
    extraInBrowser,
  },
  botCaptureSummary: bot
    ? {
        url: bot.url,
        fieldKeys: bot.fieldKeys,
        fields: bot.fields
          ? Object.fromEntries(Object.entries(bot.fields).map(([k, v]) => [k, redactVal(k, v)]))
          : null,
      }
    : null,
  valueDiffsVsBotCapture: valueDiffs,
  forensics,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`Browser HandleCreditCard posts: ${issuers.length}`);
console.log(`Bot forensics psp_post_start count: ${forensics?.chargePairs ?? "n/a"}`);
console.log(`Keys missing in browser vs bot builder: ${missingInBrowser.join(", ") || "(none)"}`);
console.log(`Keys extra in browser vs bot builder: ${extraInBrowser.join(", ") || "(none)"}`);
if (primary) {
  console.log("Browser createTransaction:", primary.fields["PaymentData.createTransaction"]);
  console.log("Browser gatewayId:", primary.fields["PaymentData.gatewayId"]);
  console.log("Browser paymentMethodId:", primary.fields["PaymentData.paymentMethodId"]);
  console.log("Browser language:", primary.fields["PaymentData.customerLanguage"]);
  console.log("Browser screen:", {
    w: primary.fields["PaymentData.customerScreenWidth"],
    h: primary.fields["PaymentData.customerScreenHeight"],
    depth: primary.fields["PaymentData.customerScreenColorDepth"],
    tz: primary.fields["PaymentData.customerTimeZoneOffset"],
  });
  console.log("Browser headers:", primary.headers);
}
console.log(`report → ${outPath}`);
console.log(report.verdict.note);
