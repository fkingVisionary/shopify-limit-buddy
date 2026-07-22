// Premium Bandai AU — F5 / volt-adc sensor bridge.
//
// Gated POSTs (/login, addToCart, modifyCartItem, cart checkout) require
// `p8komysnbc-*` headers minted by `/_ui/responsive/common/js/common.js`.
// That script is heavily obfuscated and needs a real browser DOM.
//
// This module keeps Playwright to the minimum: load the page, let common.js
// hook XHR, abort the probe request after headers are set, then return those
// headers so undici can perform the real HTTP call on the same cookie jar.
// Full browser checkout stays opt-in lab-only (`bandaiBrowserCheckout`).

import { chromium } from "playwright";

const BANDAI_ORIGIN = "https://p-bandai.com";
const BANDAI_BASE = `${BANDAI_ORIGIN}/au`;

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Paths F5 Shape Defense instruments (from common.js?single allowlist). */
export const BANDAI_F5_GATED = [
  { method: "POST", path: /^\/login\/?$/i },
  { method: "POST", path: /^\/api\/cart\/addtocart$/i },
  { method: "PUT", path: /^\/api\/cart\/modifycartitem$/i },
  { method: "POST", path: /^\/api\/cart\/[^/]+\/checkout$/i },
];

export function isBandaiF5Gated(method, urlOrPath) {
  let path = String(urlOrPath || "");
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    /* keep */
  }
  const m = String(method || "GET").toUpperCase();
  return BANDAI_F5_GATED.some((g) => g.method === m && g.path.test(path));
}

export function pickBandaiSensors(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^p8komysnbc-/i.test(k) && v != null) out[k.toLowerCase()] = String(v);
  }
  return out;
}

/**
 * Parse host:port:user:pass | user:pass@host:port | http(s)://…
 * into Playwright proxy + undici-friendly URL.
 */
export function parseBandaiProxy(rawProxy) {
  if (!rawProxy) return { playwright: null, url: null };
  const raw = String(rawProxy).trim();
  if (!raw) return { playwright: null, url: null };

  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return {
        url: raw,
        playwright: {
          server: `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`,
          username: u.username ? decodeURIComponent(u.username) : undefined,
          password: u.password ? decodeURIComponent(u.password) : undefined,
        },
      };
    } catch {
      return { playwright: null, url: null };
    }
  }

  // user:pass@host:port
  const at = raw.match(/^([^:@]+):([^@]+)@([^:]+):(\d+)$/);
  if (at) {
    const [, user, pass, host, port] = at;
    return {
      url: `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`,
      playwright: { server: `http://${host}:${port}`, username: user, password: pass },
    };
  }

  // host:port:user:pass
  const parts = raw.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts;
    const pass = rest.join(":");
    return {
      url: `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`,
      playwright: { server: `http://${host}:${port}`, username: user, password: pass },
    };
  }

  return { playwright: null, url: null };
}

/**
 * @param {object} opts
 * @param {string} [opts.proxy]
 * @param {string} [opts.userAgent]
 * @param {boolean} [opts.headless=true]
 */
export async function createBandaiF5Bridge(opts = {}) {
  const userAgent = opts.userAgent || DEFAULT_UA;
  const { playwright: pwProxy } = parseBandaiProxy(opts.proxy);
  const headless = opts.headless !== false;

  const browser = await chromium.launch({
    headless,
    proxy: pwProxy || undefined,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    locale: "en-AU",
    userAgent,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(Number(opts.timeoutMs) || 90_000);

  let closed = false;

  async function goto(pathOrUrl) {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? pathOrUrl
      : `${BANDAI_ORIGIN}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // Allow common.js?async to hook XHR/fetch
    await page.waitForTimeout(2200);
    return { url: page.url() };
  }

  async function csrfToken() {
    return page.evaluate(() => {
      return (
        window.__bandaiCsrf ||
        window.USER_DATA?.csrfToken ||
        document.querySelector('meta[name="csrf-token"]')?.content ||
        null
      );
    });
  }

  async function cookies() {
    const arr = await context.cookies(BANDAI_ORIGIN);
    const out = {};
    for (const c of arr) {
      if (c?.name) out[c.name] = c.value;
    }
    return out;
  }

  async function syncCookies(dump) {
    if (!dump || typeof dump !== "object") return;
    const list = [];
    for (const [name, value] of Object.entries(dump)) {
      if (!name || value == null) continue;
      list.push({
        name,
        value: String(value),
        url: `${BANDAI_ORIGIN}/`,
      });
    }
    if (list.length) await context.addCookies(list);
  }

  /**
   * Mint fresh p8komysnbc-* headers for a gated method/path without consuming
   * them on the wire — the probe XHR is aborted after headers are captured.
   */
  async function mint(method, path, { body, contentType, csrf } = {}) {
    const m = String(method || "GET").toUpperCase();
    let pathOnly = String(path || "");
    try {
      if (/^https?:\/\//i.test(pathOnly)) pathOnly = new URL(pathOnly).pathname;
    } catch {
      /* keep */
    }
    if (!pathOnly.startsWith("/")) pathOnly = `/${pathOnly}`;

    let sensors = null;
    const routeHandler = async (route) => {
      const req = route.request();
      let reqPath = "/";
      try {
        reqPath = new URL(req.url()).pathname;
      } catch {
        /* ignore */
      }
      const samePath =
        reqPath.replace(/\/$/, "") === pathOnly.replace(/\/$/, "") ||
        reqPath.toLowerCase() === pathOnly.toLowerCase();
      if (req.method() === m && samePath) {
        sensors = pickBandaiSensors(req.headers());
        await route.abort("failed");
        return;
      }
      await route.continue();
    };

    await page.route("**/*", routeHandler);
    try {
      await page.evaluate(
        async ({ method: meth, path: p, body: b, contentType: ct, csrf: tok }) => {
          await new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open(meth, p, true);
            xhr.setRequestHeader("accept", "application/json, text/plain, */*");
            xhr.setRequestHeader("x-g1-area-code", "au");
            xhr.setRequestHeader("x-requested-with", "XMLHttpRequest");
            if (tok) xhr.setRequestHeader("x-csrf-token", tok);
            if (ct) xhr.setRequestHeader("content-type", ct);
            xhr.onload = () => resolve();
            xhr.onerror = () => resolve();
            xhr.onabort = () => resolve();
            try {
              xhr.send(b == null ? null : b);
            } catch {
              resolve();
            }
            // Safety timeout — route.abort should finish first
            setTimeout(resolve, 2500);
          });
        },
        {
          method: m,
          path: pathOnly,
          body: body ?? null,
          contentType: contentType || null,
          csrf: csrf || (await csrfToken()),
        },
      );
      await page.waitForTimeout(200);
    } finally {
      await page.unroute("**/*", routeHandler).catch(() => {});
    }

    const keys = Object.keys(sensors || {});
    return {
      ok: keys.length > 0,
      sensors: sensors || {},
      note: keys.length ? `minted ${keys.join(",")}` : "no sensor headers captured",
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }

  return {
    page,
    context,
    browser,
    goto,
    csrfToken,
    cookies,
    syncCookies,
    mint,
    close,
    userAgent,
    BANDAI_BASE,
    BANDAI_ORIGIN,
  };
}

export default {
  createBandaiF5Bridge,
  isBandaiF5Gated,
  pickBandaiSensors,
  parseBandaiProxy,
  BANDAI_F5_GATED,
};
