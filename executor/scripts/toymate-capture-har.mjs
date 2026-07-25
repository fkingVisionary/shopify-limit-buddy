#!/usr/bin/env node
// Capture a Chromium HAR: Toymate login → PDP → ATC → checkout (no place-order).
// CapSolver: 1 CF solve. Uses vault account + sticky Noontide proxy.
//
// Usage:
//   CAPSOLVER_API_KEY=... ACCOUNT_EMAIL=... ACCOUNT_PASS=... \
//   node scripts/toymate-capture-har.mjs [pdpUrl]
//
// Outputs:
//   OUT_HAR   (default /tmp/toymate-login-atc-checkout.har) — full HAR (local only)
//   OUT_SUM   (default /tmp/toymate-har-summary.json) — redacted request index

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { makeDispatcher, createJar, request, UA } from "../http.js";
import {
  looksLikeCfChallenge,
  solveCloudflareChallenge,
} from "../adapters/toymate-cf-solve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadKey() {
  if (process.env.CAPSOLVER_API_KEY) return;
  try {
    const raw = fs.readFileSync(path.join(ROOT, "..", ".env.local"), "utf8");
    const m = raw.match(/^CAPSOLVER_API_KEY=(.+)$/m);
    if (m) process.env.CAPSOLVER_API_KEY = m[1].trim();
  } catch {
    /* ignore */
  }
}

