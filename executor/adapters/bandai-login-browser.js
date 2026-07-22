// Narrow Playwright login for Premium Bandai AU.
// HTTP POST /login returns F5 "PAGE NOT AVAILABLE" (501) from undici/tls-worker;
// guest /api/* POSTs still work. Use Chromium only to establish SESSION, then
// hand cookies back to the HTTP jar for ATC/checkout.
//
// Opt-in / fallback — not a catalog/cart Playwright ladder.

import { chromium } from "playwright";

function proxyForPlaywright(rawProxy) {
  if (!rawProxy) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawProxy) ? rawProxy : `http://${rawProxy}`);
  } catch {
    return null;
  }
  return {
    server: `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {string} [opts.proxy]
 * @param {number} [opts.timeoutMs=90000]
 * @returns {Promise<{ok:boolean, cookies?:Record<string,string>, restrictedType?:string|null, finalUrl?:string, error?:string, note?:string}>}
 */
export async function browserLoginBandai(opts = {}) {
  const email = String(opts.email || "").trim();
  const password = String(opts.password || "");
  if (!email || !password) {
    return { ok: false, error: "email_password_required" };
  }

  const proxy = proxyForPlaywright(opts.proxy);
  const timeoutMs = Number(opts.timeoutMs) || 90_000;
  const headless = opts.headless !== false;

  let browser;
  try {
    browser = await chromium.launch({
      headless,
      proxy: proxy || undefined,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      locale: "en-AU",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    let loginResponse = null;
    page.on("response", async (res) => {
      try {
        if (res.request().method() === "POST" && /\/login\/?$/.test(new URL(res.url()).pathname)) {
          loginResponse = {
            status: res.status(),
            restrictedType: res.headers()["x-restricted-type"] || null,
            csrf: res.headers()["x-csrf-token"] || null,
          };
        }
      } catch {
        /* ignore */
      }
    });

    await page.goto("https://p-bandai.com/au/login", {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    // Prefer filling the visible sign-in form; fall back to in-page axios login.
    const emailSel = [
      'input[type="email"]',
      'input[name="mail"]',
      'input[autocomplete="username"]',
      'input[placeholder*="mail" i]',
      'input[id*="mail" i]',
    ];
    const passSel = [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
    ];

    let filled = false;
    for (const es of emailSel) {
      const el = page.locator(es).first();
      if (await el.count().catch(() => 0)) {
        await el.fill(email, { timeout: 10_000 });
        for (const ps of passSel) {
          const pel = page.locator(ps).first();
          if (await pel.count().catch(() => 0)) {
            await pel.fill(password, { timeout: 5_000 });
            filled = true;
            break;
          }
        }
        if (filled) break;
      }
    }

    if (filled) {
      // Submit button — LoginWidget primary CTA
      const submit = page
        .locator(
          'button[type="submit"], button:has-text("Sign In"), button:has-text("SIGN IN"), a:has-text("Sign In")',
        )
        .first();
      if (await submit.count().catch(() => 0)) {
        await Promise.all([
          page.waitForResponse(
            (r) => r.request().method() === "POST" && /\/login\/?$/.test(new URL(r.url()).pathname),
            { timeout: timeoutMs },
          ).catch(() => null),
          submit.click({ timeout: 10_000 }),
        ]);
      } else {
        await page.keyboard.press("Enter");
        await page
          .waitForResponse(
            (r) => r.request().method() === "POST" && /\/login\/?$/.test(new URL(r.url()).pathname),
            { timeout: timeoutMs },
          )
          .catch(() => null);
      }
    } else {
      // DOM form not ready — call the same service the SPA uses if exposed, else fetch in-page.
      loginResponse = await page.evaluate(async ({ email: em, password: pw }) => {
        const body = `grantType=password&memberId=${encodeURIComponent(em)}&password=${encodeURIComponent(pw)}&saveLoginId=false&autoLogin=false`;
        const csrf =
          window.USER_DATA?.csrfToken ||
          document.querySelector('meta[name="csrf-token"]')?.content ||
          "";
        const res = await fetch("/login", {
          method: "POST",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/x-www-form-urlencoded;charset=utf-8",
            "x-g1-area-code": "au",
            "x-requested-with": "XMLHttpRequest",
            ...(csrf ? { "x-csrf-token": csrf } : {}),
          },
          body,
          credentials: "include",
        });
        return {
          status: res.status,
          restrictedType: res.headers.get("x-restricted-type"),
          csrf: res.headers.get("x-csrf-token"),
          text: (await res.text()).slice(0, 200),
        };
      }, { email, password });
    }

    // Allow post-login redirects / cookie settle
    await page.waitForTimeout(2500);

    const cookiesArr = await context.cookies("https://p-bandai.com");
    const cookies = {};
    for (const c of cookiesArr) {
      if (c?.name) cookies[c.name] = c.value;
    }

    const status = loginResponse?.status ?? null;
    const restrictedType = loginResponse?.restrictedType ?? null;
    const blocking =
      restrictedType &&
      !/^NoRestriction$/i.test(restrictedType) &&
      restrictedType !== "null";

    const ok =
      (status != null && status >= 200 && status < 300 && !blocking) ||
      (Boolean(cookies.SESSION) && status !== 501 && status !== 403);

    // Stronger ok: member refresh works in-page
    let memberOk = false;
    try {
      memberOk = await page.evaluate(async () => {
        const res = await fetch("/api/context/member/refresh", {
          credentials: "include",
          headers: {
            accept: "application/json",
            "x-g1-area-code": "au",
            "x-requested-with": "XMLHttpRequest",
          },
        });
        return res.status === 200;
      });
    } catch {
      memberOk = false;
    }

    const finalUrl = page.url();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    browser = null;

    return {
      ok: Boolean(ok || memberOk),
      cookies,
      restrictedType,
      loginStatus: status,
      memberRefreshOk: memberOk,
      finalUrl,
      note: memberOk
        ? "browser login + member refresh ok"
        : status === 501
          ? "browser still got login 501"
          : `login status ${status}`,
    };
  } catch (e) {
    try {
      await browser?.close?.();
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: "browser_login_failed",
      detail: String(e?.message || e).slice(0, 300),
    };
  }
}

export default { browserLoginBandai };
