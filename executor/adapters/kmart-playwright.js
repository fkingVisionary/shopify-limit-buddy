// Kmart AU — Playwright fallback lane.
//
// Runs a real Chromium via Playwright and lets `hyper-sdk-playwright`
// auto-handle Akamai sensor / SBSD challenges. Purpose: absolute backup
// when the raw-HTTP kmart adapter is blocked by Akamai (typically the
// api.kmart.com.au api-host `_abck` seeding that raw HTTP can't reproduce).
//
// Scope of this adapter (v1): dry-run recon only.
//   home → PDP → cart-add (real button click) → checkout page load
// Return: same {ok, steps, finalUrl, cookies} shape as kmart.js so the
// server layer treats it interchangeably.
//
// Enabled per-task via `kmartMode: "playwright"`.

let _playwright = null;
let _hyperPw = null;
let _hyperSdk = null;
async function loadDeps() {
  if (!_playwright) _playwright = await import("playwright");
  if (!_hyperPw) _hyperPw = await import("hyper-sdk-playwright");
  if (!_hyperSdk) _hyperSdk = await import("hyper-sdk-js");
  return { playwright: _playwright, hyperPw: _hyperPw, hyperSdk: _hyperSdk };
}

const UA_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

// Parse "user:pass@host:port" | "host:port" | "http://user:pass@host:port"
// into the shape Playwright's launch({proxy}) wants.
// Accepts:
//   http(s)://user:pass@host:port
//   user:pass@host:port
//   host:port
//   host:port:user:pass       (common residential-provider format)
//   host:port:user:pass:extra (e.g. sticky-session token appended to pass)
function parseProxy(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // host:port:user:pass[:...] — no scheme, no `@`, 4+ colon-parts
  if (!/^https?:\/\//i.test(s) && !s.includes("@")) {
    const parts = s.split(":");
    if (parts.length >= 4) {
      const [host, port, user, ...rest] = parts;
      return {
        server: `http://${host}:${port || "80"}`,
        username: user,
        password: rest.join(":"),
      };
    }
  }

  const withScheme = /^https?:\/\//i.test(s) ? s : "http://" + s;
  try {
    const u = new URL(withScheme);
    const out = { server: `http://${u.hostname}:${u.port || "80"}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return null;
  }
}

function maskProxy(proxy, rawLen) {
  if (!proxy) return `parsed=false rawLen=${rawLen}`;
  const user = proxy.username ? `${proxy.username.slice(0, 3)}…` : "(no-auth)";
  return `parsed=true server=${proxy.server} user=${user} rawLen=${rawLen}`;
}

function extractSkuFromUrl(pdpUrl) {
  const m = String(pdpUrl).match(/-(\d{6,9})(?:\/|\?|#|$)/);
  return m ? m[1] : null;
}

const now = () => Date.now();
function step(steps, name, ok, note) {
  steps.push({ step: name, ok, ms: now(), note });
}

async function run(task, _ctx) {
  const steps = [];
  const t0 = now();
  const dryRun = task.dryRun !== false;
  const storeUrl = String(task.storeUrl || "").replace(/\/$/, "");
  const origin = "https://www.kmart.com.au";

  const apiKey = process.env.HYPER_API_KEY;
  if (!apiKey) {
    step(steps, "antibot_misconfigured", false, "HYPER_API_KEY missing on executor");
    return { ok: false, steps, finalUrl: storeUrl, cookies: {}, dryRun };
  }

  let browser = null;
  try {
    const { playwright, hyperPw, hyperSdk } = await loadDeps();
    step(steps, "deps_loaded", true, "playwright + hyper-sdk-playwright ready");

    const proxy = parseProxy(task.proxy);
    // NOTE: `channel: 'chrome'` requires the Google Chrome binary at
    // /opt/google/chrome — the Playwright base image ships that. Fall back
    // to bundled chromium if launch fails.
    const launchOpts = {
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
      ...(proxy ? { proxy } : {}),
    };
    try {
      browser = await playwright.chromium.launch({ channel: "chrome", ...launchOpts });
      step(steps, "browser_launch", true, `channel=chrome proxy=${Boolean(proxy)}`);
    } catch (e) {
      browser = await playwright.chromium.launch(launchOpts);
      step(steps, "browser_launch", true, `channel=bundled proxy=${Boolean(proxy)} note=${e?.message?.slice(0, 80)}`);
    }

    const context = await browser.newContext({
      userAgent: UA_WIN,
      locale: "en-AU",
      timezoneId: "Australia/Sydney",
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { "accept-language": "en-AU,en;q=0.9" },
    });

    // Resolve egress IP for the Hyper session context.
    let ipAddress = "1.1.1.1";
    try {
      const ipPage = await context.newPage();
      const r = await ipPage.goto("https://api.ipify.org?format=json", { timeout: 15_000 });
      if (r?.ok()) {
        const j = await r.json();
        if (j?.ip) ipAddress = j.ip;
      }
      await ipPage.close();
      step(steps, "egress_ip", true, ipAddress);
    } catch (e) {
      step(steps, "egress_ip", false, e?.message?.slice(0, 120) ?? "failed");
    }

    const session = new hyperSdk.Session(apiKey);
    const akamai = new hyperPw.AkamaiHandler({
      session,
      ipAddress,
      userAgent: UA_WIN,
      acceptLanguage: "en-AU,en;q=0.9",
    });

    const page = await context.newPage();
    await akamai.initialize(page, context);
    step(steps, "akamai_handler_ready", true, "sensor+sbsd interceptors installed");

    // 1) Warm home.
    const homeRes = await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    step(steps, "warm_home", homeRes?.ok() ?? false, `status=${homeRes?.status()}`);
    await page.waitForTimeout(1500 + Math.random() * 1500);

    // 2) PDP.
    const pdpUrl = /^https?:\/\//i.test(storeUrl) ? storeUrl : `${origin}/`;
    const pdpRes = await page.goto(pdpUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const pdpStatus = pdpRes?.status() ?? 0;
    step(steps, "pdp_get", pdpStatus < 400, `status=${pdpStatus} url=${page.url()}`);

    const sku = extractSkuFromUrl(page.url()) ?? extractSkuFromUrl(pdpUrl);
    step(steps, "pdp_sku", Boolean(sku), sku ?? "sku not found in URL");

    // 3) Add-to-cart: click the real button so browser executes Kmart's own
    // GraphQL mutation from the page context. Selector is intentionally
    // permissive — Kmart's markup shifts.
    let cartOk = false;
    try {
      const btn = page.locator(
        'button:has-text("Add to cart"), button:has-text("ADD TO CART"), [data-testid*="add-to-cart" i]'
      ).first();
      await btn.waitFor({ state: "visible", timeout: 15_000 });
      await btn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400 + Math.random() * 600);
      await btn.click();
      // Wait briefly for the mini-cart / GraphQL round trip.
      await page.waitForTimeout(2500);
      cartOk = true;
      step(steps, "cart_add_click", true, "clicked add-to-cart");
    } catch (e) {
      step(steps, "cart_add_click", false, e?.message?.slice(0, 160) ?? "click failed");
    }

    // 4) Checkout page (dry-run stops here).
    if (cartOk) {
      const coRes = await page.goto(`${origin}/checkout`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const coStatus = coRes?.status() ?? 0;
      step(steps, "checkout_page", coStatus < 400, `status=${coStatus} url=${page.url()}`);
    }

    const finalUrl = page.url();
    const jarArr = await context.cookies();
    const cookies = Object.fromEntries(jarArr.map((c) => [c.name, c.value]));
    const abck = cookies["_abck"] || "";
    const abckValid = /~0~/.test(abck);
    step(steps, "abck_check", abckValid, abckValid ? "_abck valid (~0~)" : `_abck=${abck.slice(0, 60)}…`);

    return {
      ok: true,
      steps,
      finalUrl,
      cookies,
      dryRun,
      trace: { elapsedMs: now() - t0, hyperStatus: akamai.getStatus?.() ?? null },
    };
  } finally {
    try { await browser?.close?.(); } catch { /* ignore */ }
  }
}

export const kmartPlaywrightAdapter = {
  id: "kmart-playwright",
  matches: (host) => host === "www.kmart.com.au" || host === "kmart.com.au",
  run,
};
