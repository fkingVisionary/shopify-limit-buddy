#!/usr/bin/env node
/**
 * Disney Store AU — Playwright HAR capture (guest browse → PDP → ATC → bag → GE).
 *
 * While Hyper allowlist for disneystore.com.au is pending, capture wire via
 * sticky AU ISP + real Chromium (native reCAPTCHA Enterprise on Add to Bag).
 * Optional CapSolver injection if CAPSOLVER_API_KEY is set.
 *
 * Usage:
 *   PROXY='host:port:user:pass' CAPSOLVER_API_KEY=... \
 *     node experiments/disney-isp-capture.mjs
 *
 * Writes full HAR under /tmp/disney-capture-* (not committed).
 * Copies redacted summary into executor/har/disney/.
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISNEY_ORIGIN,
  DISNEY_DEFAULT_PDP_PATH,
  DISNEY_GE_MID,
  DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
} from "../adapters/disney-session.js";
import {
  capsolverKey,
  solveDisneyRecaptchaEnterprise,
} from "../adapters/disney-recaptcha.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = process.env.DISNEY_CAPTURE_DIR || `/tmp/disney-capture-${Date.now()}`;
const HAR_DIR = path.join(ROOT, "har", "disney");

const PDP =
  process.env.DISNEY_PDP || `${DISNEY_ORIGIN}${DISNEY_DEFAULT_PDP_PATH}`;

function loadKeyFromEnvFiles() {
  if (process.env.CAPSOLVER_API_KEY) return;
  for (const rel of ["../.env.local", ".env.local", "../.env", ".env"]) {
    try {
      const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const m = raw.match(/^CAPSOLVER_API_KEY=(.+)$/m);
      if (m) {
        process.env.CAPSOLVER_API_KEY = m[1].trim().replace(/^["']|["']$/g, "");
        return;
      }
    } catch {
      /* ignore */
    }
  }
}