function mintProxyRaw() {
  if (process.env.PROXY_LINE) return process.env.PROXY_LINE.trim();
  const local = path.join(ROOT, "noontide.proxies.local");
  if (!fs.existsSync(local)) return null;
  const lines = fs
    .readFileSync(local, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return lines[0]?.replace(/session-[^-]+/, `session-${stamp}`) || null;
}

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const [host, port, user, ...pass] = raw.split(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
}

function toPwProxy(proxyUrl) {
  if (!proxyUrl) return null;
  const u = new URL(proxyUrl);
  return {
    server: `${u.protocol}//${u.hostname}:${u.port || "80"}`,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

function summarizeHar(har) {
  const entries = har?.log?.entries || [];
  const interesting = entries
    .map((e, i) => {
      const url = e.request?.url || "";
      const u = (() => {
        try {
          return new URL(url);
        } catch {
          return null;
        }
      })();
      const host = u?.hostname || "";
      const pathName = u?.pathname || "";
      const keep =
        /toymate\.com\.au|bigcommerce\.com|adyen|paypal|google\.com\/recaptcha|payments\./i.test(
          host + pathName,
        );
      if (!keep) return null;
      const reqHeaders = Object.fromEntries(
        (e.request?.headers || [])
          .filter((h) =>
            /content-type|accept|origin|referer|x-xsrf|x-api|authorization|x-requested/i.test(
              h.name,
            ),
          )
          .map((h) => [h.name.toLowerCase(), String(h.value || "").slice(0, 120)]),
      );
      let postPreview = null;
      const post = e.request?.postData?.text;
      if (post) {
        postPreview = String(post)
          .replace(/password[=:][^&\s"]+/gi, "password=***")
          .replace(/login_pass[=:][^&\s"]+/gi, "login_pass=***")
          .replace(/"number"\s*:\s*"[^"]+"/gi, '"number":"***"')
          .replace(/encrypted[A-Za-z]+":"[^"]+"/g, (m) => m.split(":")[0] + ':"***"')
          .slice(0, 400);
      }
      return {
        i,
        method: e.request?.method,
        status: e.response?.status,
        host,
        path: pathName + (u?.search || "").slice(0, 120),
        mime: e.response?.content?.mimeType || null,
        reqHeaders,
        postPreview,
        started: e.startedDateTime,
      };
    })
    .filter(Boolean);

  const milestones = {
    loginPost: interesting.find(
      (x) => x.method === "POST" && /login\.php.*check_login|action=check_login/i.test(x.path),
    ),
    cartApi: interesting.find(
      (x) => /\/api\/storefront\/carts/i.test(x.path) && x.method === "POST",
    ),
    cartRemoteAdd: interesting.find(
      (x) => /\/remote\/v1\/cart\/add/i.test(x.path) && x.method === "POST",
    ),
    cartPhp: interesting.find((x) => /\/cart\.php/i.test(x.path) && x.method === "POST"),
    checkoutGet: interesting.find(
      (x) => x.method === "GET" && /\/checkout\/?$/i.test(x.path.split("?")[0]),
    ),
    paymentsGet: interesting.find((x) => /\/api\/storefront\/payments/i.test(x.path)),
    consignments: interesting.find((x) => /consignments/i.test(x.path)),
    billing: interesting.find((x) => /billing-address/i.test(x.path)),
  };

  return {
    capturedAt: new Date().toISOString(),
    entryCount: entries.length,
    interestingCount: interesting.length,
    milestones: Object.fromEntries(
      Object.entries(milestones).map(([k, v]) => [
        k,
        v
          ? { method: v.method, status: v.status, path: v.path, i: v.i }
          : null,
      ]),
    ),
    entries: interesting,
  };
}

loadKey();
if (!process.env.CAPSOLVER_API_KEY) {
  console.error("CAPSOLVER_API_KEY missing");
  process.exit(1);
}

const email = process.env.ACCOUNT_EMAIL || "proof3+mrv40gx11rzw@bullposted.com";
const password = process.env.ACCOUNT_PASS || "Password1";
const pdpUrl =
  process.argv[2] ||
  process.env.PDP_URL ||
  "https://toymate.com.au/products.php?productId=53116";
const OUT_HAR = process.env.OUT_HAR || "/tmp/toymate-login-atc-checkout.har";
const OUT_SUM = process.env.OUT_SUM || "/tmp/toymate-har-summary.json";
const ARTIFACT_SUM =
  process.env.ARTIFACT_SUM ||
  "/opt/cursor/artifacts/toymate-har-summary.json";

const proxyRaw = mintProxyRaw();
const proxyUrl = toProxyUrl(proxyRaw);
const pwProxy = toPwProxy(proxyUrl);

console.log(
  JSON.stringify({
    phase: "start",
    email,
    pdp: pdpUrl,
    outHar: OUT_HAR,
    outSum: OUT_SUM,
    proxyHost: proxyUrl ? new URL(proxyUrl).hostname : null,
  }),
);

// ── CF warm via undici (same sticky proxy) ───────────────────────────
const dispatcher = makeDispatcher(proxyUrl, { forceUndici: true });
const jar = createJar();
const ctx = { dispatcher, jar };
let solvedUa = UA;
try {
  let res = await request(
    "https://www.toymate.com.au/login.php",
    { headers: { "user-agent": UA, accept: "text/html" } },
    ctx,
  );
  let html = await res.text();
  console.log(
    JSON.stringify({
      phase: "warm",
      status: res.status,
      bytes: html.length,
      cf: looksLikeCfChallenge(html, res.status),
    }),
  );
  if (looksLikeCfChallenge(html, res.status)) {
    const solved = await solveCloudflareChallenge({
      pageUrl: "https://www.toymate.com.au/login.php",
      html,
      proxyRaw: proxyUrl,
      userAgent: UA,
    });
    console.log(
      JSON.stringify({
        phase: "cf_solve",
        ok: solved.ok,
        err: solved.error || null,
        cookies: Object.keys(solved.cookies || {}),
      }),
    );
    if (!solved.ok) process.exit(3);
    for (const [k, v] of Object.entries(solved.cookies || {})) jar.set(k, String(v));
    if (solved.userAgent) solvedUa = solved.userAgent;
  }
} finally {
  try {
    await dispatcher.close?.();
  } catch {
    /* ignore */
  }
}

const dump = jar.dump();
const cookieList = Object.entries(dump).map(([name, value]) => ({
  name,
  value: String(value),
  domain: ".toymate.com.au",
  path: "/",
  secure: true,
  httpOnly: false,
  sameSite: "Lax",
}));

// ── Playwright HAR capture ───────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT_HAR), { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  recordHar: { path: OUT_HAR, mode: "full", content: "embed" },
  userAgent: solvedUa,
  locale: "en-AU",
  viewport: { width: 1280, height: 900 },
  ...(pwProxy ? { proxy: pwProxy } : {}),
});
if (cookieList.length) await context.addCookies(cookieList);
const page = await context.newPage();
const steps = [];

async function step(label, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    steps.push({ step: label, ok: true, ms: Date.now() - t0, note: note || null });
    console.log(JSON.stringify({ phase: "step", step: label, ok: true, note: note || null }));
  } catch (e) {
    steps.push({
      step: label,
      ok: false,
      ms: Date.now() - t0,
      note: e?.message || String(e),
    });
    console.log(
      JSON.stringify({
        phase: "step",
        step: label,
        ok: false,
        note: e?.message || String(e),
      }),
    );
    throw e;
  }
}

try {
  await step("home", async () => {
    const res = await page.goto("https://toymate.com.au/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const title = await page.title();
    if (/just a moment/i.test(title)) throw new Error(`CF still challenging: ${title}`);
    return `${res?.status()} ${title}`.slice(0, 80);
  });

  await step("login_page", async () => {
    const res = await page.goto("https://toymate.com.au/login.php", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForSelector('input[name="login_email"], #login_email', {
      timeout: 20_000,
    });
    return `status=${res?.status()}`;
  });

  await step("login_submit", async () => {
    const form = page.locator('form[action*="check_login"], form:has(input[name="login_email"])').first();
    await form.locator('input[name="login_email"]').fill(email);
    await form.locator('input[name="login_pass"]').fill(password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null),
      form.locator('input.account-login-button, input[type="submit"][value*="Log" i]').click(),
    ]);
    const url = page.url();
    if (/login\.php$/i.test(url) && !/account|check_login/i.test(url)) {
      const loggedIn = await page.locator('a[href*="account.php"], a[href*="logout"]').count();
      if (!loggedIn) throw new Error(`login may have failed url=${url}`);
    }
    return url;
  });

  await step("pdp", async () => {
    const res = await page.goto(pdpUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(1500);
    return `status=${res?.status()} url=${page.url().slice(0, 80)}`;
  });

  await step("atc", async () => {
    // Prefer visible Add to Cart; fall back to form submit / storefront fetch from page.
    const candidates = [
      'input[type="submit"][value*="Add" i]',
      'button:has-text("Add to Cart")',
      'button:has-text("Add to bag")',
      "#form-action-addToCart",
      '[data-button-type="add-cart"]',
      "form[action*='cart.php'] button",
      "form[action*='cart.php'] input[type=submit]",
    ];
    let clicked = false;
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        try {
          await Promise.all([
            page
              .waitForResponse(
                (r) =>
                  /cart|storefront\/carts/i.test(r.url()) &&
                  r.request().method() !== "OPTIONS",
                { timeout: 20_000 },
              )
              .catch(() => null),
            loc.click({ timeout: 5000 }),
          ]);
          clicked = true;
          break;
        } catch {
          /* try next */
        }
      }
    }
    if (!clicked) {
      // Fallback: classic cart.php POST from page context using productId in URL.
      const pid =
        new URL(page.url()).searchParams.get("productId") ||
        (await page.getAttribute("[data-product-id]", "data-product-id"));
      if (!pid) throw new Error("ATC control not found and no productId");
      const result = await page.evaluate(async (productId) => {
        const body = new URLSearchParams({
          action: "add",
          product_id: String(productId),
          "qty[]": "1",
        });
        const res = await fetch("/cart.php", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-requested-with": "XMLHttpRequest",
          },
          body: body.toString(),
          credentials: "include",
          redirect: "follow",
        });
        return { status: res.status, url: res.url, bytes: (await res.text()).length };
      }, pid);
      return `fallback cart.php ${JSON.stringify(result)}`;
    }
    await page.waitForTimeout(2000);
    return `clicked ATC url=${page.url().slice(0, 100)}`;
  });

  await step("cart_page", async () => {
    const res = await page.goto("https://toymate.com.au/cart.php", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const text = await page.locator("body").innerText().catch(() => "");
    const empty = /cart is empty|your cart.*empty/i.test(text);
    return `status=${res?.status()} empty=${empty} bytes=${text.length}`;
  });

  await step("checkout", async () => {
    const res = await page.goto("https://toymate.com.au/checkout", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    // Let checkout-js load payment methods / address forms.
    await page.waitForTimeout(8000);
    const title = await page.title();
    const hasPayment = await page
      .locator('text=/Credit Card|PayPal|Zip|payment/i')
      .count()
      .catch(() => 0);
    const hasAddress = await page
      .locator('input[name*="address"], input[id*="address"], text=/Shipping|Billing/i')
      .count()
      .catch(() => 0);
    return `status=${res?.status()} title=${title.slice(0, 40)} paymentHints=${hasPayment} addressHints=${hasAddress}`;
  });

  // Stop before place-order / card entry — HAR should include checkout bootstrap + payment methods.
  console.log(JSON.stringify({ phase: "capture_done", steps }));
} catch (e) {
  console.log(
    JSON.stringify({
      phase: "capture_error",
      error: e?.message || String(e),
      steps,
    }),
  );
} finally {
  await context.close(); // flushes HAR
  await browser.close();
}

if (!fs.existsSync(OUT_HAR)) {
  console.error("HAR was not written");
  process.exit(4);
}

const har = JSON.parse(fs.readFileSync(OUT_HAR, "utf8"));
const summary = {
  ...summarizeHar(har),
  steps,
  pdpUrl,
  email,
  harBytes: fs.statSync(OUT_HAR).size,
  harPath: OUT_HAR,
};
fs.writeFileSync(OUT_SUM, JSON.stringify(summary, null, 2));
try {
  fs.mkdirSync(path.dirname(ARTIFACT_SUM), { recursive: true });
  fs.writeFileSync(ARTIFACT_SUM, JSON.stringify(summary, null, 2));
  // Also copy HAR into artifacts for local agent use (gitignored / not committed).
  fs.copyFileSync(OUT_HAR, "/opt/cursor/artifacts/toymate-login-atc-checkout.har");
} catch {
  /* artifacts path optional */
}

console.log(
  JSON.stringify({
    phase: "done",
    harBytes: summary.harBytes,
    entryCount: summary.entryCount,
    interestingCount: summary.interestingCount,
    milestones: summary.milestones,
    outHar: OUT_HAR,
    outSum: OUT_SUM,
  }),
);

const okLogin = steps.some((s) => s.step === "login_submit" && s.ok);
const okAtc = steps.some((s) => s.step === "atc" && s.ok);
const okCheckout = steps.some((s) => s.step === "checkout" && s.ok);
process.exit(okLogin && okAtc && okCheckout ? 0 : 5);
