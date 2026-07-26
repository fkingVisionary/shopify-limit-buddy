#!/usr/bin/env node
/**
 * Hybrid: Hyper undici warm → inject cookies into headed Chrome → click ATC.
 * Use when HTTP Cart-AddProduct stays Akamai 403 after abckValid.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createJar, makeDispatcher } from "../http.js";
import { createDisneySession, DISNEY_ORIGIN, DISNEY_DEFAULT_PDP_PATH } from "../adapters/disney-session.js";
import { warmDisneyAkamai, refreshDisneyAkamai } from "../adapters/disney-akamai.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { hyperConfigured } from "../antibot.js";
import {
  capsolverKey,
  solveDisneyRecaptchaEnterprise,
} from "../adapters/disney-recaptcha.js";
import { DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY } from "../adapters/disney-session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnv() {
  for (const rel of ["../.env.local", ".env.local"]) {
    try {
      for (const line of fs.readFileSync(path.join(ROOT, rel), "utf8").split(/\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      /* ignore */
    }
  }
}

function loadProxy() {
  if (process.env.PROXY) return process.env.PROXY.trim();
  return fs
    .readFileSync(path.join(ROOT, "resi.proxies"), "utf8")
    .split(/\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && /^\d/.test(l));
}

function parseProxy(raw) {
  const [host, port, user, ...pass] = String(raw).split(":");
  return {
    server: `http://${host}:${port}`,
    username: user,
    password: pass.join(":"),
    url: `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`,
  };
}

loadEnv();
if (!hyperConfigured()) {
  console.error("HYPER_API_KEY missing");
  process.exit(2);
}

const proxyRaw = loadProxy();
const proxy = parseProxy(proxyRaw);
const pdpUrl = process.env.DISNEY_PDP || `${DISNEY_ORIGIN}${DISNEY_DEFAULT_PDP_PATH}`;
const outDir = process.env.DISNEY_OUT || `/tmp/disney-hybrid-${Date.now()}`;
fs.mkdirSync(outDir, { recursive: true });

const jar = createJar();
const dispatcher = makeDispatcher(proxy.url);
const ctx = { jar, dispatcher, steps: [] };
const tStep = async (name, fn) => {
  const t0 = Date.now();
  try {
    const out = await fn();
    const row = { step: name, ok: out?.ok !== false, ms: Date.now() - t0, note: out?.note, status: out?.status ?? null };
    ctx.steps.push(row);
    console.log(`${row.ok ? "✓" : "✗"} ${name} ${row.note || ""}`);
    return out;
  } catch (e) {
    const row = { step: name, ok: false, ms: Date.now() - t0, note: e.message };
    ctx.steps.push(row);
    console.log(`✗ ${name} ${row.note}`);
    return row;
  }
};

const session = createDisneySession(ctx, {});
ctx.egressIp = await resolveEgressIp(ctx);
console.log("egress", ctx.egressIp, "capsolver", Boolean(capsolverKey()));

const warm = await warmDisneyAkamai(session, ctx, { tStep, egressIp: ctx.egressIp, maxRounds: 6 });
if (!warm.ok) {
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ ok: false, warm, steps: ctx.steps }, null, 2));
  await dispatcher.close?.();
  process.exit(1);
}
await refreshDisneyAkamai(session, ctx, { tStep, pageUrl: pdpUrl, maxRounds: 2, label: "akamai_pdp" });

const dump = jar.dump();
const cookies = Object.entries(dump).map(([name, value]) => ({
  name,
  value,
  domain: name.startsWith("_") || name.startsWith("bm_") || name === "ak_bmsc" ? ".disneystore.com.au" : "www.disneystore.com.au",
  path: "/",
  secure: true,
}));

let capToken = null;
if (capsolverKey()) {
  const solved = await solveDisneyRecaptchaEnterprise({
    pageUrl: pdpUrl,
    sitekey: DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
    action: "AddToCart",
    proxyless: true,
  });
  console.log("capsolver", solved.ok, solved.via, solved.elapsedMs);
  if (solved.ok) capToken = solved.token;
}

const browser = await chromium.launch({
  headless: false,
  channel: "chrome",
  args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
});
const context = await browser.newContext({
  proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
  locale: "en-AU",
  viewport: { width: 1280, height: 900 },
  recordHar: { path: path.join(outDir, "hybrid.har"), mode: "full", content: "embed" },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
await context.addCookies(cookies);
const page = await context.newPage();

await tStep("browser_home", async () => {
  const res = await page.goto(`${DISNEY_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2000);
  const denied = (await page.content()).includes("Access Denied");
  return { ok: res.ok() && !denied, status: res.status(), note: `status=${res.status()} denied=${denied}` };
});

await tStep("browser_pdp", async () => {
  const res = await page.goto(pdpUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3000);
  return { ok: res.ok(), status: res.status(), note: `status=${res.status()}` };
});

if (capToken) {
  await page.evaluate((token) => {
    window.__DISNEY_CAP_TOKEN = token;
    const patch = () => {
      if (!window.grecaptcha?.enterprise?.execute) return false;
      window.grecaptcha.enterprise.execute = async () => token;
      return true;
    };
    if (!patch()) {
      const iv = setInterval(() => patch() && clearInterval(iv), 200);
      setTimeout(() => clearInterval(iv), 15000);
    }
    if (window.$?.ajax) {
      const prev = window.$.ajax;
      window.$.ajax = function (opts) {
        if (/Google-reCaptchaEnterprise/i.test(opts?.url || "")) {
          const d = window.$.Deferred();
          setTimeout(() => d.resolve({ result: true, success: true }), 5);
          return d.promise();
        }
        return prev.apply(this, arguments);
      };
    }
  }, capToken);
}

const atc = await tStep("browser_atc", async () => {
  const btn = page.locator("button.primary-add-to-cart:not([disabled])").first();
  const wait = page
    .waitForResponse((r) => /Cart-AddProduct/i.test(r.url()) && r.request().method() === "POST", {
      timeout: 45000,
    })
    .catch(() => null);
  await btn.click({ timeout: 15000 });
  const res = await wait;
  await page.waitForTimeout(2000);
  if (!res) return { ok: false, note: "no Cart-AddProduct" };
  const text = await res.text().catch(() => "");
  const denied = /Access Denied/i.test(text);
  let jsonOk = false;
  try {
    const j = JSON.parse(text);
    jsonOk = !j.error;
  } catch {
    jsonOk = res.status() < 400 && !denied;
  }
  return {
    ok: res.status() < 400 && !denied && jsonOk,
    status: res.status(),
    note: `Cart-AddProduct ${res.status()} denied=${denied} bytes=${text.length}`,
  };
});

await tStep("browser_bag", async () => {
  const res = await page.goto(`${DISNEY_ORIGIN}/bag`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);
  const html = await page.content();
  const empty = /bag is empty|minibag__empty/i.test(html);
  return { ok: res.ok() && !empty, status: res.status(), note: `status=${res.status()} empty=${empty}` };
});

await context.close();
await browser.close();
await dispatcher.close?.();

const summary = { ok: Boolean(atc.ok), steps: ctx.steps, warm: warm.note, outDir };
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