function loadProxyRaw() {
  if (process.env.PROXY || process.env.PROXY_URL || process.env.PROXY_LINE) {
    return String(process.env.PROXY || process.env.PROXY_URL || process.env.PROXY_LINE).trim();
  }
  try {
    const lines = fs
      .readFileSync(path.join(ROOT, "resi.proxies"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && /^\d/.test(l));
    return lines[0] || null;
  } catch {
    return null;
  }
}

function parseProxy(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    return {
      server: `${u.protocol}//${u.hostname}:${u.port || "80"}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  }
  const parts = s.split(":");
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    return {
      server: `http://${parts[0]}:${parts[1]}`,
      username: parts[2],
      password: parts.slice(3).join(":"),
    };
  }
  return null;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function redact(s) {
  return String(s ?? "")
    .replace(/\b\d{13,19}\b/g, "[PAN]")
    .replace(/(csrf[_a-z]*|token|password|cardNum|cvv)=([^&\s"]+)/gi, "$1=[REDACTED]")
    .replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"[REDACTED]"')
    .replace(/g-recaptcha-response[=:][^&\s"]+/gi, "g-recaptcha-response=[REDACTED]");
}

function summarizeHar(harPath) {
  const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
  const entries = har?.log?.entries || [];
  const hosts = new Set();
  const cookieNames = new Set();
  const interesting = [];
  const milestones = {
    home: null,
    pdp: null,
    csrf: null,
    recaptchaEnterprise: null,
    recaptchaClassic: null,
    atc: null,
    minicart: null,
    bag: null,
    geScriptLoader: null,
    geGetCartToken: null,
    geCheckoutV2: null,
    geSecure: null,
    akamaiSensor: null,
  };

  for (const e of entries) {
    const url = e.request?.url || "";
    const method = e.request?.method || "";
    const status = e.response?.status;
    let host = "";
    let pathname = "";
    try {
      const u = new URL(url);
      host = u.hostname;
      pathname = u.pathname;
      hosts.add(host);
    } catch {
      /* ignore */
    }

    for (const h of e.response?.headers || []) {
      if (String(h.name).toLowerCase() === "set-cookie") {
        const name = String(h.value || "").split("=")[0];
        if (name) cookieNames.add(name);
      }
    }

    const row = {
      method,
      status,
      host,
      path: (pathname + (url.includes("?") ? "?" + url.split("?")[1].slice(0, 80) : "")).slice(0, 200),
      mime: e.response?.content?.mimeType || null,
      postPreview: e.request?.postData?.text
        ? redact(e.request.postData.text).slice(0, 350)
        : null,
    };

    const keep =
      /disneystore\.com\.au|shopdisney|global-e\.com|recaptcha|google\.com\/recaptcha|registerdisney|akamai|edgesuite/i.test(
        host + pathname,
      );
    if (keep) interesting.push(row);

    if (method === "GET" && pathname === "/" && host.includes("disneystore") && !milestones.home) {
      milestones.home = row;
    }
    if (/Cart-AddProduct/i.test(pathname)) milestones.atc = row;
    if (/CSRF-Generate/i.test(pathname)) milestones.csrf = row;
    if (/Google-reCaptchaEnterprise/i.test(pathname)) milestones.recaptchaEnterprise = row;
    if (/Google-reCaptcha(?!Enterprise)/i.test(pathname)) milestones.recaptchaClassic = row;
    if (/Cart-MiniCartShow/i.test(pathname)) milestones.minicart = row;
    if (pathname === "/bag" || pathname.endsWith("/bag")) milestones.bag = row;
    if (/Globale-ScriptLoaderData|clientsdk\/1696/i.test(url)) milestones.geScriptLoader = row;
    if (/Globale-GetCartToken|GetCartToken/i.test(url)) milestones.geGetCartToken = row;
    if (/Checkout\/v2/i.test(url)) milestones.geCheckoutV2 = row;
    if (/secure[-.].*global-e\.com|HandleCreditCard/i.test(url)) milestones.geSecure = row;
    if (/sensor_data|\/_sec\/|akam/i.test(url) || (method === "POST" && /disneystore/.test(host) && pathname.split("/").length >= 5 && !/demandware|Cart-|CSRF|Google|Globale|ocapi/i.test(pathname))) {
      if (!milestones.akamaiSensor && method === "POST") milestones.akamaiSensor = row;
    }
    if (/\.html$/i.test(pathname) && /disneystore/.test(host) && status === 200 && !milestones.pdp) {
      if (pathname !== "/") milestones.pdp = row;
    }
  }

  // Extract GE secure / encoded merchant hints from any URL
  let geEncodedMerchant = null;
  let geSecureHost = null;
  for (const e of entries) {
    const url = e.request?.url || "";
    const m = url.match(/https?:\/\/(secure[-a-z0-9.]*global-e\.com)\/\d+\/Payments\/[^/]+\/([A-Za-z0-9]+)\/([0-9a-f-]{36})/i);
    if (m) {
      geSecureHost = m[1];
      geEncodedMerchant = m[2];
      break;
    }
    const m2 = url.match(/https?:\/\/(secure[-a-z0-9.]*global-e\.com)/i);
    if (m2 && !geSecureHost) geSecureHost = m2[1];
  }

  return {
    capturedAt: new Date().toISOString(),
    entryCount: entries.length,
    hosts: [...hosts].sort(),
    cookieNames: [...cookieNames].sort(),
    geMid: DISNEY_GE_MID,
    geEncodedMerchant,
    geSecureHost,
    recaptchaSitekey: DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
    milestones,
    interesting: interesting.slice(0, 200),
  };
}

async function step(steps, name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const row = { step: name, ok: out?.ok !== false, ms: Date.now() - t0, note: out?.note || null };
    steps.push(row);
    console.log(`${row.ok ? "✓" : "✗"} ${name} (${row.ms}ms) ${row.note || ""}`);
    return out;
  } catch (e) {
    const row = { step: name, ok: false, ms: Date.now() - t0, note: e?.message || String(e) };
    steps.push(row);
    console.log(`✗ ${name} (${row.ms}ms) ${row.note}`);
    return { ok: false, note: row.note };
  }
}

async function main() {
  loadKeyFromEnvFiles();
  ensureDir(OUT_DIR);
  ensureDir(HAR_DIR);

  const proxyRaw = loadProxyRaw();
  const proxy = parseProxy(proxyRaw);
  if (!proxy) {
    console.error("No PROXY — set PROXY=host:port:user:pass or use resi.proxies");
    process.exit(2);
  }

  const harPath = path.join(OUT_DIR, "disney-au.har");
  const steps = [];
  const meta = {
    outDir: OUT_DIR,
    pdp: PDP,
    proxyHost: proxy.server,
    capsolver: Boolean(capsolverKey()),
    hyperNote: "Hyper allowlist pending — browser path for HAR only",
  };
  fs.writeFileSync(path.join(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 2));

  console.log("OUT", OUT_DIR);
  console.log("PROXY", proxy.server, "user=", Boolean(proxy.username));
  console.log("CAPSOLVER", Boolean(capsolverKey()));
  console.log("PDP", PDP);

  // Akamai hard-denies Playwright headless on this host; headed (+ xvfb) works on ISP.
  const headed = process.env.HEADED !== "0";
  const channel = process.env.PW_CHANNEL || (headed ? "chrome" : undefined);
  const browser = await chromium.launch({
    headless: !headed,
    channel,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  // Do NOT override UA — mismatch with sec-ch-ua (e.g. UA 131 vs CH 148) poisons Akamai POST.
  const context = await browser.newContext({
    proxy,
    locale: "en-AU",
    viewport: { width: 1280, height: 900 },
    recordHar: { path: harPath, mode: "full", content: "embed" },
    ignoreHTTPSErrors: true,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  // Track key network
  const netHits = [];
  page.on("response", async (res) => {
    const url = res.url();
    if (
      /Cart-AddProduct|CSRF-Generate|Google-reCaptcha|Globale-|Checkout\/v2|GetCartToken|HandleCreditCard|clientsdk\/1696/i.test(
        url,
      )
    ) {
      netHits.push({ status: res.status(), url: url.slice(0, 220), method: res.request().method() });
    }
  });

  await step(steps, "home", async () => {
    const res = await page.goto(`${DISNEY_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(2500);
    const title = await page.title();
    const denied = /access denied/i.test(title) || (await page.content()).includes("Access Denied");
    return {
      ok: res?.ok() && !denied,
      note: denied ? `denied status=${res?.status()}` : `status=${res?.status()} title=${title.slice(0, 60)}`,
    };
  });

  await step(steps, "pdp", async () => {
    const res = await page.goto(PDP, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(3000);
    const btn = page.locator("button.primary-add-to-cart, button.add-to-cart").first();
    const visible = await btn.isVisible().catch(() => false);
    const pid = await btn.getAttribute("data-pid").catch(() => null);
    const sitekey = await btn.getAttribute("data-sitekey").catch(() => null);
    return {
      ok: res?.ok() && visible,
      note: `status=${res?.status()} btn=${visible} pid=${pid} sitekey=${sitekey ? sitekey.slice(0, 10) + "…" : "none"}`,
      pid,
      sitekey,
    };
  });

  // Human-ish dwell so Akamai BM can grow _abck toward ~0~ without Hyper.
  await step(steps, "akamai_dwell", async () => {
    const deadline = Date.now() + Number(process.env.ABCK_WAIT_MS || 75_000);
    let abck = "";
    let rounds = 0;
    while (Date.now() < deadline) {
      rounds += 1;
      await page.mouse.move(80 + (rounds % 20) * 37, 120 + (rounds % 15) * 29);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(1500);
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(1000);
      const cookies = await context.cookies("https://www.disneystore.com.au/");
      abck = cookies.find((c) => c.name === "_abck")?.value || "";
      if (/~0~/.test(abck)) {
        return { ok: true, note: `abck ~0~ after ${rounds} dwell loops len=${abck.length}` };
      }
      // bounce home once mid-dwell to refresh sensor script
      if (rounds === 8) {
        await page.goto(`${DISNEY_ORIGIN}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
        await page.waitForTimeout(2000);
        await page.goto(PDP, { waitUntil: "domcontentloaded" }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }
    return {
      ok: false,
      note: `abck still unsolved after ${rounds} loops has_-1=${/~-1~/.test(abck)} len=${abck.length} (Hyper allowlist likely required for POST ATC)`,
    };
  });

  // Optional CapSolver pre-solve + inject (helps headless when score fails).
  if (capsolverKey()) {
    await step(steps, "capsolver_enterprise", async () => {
      const solved = await solveDisneyRecaptchaEnterprise({
        pageUrl: PDP,
        sitekey: DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
        action: "AddToCart",
        proxyRaw,
      });
      if (!solved.ok) return { ok: false, note: solved.error };
      // Inject token into verify path by stubbing enterprise.execute
      await page.evaluate(
        ({ token, sitekey }) => {
          window.__DISNEY_CAP_TOKEN = token;
          const patch = () => {
            if (!window.grecaptcha?.enterprise?.execute) return false;
            window.grecaptcha.enterprise.execute = async (key, opts) => {
              console.log("grecaptcha.enterprise.execute patched", key, opts);
              return token;
            };
            return true;
          };
          if (!patch()) {
            const iv = setInterval(() => {
              if (patch()) clearInterval(iv);
            }, 200);
            setTimeout(() => clearInterval(iv), 15000);
          }
          // Also set hidden fields if present
          document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response').forEach((el) => {
            el.value = token;
          });
          void sitekey;
        },
        { token: solved.token, sitekey: DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY },
      );
      return { ok: true, note: `token via ${solved.via} ${solved.elapsedMs}ms` };
    });
  }

  await step(steps, "atc_click", async () => {
    const btn = page.locator("button.primary-add-to-cart:not([disabled]), button.add-to-cart:not([disabled])").first();
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    // Wait for grecaptcha enterprise if present
    await page
      .waitForFunction(() => window.grecaptcha?.enterprise?.execute || window.__DISNEY_CAP_TOKEN, null, {
        timeout: 20_000,
      })
      .catch(() => {});
    const atcWait = page
      .waitForResponse(
        (r) => /Cart-AddProduct/i.test(r.url()) && r.request().method() === "POST",
        { timeout: 45_000 },
      )
      .catch(() => null);
    await btn.click({ timeout: 15_000 });
    const atcRes = await atcWait;
    await page.waitForTimeout(2500);
    if (!atcRes) {
      // Maybe coming soon / modal / captcha fail
      const bodyText = await page.locator("body").innerText().catch(() => "");
      return {
        ok: false,
        note: `no Cart-AddProduct response; snippet=${bodyText.replace(/\s+/g, " ").slice(0, 120)}`,
      };
    }
    const status = atcRes.status();
    let body = "";
    try {
      body = await atcRes.text();
    } catch {
      /* ignore */
    }
    const denied = /Access Denied/i.test(body);
    const jsonOk = (() => {
      try {
        const j = JSON.parse(body);
        return !j.error;
      } catch {
        return status < 400 && !denied;
      }
    })();
    return {
      ok: status < 400 && !denied && jsonOk,
      note: `Cart-AddProduct ${status} denied=${denied} bytes=${body.length}`,
    };
  });

  await step(steps, "bag", async () => {
    const res = await page.goto(`${DISNEY_ORIGIN}/bag`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(3000);
    const html = await page.content();
    const empty = /minibag__empty|your bag is empty|bag is empty/i.test(html);
    const hasLine = /data-pid=|cart__|bag__product|product-line/i.test(html);
    return {
      ok: res?.ok() && (hasLine || !empty),
      note: `status=${res?.status()} empty=${empty} hasLine=${hasLine}`,
    };
  });

  await step(steps, "ge_checkout_click", async () => {
    // Try common Disney/GE checkout CTAs
    const selectors = [
      'a[href*="checkout"]',
      'button:has-text("Checkout")',
      'button:has-text("Check Out")',
      'a:has-text("Checkout")',
      'button:has-text("Continue")',
      "#globalecheckout",
      ".ge-checkout",
      '[data-globale]',
      'iframe[src*="global-e"]',
    ];
    let clicked = false;
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        const geWait = page
          .waitForResponse(
            (r) => /Globale-GetCartToken|Checkout\/v2|clientsdk\/1696|GetCartToken/i.test(r.url()),
            { timeout: 30_000 },
          )
          .catch(() => null);
        await loc.click({ timeout: 10_000 }).catch(() => {});
        clicked = true;
        const geRes = await geWait;
        await page.waitForTimeout(4000);
        // frames?
        const frames = page.frames().map((f) => f.url()).filter((u) => /global-e/i.test(u));
        return {
          ok: Boolean(geRes || frames.length),
          note: `clicked=${sel} geRes=${geRes ? geRes.status() + " " + geRes.url().slice(0, 80) : "none"} frames=${frames.length}`,
          frames,
        };
      }
    }
    // Soft probe SFCC GE token endpoint from page context
    const probe = await page
      .evaluate(async () => {
        try {
          const r = await fetch(
            "/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/Globale-GetCartToken",
            { credentials: "same-origin", headers: { "x-requested-with": "XMLHttpRequest" } },
          );
          const t = await r.text();
          return { status: r.status, bytes: t.length, head: t.slice(0, 200) };
        } catch (e) {
          return { error: String(e) };
        }
      })
      .catch((e) => ({ error: e.message }));
    return {
      ok: false,
      note: `no checkout CTA visible; clicked=${clicked}; probe=${JSON.stringify(probe).slice(0, 180)}`,
    };
  });

  // Persist cookies (names + truncated values)
  const cookies = await context.cookies();
  const cookieSummary = cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    valuePrefix: String(c.value || "").slice(0, 12),
    valueLen: String(c.value || "").length,
  }));

  await context.close();
  await browser.close();

  // HAR is flushed on context close
  const summary = summarizeHar(harPath);
  summary.steps = steps;
  summary.netHits = netHits;
  summary.egressProxy = proxy.server;
  summary.capsolverConfigured = Boolean(capsolverKey());

  fs.writeFileSync(path.join(OUT_DIR, "steps.json"), JSON.stringify(steps, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "cookies.json"), JSON.stringify(cookieSummary, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "net-hits.json"), JSON.stringify(netHits, null, 2));

  // Copy redacted artifacts into repo har/disney (no full HAR)
  fs.writeFileSync(path.join(HAR_DIR, "isp-capture-summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(HAR_DIR, "isp-capture-steps.json"), JSON.stringify(steps, null, 2));
  fs.writeFileSync(path.join(HAR_DIR, "isp-capture-cookies.json"), JSON.stringify(cookieSummary, null, 2));

  console.log("\n=== DONE ===");
  console.log("HAR", harPath, "bytes", fs.statSync(harPath).size);
  console.log("milestones", JSON.stringify(summary.milestones, null, 2));
  console.log(
    "ok steps",
    steps.filter((s) => s.ok).map((s) => s.step).join(", "),
  );
  console.log(
    "fail steps",
    steps.filter((s) => !s.ok).map((s) => s.step + ": " + s.note).join(" | ") || "none",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
