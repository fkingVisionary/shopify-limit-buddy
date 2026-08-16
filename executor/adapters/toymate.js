// Toymate AU adapter — BigCommerce + Cloudflare.
// Completely separate from Kmart (no Hyper / Akamai / Paydock).
//
// Modes (task.toymateMode):
//   checkout     — Storefront cart/checkout scaffold (+ optional login)
//   account_gen  — create retailer account (proven path: CapSolver CF + form POST)
//   monitor      — keyword search poll (lightweight)
//
// Live card: Adyen v3 `scheme` via HTTP (CSE + BigPay). No Playwright in module path.

import { request, UA } from "../http.js";
import {
  solveCloudflareChallenge,
  solveRecaptchaV2,
  extractRecaptchaSitekey,
  looksLikeCfChallenge,
  capsolverKey,
} from "./toymate-cf-solve.js";
import {
  storefrontPaymentHeaders,
  pickAdyenCardMethod,
  placeOrderViaHttp,
  applySpamProtectionHttp,
} from "./toymate-adyen.js";

const sleep = (ms, jitter = 0) =>
  new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * (jitter + 1))));

function navHeaders({ referer, origin, userAgent } = {}) {
  return {
    "user-agent": userAgent || UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "upgrade-insecure-requests": "1",
    "sec-ch-ua": `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"macOS"`,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": referer ? "same-origin" : "none",
    "sec-fetch-user": "?1",
    ...(referer ? { referer } : {}),
    ...(origin ? { origin } : {}),
  };
}

function jarCookie(jar, name) {
  const dump = jar?.dump?.() || {};
  const raw = dump[name] ?? dump[String(name).toLowerCase()];
  if (raw == null || raw === "") return null;
  try {
    return decodeURIComponent(String(raw));
  } catch {
    return String(raw);
  }
}

/** HAR: authenticity_token ← XSRF-TOKEN; sf_authenticity_token ← SF-CSRF-TOKEN. */
function csrfTokens(jar, html = "") {
  const h = String(html || "");
  const fromHtml = (name) =>
    h.match(new RegExp(`name=["']${name}["']\\s+value=["']([^"']+)["']`, "i"))?.[1] || null;
  return {
    authenticityToken:
      jarCookie(jar, "XSRF-TOKEN") || fromHtml("authenticity_token") || null,
    sfAuthenticityToken:
      jarCookie(jar, "SF-CSRF-TOKEN") || fromHtml("sf_authenticity_token") || null,
  };
}

function buildLoginBody(email, password, tokens = {}) {
  const body = new URLSearchParams({
    login_email: email,
    login_pass: password,
  });
  if (tokens.authenticityToken) body.set("authenticity_token", tokens.authenticityToken);
  if (tokens.sfAuthenticityToken) body.set("sf_authenticity_token", tokens.sfAuthenticityToken);
  return body;
}

/** Stencil theme ATC/cart calls (HAR: x-requested-with: stencil-utils). */
function stencilHeaders({ referer, origin, userAgent, jar } = {}) {
  const headers = {
    "user-agent": userAgent || UA,
    accept: "*/*",
    "accept-language": "en-AU,en;q=0.9",
    "sec-ch-ua": `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"macOS"`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-requested-with": "stencil-utils",
    ...(referer ? { referer } : {}),
    ...(origin ? { origin } : {}),
  };
  const xsrf = jarCookie(jar, "XSRF-TOKEN");
  const sf = jarCookie(jar, "SF-CSRF-TOKEN");
  if (xsrf) headers["x-xsrf-token"] = xsrf;
  if (sf) headers["x-sf-csrf-token"] = sf;
  return headers;
}

function buildMultipart(fields) {
  const boundary = `----WebKitFormBoundary${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  let body = "";
  for (const [name, value] of Object.entries(fields)) {
    body +=
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function apiHeaders({ referer, origin, userAgent, jar } = {}) {
  const headers = {
    "user-agent": userAgent || UA,
    accept: "application/json, text/plain, */*",
    "accept-language": "en-AU,en;q=0.9",
    "content-type": "application/json",
    "sec-ch-ua": `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"macOS"`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-requested-with": "XMLHttpRequest",
    ...(referer ? { referer } : {}),
    ...(origin ? { origin } : {}),
  };
  // BigCommerce Storefront API returns 403 without the jar's XSRF-TOKEN.
  const xsrf = jarCookie(jar, "XSRF-TOKEN");
  const sf = jarCookie(jar, "SF-CSRF-TOKEN");
  if (xsrf) headers["x-xsrf-token"] = xsrf;
  if (sf) headers["x-sf-csrf-token"] = sf;
  return headers;
}

async function readText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function applyCookiesToJar(jar, cookies) {
  if (!jar || !cookies) return;
  for (const [name, value] of Object.entries(cookies)) {
    if (!name || value == null) continue;
    try {
      jar.set?.(name, String(value));
    } catch {
      /* ignore */
    }
  }
}

function uniquifyAccountEmail(email) {
  const raw = String(email || "").trim().toLowerCase();
  const m = raw.match(/^([^@]+)@(.+)$/);
  if (!m) return raw || `buyer${Date.now().toString(36)}@example.com`;
  const local = m[1].replace(/\+.*$/, "");
  const domain = m[2];
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Gmail-style dots still deliver; other providers get +tag.
  if (/^(gmail|googlemail)\.com$/i.test(domain)) {
    const base = local.replace(/\./g, "");
    const dotted = `${base.slice(0, 2)}.${stamp}.${base.slice(2) || "x"}`;
    return `${dotted}@${domain}`;
  }
  return `${local}+${stamp}@${domain}`;
}

function randomPassword(len = 12) {
  const letters = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const nums = "23456789";
  let s = "";
  for (let i = 0; i < len - 2; i++) s += letters[Math.floor(Math.random() * letters.length)];
  s += nums[Math.floor(Math.random() * nums.length)];
  s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

/** Toymate: ≥7 chars, must include alphabetic + numeric. */
function ensureToymatePassword(raw) {
  const p = String(raw || "").trim();
  if (p.length >= 7 && /[A-Za-z]/.test(p) && /\d/.test(p)) return p;
  if (p.length >= 7 && /[A-Za-z]/.test(p) && !/\d/.test(p)) return `${p}1`;
  return randomPassword();
}

function extractProductIds(html) {
  const h = String(html || "");
  const productId =
    h.match(/data-product-id=["'](\d+)["']/i)?.[1] ||
    h.match(/"product_id"\s*:\s*(\d+)/i)?.[1] ||
    h.match(/productId["']?\s*[:=]\s*["']?(\d+)/i)?.[1] ||
    null;
  const variantId =
    h.match(/data-product-variant=["'](\d+)["']/i)?.[1] ||
    h.match(/"variant_id"\s*:\s*(\d+)/i)?.[1] ||
    h.match(/entityId["']?\s*[:=]\s*["']?(\d+)/i)?.[1] ||
    productId;
  const title =
    h.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1]?.trim() ||
    h.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1] ||
    null;
  const sku = h.match(/itemprop=["']sku["'][^>]*content=["']([^"']+)["']/i)?.[1] || null;
  return { productId, variantId, title, sku };
}

/** Prefer the create-account form — page also has search/newsletter/cart forms. */
function extractCreateAccountFormHtml(html) {
  const h = String(html || "");
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  let fallback = null;
  while ((m = re.exec(h))) {
    const attrs = m[1] || "";
    const body = m[2] || "";
    const action = attrs.match(/\baction=["']([^"']+)["']/i)?.[1] || "";
    if (/save_new_account/i.test(action) || /save_new_account/i.test(body)) {
      return { attrs, body, action };
    }
    if (!fallback && /FormField\[1\]\[\d+\]/i.test(body) && /type=["']password["']/i.test(body)) {
      fallback = { attrs, body, action };
    }
  }
  return fallback;
}

function parseFormFields(html) {
  const scoped = extractCreateAccountFormHtml(html);
  const source = scoped?.body || String(html || "");
  const fields = [];
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(source))) {
    const attrs = m[1];
    const name = attrs.match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    const type = (attrs.match(/\btype=["']([^"']+)["']/i)?.[1] || "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "image") continue;
    const value = attrs.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
    fields.push({ name, type, value, tag: "input" });
  }
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(source))) {
    const name = m[1].match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    // Prefer a non-empty option (skip "Choose a Country").
    const opts = [...m[2].matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>([^<]*)/gi)];
    let value = "";
    for (const o of opts) {
      if (o[1]) {
        value = o[1];
        break;
      }
    }
    fields.push({ name, type: "select", value, tag: "select", options: opts.map((o) => o[1]) });
  }
  const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(source))) {
    const name = m[1].match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    fields.push({ name, type: "textarea", value: m[2] || "", tag: "textarea" });
  }
  return fields;
}

function extractFormAction(html, base) {
  const scoped = extractCreateAccountFormHtml(html);
  const raw = scoped?.action || "";
  if (raw) {
    try {
      return new URL(raw, base).href;
    } catch {
      /* fall through */
    }
  }
  return `${base}/login.php?action=save_new_account`;
}

function auStateName(province) {
  const p = String(province || "").trim().toUpperCase();
  const map = {
    NSW: "New South Wales",
    VIC: "Victoria",
    QLD: "Queensland",
    WA: "Western Australia",
    SA: "South Australia",
    TAS: "Tasmania",
    ACT: "Australian Capital Territory",
    NT: "Northern Territory",
  };
  if (map[p]) return map[p];
  // Already a full name?
  const full = Object.values(map).find((x) => x.toLowerCase() === String(province || "").trim().toLowerCase());
  return full || map.NSW;
}

function buildCreateAccountBody(html, profile, password, captchaToken, email) {
  const fields = parseFormFields(html);
  const body = new URLSearchParams();
  const first = String(profile?.first_name || "Test").trim() || "Test";
  const last = String(profile?.last_name || "Buyer").trim() || "Buyer";
  const phone = String(profile?.phone || "0400000000").replace(/\s+/g, "");
  const address1 = String(profile?.address1 || "1 Test St").trim();
  const city = String(profile?.city || "Sydney").trim();
  const state = auStateName(profile?.province || "NSW");
  const zip = String(profile?.zip || "2000").trim();
  const company = "";
  const country = "Australia";

  // Observed Toymate BC create-account layout (2026-07-21 HTML dump).
  const byId = {
    "FormField[1][1]": email,
    "FormField[1][2]": password,
    "FormField[1][3]": password,
    "FormField[2][4]": first,
    "FormField[2][5]": last,
    "FormField[2][6]": company,
    "FormField[2][7]": phone,
    "FormField[2][8]": address1,
    "FormField[2][9]": "",
    "FormField[2][10]": city,
    "FormField[2][11]": country,
    "FormField[2][12]": state,
    "FormField[2][13]": zip,
  };

  for (const f of fields) {
    if (byId[f.name] !== undefined) {
      body.set(f.name, byId[f.name]);
      continue;
    }
    if (f.type === "hidden" && f.value) body.set(f.name, f.value);
    if (f.name === "g-recaptcha-response") body.set(f.name, captchaToken || "");
  }
  // Ensure required keys even if parse missed a select.
  for (const [k, v] of Object.entries(byId)) {
    if (!body.has(k)) body.set(k, v);
  }
  if (captchaToken) body.set("g-recaptcha-response", captchaToken);

  return body;
}

function accountCreatedOk(status, text, finalUrl, locationHeader = null) {
  const t = String(text || "");
  const u = String(finalUrl || "");
  const loc = String(locationHeader || "");
  if (/action=account_created/i.test(u) || /action=account_created/i.test(t) || /action=account_created/i.test(loc)) {
    return true;
  }
  if (/Your Account Has Been Created/i.test(t)) return true;
  if (status >= 200 && status < 400 && /account has been created/i.test(t)) return true;
  // BC often 303s to account_created with an empty body under redirect:manual.
  if ((status === 302 || status === 303) && /account_created|account\.php|login\.php\?action=account/i.test(loc)) {
    return true;
  }
  // Reject false positives from nav copy / password policy strings in scripts.
  if (/password.*(alphabetic|number|numeric)/i.test(t) && /error|invalid|must/i.test(t)) return false;
  return false;
}

function normalizeCard(card) {
  if (!card) return null;
  const number = String(card.number || "").replace(/\s+/g, "");
  const cvv = String(card.cvv || "").trim();
  const expMonth = String(card.expMonth || "").padStart(2, "0").slice(-2);
  let expYear = String(card.expYear || "").trim();
  if (expYear.length === 4) expYear = expYear.slice(-2);
  const holder = String(card.holder || "Cardholder").trim();
  const ok = number.length >= 12 && cvv.length >= 3 && expMonth && expYear.length >= 2;
  return { ok, number, cvv, expMonth, expYear, holder };
}

function profileFromTask(task) {
  return task.profile || {};
}

function accountFromTask(task) {
  const a = task.account || task.toymateAccount || null;
  if (a?.email && a?.password) return { email: String(a.email), password: String(a.password) };
  return null;
}

async function warmCloudflare(ctx, base, proxyRaw, steps, tStep) {
  const origin = base;
  let html = "";
  let status = 0;
  // CapSolver may return a UA that must match cf_clearance.
  let solvedUa = null;

  await tStep("cf_warm", async () => {
    // Home sometimes returns empty 403 / fetch-failed on sticky exits while
    // /login.php still serves a CapSolver-ready "Just a moment..." interstitial.
    const candidates = [
      `${base}/`,
      "https://www.toymate.com.au/",
      "https://toymate.com.au/",
      "https://www.toymate.com.au/login.php",
      "https://toymate.com.au/login.php",
    ].filter((v, i, a) => a.indexOf(v) === i);

    let pageUrl = candidates[0];
    let challenged = false;
    let lastErr = null;
    for (const url of candidates) {
      try {
        const res = await request(url, { headers: navHeaders() }, ctx);
        status = res.status;
        html = await readText(res);
        pageUrl = url;
        challenged = looksLikeCfChallenge(html, status);
        if (!challenged && status > 0 && status < 400 && html.length > 500) {
          return { ok: true, status, note: `${url} ${status} (no CF challenge)` };
        }
        if (challenged) break;
      } catch (e) {
        lastErr = e?.message || String(e);
      }
    }

    if (!challenged) {
      return {
        ok: false,
        status,
        note:
          lastErr && !html
            ? `warm fetch failed: ${lastErr}`
            : `warm ${status} bytes=${html.length} via ${pageUrl} (no CapSolver-ready CF HTML)`,
        blocked: true,
      };
    }
    if (!capsolverKey()) {
      return {
        ok: false,
        status,
        note: "Cloudflare challenge — set CAPSOLVER_API_KEY (Settings)",
        blocked: true,
      };
    }
    const solved = await solveCloudflareChallenge({
      pageUrl,
      html,
      proxyRaw,
      userAgent: UA,
    });
    if (!solved.ok) {
      // Don't burn retries on "challenge not found" — detection was wrong or HTML stale.
      const soft =
        /challenge not found|INVALID_TASK_DATA/i.test(String(solved.error || "")) &&
        status > 0 &&
        status < 400;
      if (soft) {
        return {
          ok: true,
          status,
          note: `CapSolver skipped (${solved.error}); continuing with jar`,
          blocked: false,
        };
      }
      return { ok: false, status, note: solved.error || "CF solve failed", blocked: true };
    }
    applyCookiesToJar(ctx.jar, solved.cookies);
    solvedUa = solved.userAgent || UA;
    ctx.extraHeaders = { ...(ctx.extraHeaders || {}), "user-agent": solvedUa };
    // Apex is the canonical host after CF (www often 301s).
    const res2 = await request(`https://toymate.com.au/`, {
      headers: navHeaders({ referer: pageUrl, userAgent: solvedUa }),
    }, ctx);
    const html2 = await readText(res2);
    const still = looksLikeCfChallenge(html2, res2.status);
    html = html2;
    status = res2.status;
    const ok =
      !still &&
      ((res2.status > 0 && res2.status < 400) || res2.status === 301 || res2.status === 302);
    return {
      ok,
      status: res2.status,
      note: still
        ? `CF still challenging after solve (via ${pageUrl})`
        : `cf_clearance ok (${solved.note}); warm=${pageUrl}; post=${res2.status}`,
      blocked: still,
    };
  });

  return { html, status, origin, solvedUa };
}

// Pure helpers exported for fixture tests (no network / no CapSolver).
export const __test = {
  uniquifyAccountEmail,
  ensureToymatePassword,
  buildCreateAccountBody,
  accountCreatedOk,
  extractFormAction,
  parseFormFields,
  extractProductIds,
  csrfTokens,
  buildLoginBody,
  buildMultipart,
  stencilHeaders,
};

export const toymateAdapter = {
  id: "toymate",
  matches(host) {
    return host === "toymate.com.au" || host.endsWith(".toymate.com.au");
  },

  async run(task, ctx) {
    const steps = ctx.steps || (ctx.steps = []);
    const t0 = Date.now();
    const mode = String(task.toymateMode || task.mode || "checkout").toLowerCase();
    const placeOrder = task.placeOrder === true && task.dryRun !== true;
    const profile = profileFromTask(task);
    const proxyRaw = task.proxy || null;

    // Apex is canonical (www often 301s; Storefront API POSTs must not hit a 301).
    const apex = "https://toymate.com.au";
    const www = "https://www.toymate.com.au";
    let base = apex;
    try {
      const u = new URL(String(task.storeUrl || task.pdpUrl || apex));
      if (/toymate\.com\.au$/i.test(u.hostname)) {
        base = apex;
      }
    } catch {
      /* default */
    }
    const origin = apex;

    const tStep = async (name, fn) => {
      const s0 = Date.now();
      try {
        const out = await fn();
        const row = {
          step: name,
          ok: out?.ok !== false,
          status: out?.status ?? null,
          ms: Date.now() - s0,
          note: out?.note ?? null,
        };
        steps.push(row);
        ctx.onProgress?.(name, out?.note || null);
        return out;
      } catch (e) {
        const row = {
          step: name,
          ok: false,
          status: null,
          ms: Date.now() - s0,
          note: e?.message || String(e),
        };
        steps.push(row);
        throw e;
      }
    };

    // ── Account gen ────────────────────────────────────────────────────
    if (mode === "account_gen") {
      const warm = await warmCloudflare(ctx, www, proxyRaw, steps, tStep);
      const ua = warm.solvedUa || UA;

      const createUrl = `${apex}/login.php?action=create_account`;
      const page = await tStep("create_account_get", async () => {
        const res = await request(createUrl, {
          headers: navHeaders({ referer: `${apex}/`, userAgent: ua }),
        }, ctx);
        const html = await readText(res);
        const blocked = looksLikeCfChallenge(html, res.status);
        const hasForm = /save_new_account|FormField\[|action=create_account/i.test(html);
        return {
          ok: res.status === 200 && !blocked && hasForm,
          status: res.status,
          note: blocked
            ? "CF blocked create page"
            : hasForm
              ? `form ${res.status}`
              : `create page missing form (${res.status})`,
          html,
          blocked,
        };
      });

      if (!page.ok) {
        return {
          ok: false,
          steps,
          error: page.note || "create_account page failed",
          failedStep: "create_account_get",
          checkoutStage: "warm",
          accountGen: true,
          dryRun: true,
          cookies: ctx.jar?.dump?.() ?? {},
        };
      }

      const email = uniquifyAccountEmail(profile.email || task.email);
      const password = ensureToymatePassword(
        typeof task.accountPassword === "string" ? task.accountPassword : null,
      );

      let captchaToken = task.captchaToken || null;
      const sitekey = extractRecaptchaSitekey(page.html);
      if (!captchaToken && sitekey) {
        await tStep("create_account_captcha", async () => {
          const solved = await solveRecaptchaV2({
            pageUrl: createUrl,
            sitekey,
            proxyRaw,
          });
          if (!solved.ok) {
            return { ok: false, status: null, note: solved.error };
          }
          captchaToken = solved.token;
          return { ok: true, status: null, note: `reCAPTCHA ok (${solved.elapsedMs}ms)` };
        });
      }

      const actionUrl = extractFormAction(page.html, apex);
      const body = buildCreateAccountBody(page.html, profile, password, captchaToken, email);

      const created = await tStep("create_account_post", async () => {
        const res = await request(actionUrl, {
          method: "POST",
          headers: {
            ...navHeaders({ referer: createUrl, origin: apex, userAgent: ua }),
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
          },
          body: body.toString(),
        }, ctx);
        const text = await readText(res);
        const location = res.headers?.get?.("location") || null;
        const ok = accountCreatedOk(res.status, text, res.url, location);
        const errBits = [
          ...text.matchAll(
            /(?:class|id)=["'][^"']*(?:error|alert|message)[^"']*["'][^>]*>([^<]{3,140})/gi,
          ),
        ]
          .map((m) => m[1].replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 8);
        const fieldErrs = [
          ...text.matchAll(
            /FormFieldLabel[^>]*>\s*([^<]{2,80})[\s\S]{0,200}?class=["'][^"']*error/gi,
          ),
        ]
          .map((m) => m[1].trim())
          .slice(0, 8);
        const noteErr =
          [...errBits, ...fieldErrs].join(" | ") ||
          (location ? `Location: ${location}` : "") ||
          text.replace(/\s+/g, " ").slice(0, 160);
        return {
          ok,
          status: res.status,
          note: ok
            ? `account_created ${email}${location ? ` → ${location}` : ""}`
            : `create failed ${res.status} — ${noteErr}`,
          text,
          finalUrl: location || res.url,
          location,
          submittedKeys: [...body.keys()],
        };
      });

      // Cheap login verify (no CapSolver) — proves the account is real.
      let loginOk = null;
      if (created.ok) {
        const login = await tStep("account_login_verify", async () => {
          const loginPage = await request(`${apex}/login.php`, {
            headers: navHeaders({ referer: `${apex}/`, userAgent: ua }),
          }, ctx);
          const loginHtml = await readText(loginPage);
          const tokens = csrfTokens(ctx.jar, loginHtml);
          const loginBody = buildLoginBody(email, password, tokens);
          const res = await request(`${apex}/login.php?action=check_login`, {
            method: "POST",
            headers: {
              ...navHeaders({ referer: `${apex}/login.php`, origin: apex, userAgent: ua }),
              "content-type": "application/x-www-form-urlencoded",
            },
            body: loginBody.toString(),
          }, ctx);
          const loginText = await readText(res);
          const loc = res.headers?.get?.("location") || "";
          const ok =
            (res.status >= 200 && res.status < 400 && !/invalid|incorrect|unsuccessful/i.test(loginText)) ||
            /account\.php|account_created|logged/i.test(loc);
          return {
            ok,
            status: res.status,
            note: ok ? `login ok ${email}` : `login verify failed ${res.status}`,
            location: loc || null,
          };
        });
        loginOk = Boolean(login.ok);
      }

      return {
        ok: Boolean(created.ok),
        steps,
        accountGen: true,
        account: created.ok ? { email, password } : null,
        loginVerified: loginOk,
        error: created.ok ? null : created.note,
        failedStep: created.ok ? null : "create_account_post",
        checkoutStage: "warm",
        dryRun: true,
        cookies: ctx.jar?.dump?.() ?? {},
        elapsedHintMs: Date.now() - t0,
      };
    }

    // ── Keyword monitor ────────────────────────────────────────────────
    if (mode === "monitor") {
      await warmCloudflare(ctx, www, proxyRaw, steps, tStep);
      const q = String(task.input || task.keywords || task.pdpUrl || "").trim();
      const searchUrl = `${apex}/search.php?search_query=${encodeURIComponent(q)}`;
      const mon = await tStep("keyword_search", async () => {
        const res = await request(searchUrl, {
          headers: navHeaders({ referer: `${apex}/` }),
        }, ctx);
        const html = await readText(res);
        const pid = html.match(/data-product-id=["'](\d+)["']/i)?.[1];
        const abs = pid ? `${apex}/products.php?productId=${pid}` : null;
        return {
          ok: res.status === 200,
          status: res.status,
          note: abs ? `hit ${abs}` : "no product match",
          productUrl: abs,
          inStock: Boolean(abs),
        };
      });
      return {
        ok: Boolean(mon.inStock),
        steps,
        checkoutStage: mon.inStock ? "product" : "warm",
        productUrl: mon.productUrl || null,
        dryRun: true,
        cookies: ctx.jar?.dump?.() ?? {},
      };
    }

    // ── Checkout (guest or logged-in) ──────────────────────────────────
    const harvested = task.harvestedSession && typeof task.harvestedSession === "object"
      ? task.harvestedSession
      : null;
    const harvestedFresh =
      harvested &&
      harvested.cookies &&
      typeof harvested.cookies === "object" &&
      (harvested.cfExpiresAt == null || Number(harvested.cfExpiresAt) > Date.now());

    if (harvestedFresh) {
      applyCookiesToJar(ctx.jar, harvested.cookies);
      if (harvested.userAgent) {
        ctx.extraHeaders = {
          ...(ctx.extraHeaders || {}),
          "user-agent": harvested.userAgent,
        };
      }
      await tStep("cf_warm", async () => {
        const ageMs = harvested.harvestedAt
          ? Date.now() - Number(harvested.harvestedAt)
          : null;
        return {
          ok: true,
          status: 200,
          note: `harvested cf_clearance${ageMs != null ? ` age=${Math.round(ageMs / 1000)}s` : ""} host=${harvested.proxyHost || "?"}`,
        };
      });
    } else {
      await warmCloudflare(ctx, www, proxyRaw, steps, tStep);
    }

    const account = accountFromTask(task);
    if (account?.email && account?.password) {
      await tStep("account_login", async () => {
        const loginPage = await request(`${apex}/login.php`, {
          headers: navHeaders({ referer: `${base}/` }),
        }, ctx);
        const html = await readText(loginPage);
        const tokens = csrfTokens(ctx.jar, html);
        const body = buildLoginBody(account.email, account.password, tokens);
        const res = await request(`${apex}/login.php?action=check_login`, {
          method: "POST",
          headers: {
            ...navHeaders({ referer: `${apex}/login.php`, origin: apex }),
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-dest": "document",
          },
          body: body.toString(),
        }, ctx);
        const loginText = await readText(res);
        const loc = res.headers?.get?.("location") || "";
        const ok =
          (res.status >= 200 && res.status < 400 && !/invalid|incorrect/i.test(loginText)) ||
          /account\.php/i.test(loc);
        return {
          ok,
          status: res.status,
          note: ok
            ? `logged in ${account.email}${tokens.sfAuthenticityToken ? " (+sf csrf)" : ""}`
            : "login may have failed",
        };
      });
    }

    await sleep(200, 400);

    let productUrl = String(task.pdpUrl || task.storeUrl || "").trim();
    if (!/^https:\/\/(www\.)?toymate\.com\.au\//i.test(productUrl) || /toymate\.com\.au\/?$/i.test(productUrl)) {
      return {
        ok: false,
        steps,
        error: "Toymate checkout needs a full product URL",
        failedStep: "pdp_get",
        checkoutStage: "product",
        dryRun: !placeOrder,
        cookies: ctx.jar?.dump?.() ?? {},
      };
    }

    // Prefer productId from the URL — listing pages embed many data-product-id attrs.
    let urlProductId = null;
    try {
      const u = new URL(productUrl);
      urlProductId = u.searchParams.get("productId") || u.searchParams.get("product_id");
    } catch {
      /* ignore */
    }

    const pdp = await tStep("pdp_get", async () => {
      const res = await request(productUrl, {
        headers: navHeaders({ referer: `${apex}/` }),
      }, ctx);
      const html = await readText(res);
      const ids = extractProductIds(html);
      if (urlProductId) ids.productId = String(urlProductId);
      const blocked = looksLikeCfChallenge(html, res.status);
      return {
        ok: res.status === 200 && Boolean(ids.productId || ids.variantId || task.variantId || urlProductId),
        status: res.status,
        note: blocked
          ? `WAF ${res.status}`
          : `productId=${ids.productId || "?"} variant=${ids.variantId || task.variantId || ids.productId || "?"}`,
        ids,
        title: ids.title,
        blocked,
      };
    });

    const productId = Number(task.productId || urlProductId || pdp.ids?.productId || 0) || null;
    const variantId = Number(task.variantId || pdp.ids?.variantId || productId || 0) || null;
    const qty = Math.max(1, Math.min(20, Number(task.qty) || 1));
    if (!variantId) {
      return {
        ok: false,
        steps,
        error: "Could not resolve BigCommerce product/variant id from PDP",
        failedStep: "pdp_get",
        checkoutStage: "product",
        dryRun: !placeOrder,
        finalUrl: productUrl,
        cookies: ctx.jar?.dump?.() ?? {},
      };
    }

    // HAR-primary ATC: POST /remote/v1/cart/add (stencil-utils multipart).
    // Storefront POST /api/storefront/carts kept as fallback.
    // CapSolver-warmed sessions sometimes already have a cart: remote 200 without a
    // parseable cart_id, then storefront 422 "Cart Id `…` already exists".
    const extractExistingCartId = (payload) => {
      const detail =
        typeof payload === "string"
          ? payload
          : payload?.detail || payload?.title || payload?.message || "";
      const m = String(detail).match(
        /Cart Id [`']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      );
      return m?.[1] || null;
    };
    const cart = await tStep("cart_add", async () => {
      const pid = productId || variantId;
      const line = { quantity: qty, productId: pid };
      if (productId && variantId && productId !== variantId) line.variantId = variantId;

      const ensureCartHasLine = async (cartId, seedCart = null) => {
        let phys = seedCart?.lineItems?.physicalItems || [];
        if (!phys.length) {
          const addRes = await request(`${base}/api/storefront/carts/${cartId}/items`, {
            method: "POST",
            headers: apiHeaders({ referer: productUrl, origin, jar: ctx.jar }),
            body: JSON.stringify({ lineItems: [line] }),
          }, ctx);
          const addJson = await readJson(addRes);
          phys = addJson?.lineItems?.physicalItems || [];
          if (!phys.length && addRes.status >= 200 && addRes.status < 300) {
            const getRes = await request(`${base}/api/storefront/carts/${cartId}`, {
              headers: apiHeaders({ referer: productUrl, origin, jar: ctx.jar }),
            }, ctx);
            const getJson = await readJson(getRes);
            phys = getJson?.lineItems?.physicalItems || [];
            return { ok: phys.length > 0, itemId: phys[0]?.id || null, json: getJson, addStatus: addRes.status };
          }
          return {
            ok: phys.length > 0,
            itemId: phys[0]?.id || null,
            json: addJson,
            addStatus: addRes.status,
          };
        }
        return { ok: true, itemId: phys[0]?.id || null, json: seedCart, addStatus: 200 };
      };

      const mp = buildMultipart({
        action: "add",
        product_id: String(pid),
        "qty[]": String(qty),
      });
      // High-traffic: retry remote ATC on 429/5xx before storefront fallback.
      let remoteRes = null;
      let remoteText = "";
      let remoteJson = null;
      const atcAttempts = Math.max(1, Math.min(8, Number(task.toymateAtcRetries) || 6));
      // Lab chaos (TOYMATE_CHAOS_*): simulate drop congestion — site rarely answers.
      // First N ATC attempts force 429/503/timeout before the real request.
      const chaosForced =
        Math.max(0, Math.min(5, Number(process.env.TOYMATE_CHAOS_ATC_FAILS) || 0)) ||
        (Number(process.env.TOYMATE_CHAOS_ATC || 0) > 0
          ? Math.max(1, Math.min(4, Number(process.env.TOYMATE_CHAOS_ATC_MAX) || 2))
          : 0);
      const chaosStatus = Number(process.env.TOYMATE_CHAOS_ATC_STATUS) || 429;
      const chaosDelayMs = Math.max(0, Number(process.env.TOYMATE_CHAOS_ATC_DELAY_MS) || 0);
      let chaosInjected = 0;
      for (let attempt = 0; attempt < atcAttempts; attempt++) {
        if (attempt) await sleep(400 * attempt + 200, 150);
        if (chaosDelayMs) await sleep(chaosDelayMs, Math.floor(chaosDelayMs * 0.3));
        if (chaosForced > 0 && chaosInjected < chaosForced) {
          chaosInjected += 1;
          remoteRes = {
            status: chaosStatus === 0 ? 0 : chaosStatus,
            ok: false,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({
                error: "chaos_congestion",
                message: "TOYMATE_CHAOS simulated high-traffic congestion",
                attempt: chaosInjected,
              }),
          };
          remoteText = await readText(remoteRes);
          remoteJson = { error: "chaos_congestion", attempt: chaosInjected };
          // Count as congested → continue retry loop.
          continue;
        }
        remoteRes = await request(`${apex}/remote/v1/cart/add`, {
          method: "POST",
          headers: {
            ...stencilHeaders({ referer: productUrl, origin, jar: ctx.jar }),
            "content-type": mp.contentType,
          },
          body: mp.body,
        }, ctx);
        remoteText = await readText(remoteRes);
        remoteJson = null;
        try {
          remoteJson = remoteText ? JSON.parse(remoteText) : null;
        } catch {
          remoteJson = null;
        }
        const remoteCartIdTry =
          remoteJson?.data?.cart_id ||
          remoteJson?.data?.cartId ||
          remoteJson?.cart_id ||
          remoteJson?.cartId ||
          (remoteText.match(/"cart_id"\s*:\s*"([0-9a-f-]{36})"/i) || [])[1] ||
          null;
        if (remoteCartIdTry && remoteRes.status >= 200 && remoteRes.status < 300) {
          if (chaosInjected > 0) {
            remoteJson = {
              ...(remoteJson && typeof remoteJson === "object" ? remoteJson : {}),
              _chaosSurvived: chaosInjected,
            };
          }
          break;
        }
        const remoteErrTry = String(remoteJson?.error || remoteJson?.message || "");
        if (
          remoteRes.status >= 200 &&
          remoteRes.status < 300 &&
          /don't have enough|out of stock|sold out|not available|insufficient/i.test(remoteErrTry)
        ) {
          break; // terminal stock — don't retry
        }
        const congested =
          remoteRes.status === 429 ||
          remoteRes.status === 502 ||
          remoteRes.status === 503 ||
          remoteRes.status === 504 ||
          remoteRes.status === 0;
        if (!congested) break;
      }
      const remoteCartId =
        remoteJson?.data?.cart_id ||
        remoteJson?.data?.cartId ||
        remoteJson?.cart_id ||
        remoteJson?.cartId ||
        (remoteText.match(/"cart_id"\s*:\s*"([0-9a-f-]{36})"/i) || [])[1] ||
        null;
      const remoteItemId = remoteJson?.data?.cart_item?.id || remoteJson?.data?.cart_item_id || null;
      if (remoteCartId && remoteRes.status >= 200 && remoteRes.status < 300) {
        const chaosNote =
          remoteJson?._chaosSurvived > 0
            ? ` (survived ${remoteJson._chaosSurvived} chaos ATC fails)`
            : "";
        return {
          ok: true,
          status: remoteRes.status,
          note: `remote ATC cart ${remoteCartId}${chaosNote}`,
          cartId: remoteCartId,
          itemId: remoteItemId,
          json: remoteJson,
          via: "remote",
          chaosSurvived: remoteJson?._chaosSurvived || 0,
        };
      }

      const remoteErr = String(remoteJson?.error || remoteJson?.message || "");
      if (
        remoteRes.status >= 200 &&
        remoteRes.status < 300 &&
        /don't have enough|out of stock|sold out|not available|insufficient/i.test(remoteErr)
      ) {
        return {
          ok: false,
          status: remoteRes.status,
          note: `OOS/stock: ${remoteErr.slice(0, 140)}`,
          cartId: null,
          itemId: null,
          json: remoteJson,
          via: null,
        };
      }

      // Remote 200 without cart_id: CapSolver sessions / rate-limits often still
      // created the cart — poll GET carts before storefront POST (avoids 429 create).
      if (remoteRes.status >= 200 && remoteRes.status < 300) {
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt) await sleep(700 * attempt, 250);
          const listRes = await request(`${base}/api/storefront/carts`, {
            headers: apiHeaders({ referer: productUrl, origin, jar: ctx.jar }),
          }, ctx);
          const listJson = await readJson(listRes);
          const existing =
            (Array.isArray(listJson) ? listJson[0] : null) ||
            listJson?.id ||
            null;
          const existingId = existing?.id || (typeof existing === "string" ? existing : null);
          if (!existingId) continue;
          const phys = existing?.lineItems?.physicalItems || [];
          // Remote ATC already added the line in most 200 cases — prefer that cart.
          if (phys.length || attempt >= 1) {
            const ensured = phys.length
              ? { ok: true, itemId: phys[0]?.id || null, json: existing, addStatus: 200 }
              : await ensureCartHasLine(existingId, typeof existing === "object" ? existing : null);
            if (ensured.ok) {
              return {
                ok: true,
                status: remoteRes.status,
                note: `reuse session cart ${existingId}${phys.length ? " (remote line)" : ` + line`} (remote ATC ${remoteRes.status} no cart_id; poll=${attempt})`,
                cartId: existingId,
                itemId: ensured.itemId || remoteItemId || null,
                json: { remote: remoteJson, carts: listJson, ensured: ensured.json },
                via: "session_cart",
              };
            }
          }
        }
      }

      let res = null;
      let json = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(900 * attempt, 300);
        res = await request(`${base}/api/storefront/carts`, {
          method: "POST",
          headers: apiHeaders({ referer: productUrl, origin, jar: ctx.jar }),
          body: JSON.stringify({ lineItems: [line] }),
        }, ctx);
        json = await readJson(res);
        if (res.status !== 429) break;
        // On 429 after remote ATC, cart may already exist — recover instead of looping create.
        const listRes = await request(`${base}/api/storefront/carts`, {
          headers: apiHeaders({ referer: productUrl, origin, jar: ctx.jar }),
        }, ctx);
        const listJson = await readJson(listRes);
        const existing = (Array.isArray(listJson) ? listJson[0] : null) || null;
        if (existing?.id) {
          const phys = existing?.lineItems?.physicalItems || [];
          const ensured = phys.length
            ? { ok: true, itemId: phys[0]?.id || null, json: existing }
            : await ensureCartHasLine(existing.id, existing);
          if (ensured.ok) {
            return {
              ok: true,
              status: res.status,
              note: `recover cart ${existing.id} after storefront 429 (remote ${remoteRes.status})`,
              cartId: existing.id,
              itemId: ensured.itemId || null,
              json: { remote: remoteJson, carts: listJson, ensured: ensured.json },
              via: "session_cart_429",
            };
          }
        }
      }
      let cartId = json?.id || json?.cartId || null;
      let itemId = json?.lineItems?.physicalItems?.[0]?.id || null;
      const detail = json?.detail || json?.title || remoteJson?.title || "";
      if (!cartId) {
        cartId = extractExistingCartId(json) || extractExistingCartId(detail);
      }
      const reused = Boolean(extractExistingCartId(json) || extractExistingCartId(detail));
      if (cartId && reused) {
        const ensured = await ensureCartHasLine(cartId, json);
        itemId = ensured.itemId || itemId;
        return {
          ok: ensured.ok,
          status: res.status,
          note: ensured.ok
            ? `reuse existing cart ${cartId} + line (storefront ${res.status}; remote ${remoteRes.status})`
            : `existing cart ${cartId} empty after items post`,
          cartId: ensured.ok ? cartId : null,
          itemId,
          json: ensured.json || json,
          via: ensured.ok ? "storefront_existing" : null,
        };
      }
      const remoteHint = remoteJson
        ? ` remoteData=${JSON.stringify(remoteJson?.data ?? remoteJson?.errors ?? remoteJson).slice(0, 120)}`
        : ` remoteBody=${String(remoteText).slice(0, 100)}`;
      return {
        ok: Boolean(cartId),
        status: res?.status ?? 0,
        note: cartId
          ? `storefront cart ${cartId} (remote ATC ${remoteRes.status})`
          : `cart fail remote=${remoteRes.status} storefront=${res?.status}${detail ? `: ${String(detail).slice(0, 100)}` : ""}${remoteHint}`,
        cartId,
        itemId,
        json,
        via: cartId ? "storefront" : null,
      };
    });

    if (!cart.cartId) {
      return {
        ok: false,
        steps,
        error: "ATC failed (remote + storefront)",
        failedStep: "cart_add",
        checkoutStage: "cart",
        dryRun: !placeOrder,
        cookies: ctx.jar?.dump?.() ?? {},
      };
    }

    const checkoutId = cart.cartId;

    let checkoutJson = null;
    await tStep("checkout_get", async () => {
      const res = await request(
        `${base}/api/storefront/checkouts/${checkoutId}?include=cart.lineItems.physicalItems.options,customer,payments,promotions.banners`,
        { headers: apiHeaders({ referer: `${base}/cart.php`, origin, jar: ctx.jar }) },
        ctx,
      );
      const json = await readJson(res);
      checkoutJson = json;
      return { ok: res.status >= 200 && res.status < 300, status: res.status, note: `checkout ${res.status}`, json };
    });

    const ship = {
      firstName: profile.first_name || "Test",
      lastName: profile.last_name || "Buyer",
      email: profile.email || account?.email || "buyer@example.com",
      phone: profile.phone || "0400000000",
      address1: profile.address1 || "1 Test Street",
      city: profile.city || "Sydney",
      stateOrProvinceCode: profile.province || "NSW",
      postalCode: profile.zip || "2000",
      countryCode: "AU",
    };

    await tStep("checkout_set_address", async () => {
      const itemId =
        checkoutJson?.cart?.lineItems?.physicalItems?.[0]?.id ||
        cart.itemId ||
        cart.json?.lineItems?.physicalItems?.[0]?.id ||
        null;
      const consignmentBody = [
        {
          shippingAddress: ship,
          lineItems: itemId ? [{ itemId, quantity: qty }] : [],
        },
      ];
      const res = await request(
        `${base}/api/storefront/checkouts/${checkoutId}/consignments?include=consignments.availableShippingOptions`,
        {
          method: "POST",
          headers: apiHeaders({ referer: `${base}/checkout`, origin, jar: ctx.jar }),
          body: JSON.stringify(consignmentBody),
        },
        ctx,
      );
      const json = await readJson(res);
      const consignmentId = json?.consignments?.[0]?.id;
      const optionId = json?.consignments?.[0]?.availableShippingOptions?.[0]?.id;
      if (consignmentId && optionId) {
        const res2 = await request(
          `${base}/api/storefront/checkouts/${checkoutId}/consignments/${consignmentId}?include=consignments.availableShippingOptions`,
          {
            method: "PUT",
            headers: apiHeaders({ referer: `${base}/checkout`, origin, jar: ctx.jar }),
            body: JSON.stringify({ shippingOptionId: optionId }),
          },
          ctx,
        );
        return {
          ok: res2.status >= 200 && res2.status < 300,
          status: res2.status,
          note: `shipping option ${optionId}`,
        };
      }
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        note: consignmentId ? "consignment set (no shipping option)" : `consignment ${res.status}`,
      };
    });

    await tStep("checkout_set_billing", async () => {
      const res = await request(`${base}/api/storefront/checkouts/${checkoutId}/billing-address`, {
        method: "POST",
        headers: apiHeaders({ referer: `${base}/checkout`, origin, jar: ctx.jar }),
        body: JSON.stringify({ ...ship }),
      }, ctx);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        note: `billing ${res.status}`,
      };
    });

    let captchaToken = task.captchaToken || null;
    // Prefer harvested spam token (still valid) before CapSolver spend.
    if (
      !captchaToken &&
      harvestedFresh &&
      harvested.captchaToken &&
      (harvested.spamExpiresAt == null || Number(harvested.spamExpiresAt) > Date.now())
    ) {
      captchaToken = harvested.captchaToken;
    }
    let spamCleared = false;
    let spamRestAttempted = false;
    await tStep("checkout_spam", async () => {
      // Live place-order needs spam-protection when BC has it enabled.
      // checkout-sdk body is `{ token }` (not nested spamProtection).
      if (!captchaToken && placeOrder && capsolverKey()) {
        const sitekey =
          task.recaptchaSitekey ||
          "6LcjX0sbAAAAACp92-MNpx66FT4pbIWh-FTDmkkz";
        // Prefer proxy-bound token (same exit IP as checkout); proxyless fallback.
        let solved = await solveRecaptchaV2({
          pageUrl: `${apex}/checkout`,
          sitekey,
          proxyRaw,
        });
        if (!solved.ok) {
          solved = await solveRecaptchaV2({
            pageUrl: `${apex}/checkout`,
            sitekey,
            proxyless: true,
          });
        }
        if (solved.ok) captchaToken = solved.token;
        else {
          return {
            ok: false,
            status: null,
            note: solved.error || "spam reCAPTCHA failed",
          };
        }
      }
      if (!captchaToken) {
        return {
          ok: !placeOrder,
          status: null,
          note: placeOrder
            ? "placeOrder needs CapSolver for checkout spam reCAPTCHA"
            : "no captcha token — skip spam-protection",
        };
      }
      // Single REST+GQL attempt — hammering spam 429s the payment plane.
      const spam = await applySpamProtectionHttp(request, ctx, {
        apex: base,
        ua: ctx.extraHeaders?.["user-agent"] || UA,
        jar: ctx.jar,
        checkoutId,
        captchaToken,
        sfToken: null,
      });
      spamRestAttempted = true;
      spamCleared = Boolean(spam.ok);
      if (spam.ok) {
        return {
          ok: true,
          status: spam.status,
          note: `spam ${spam.status} via ${spam.via}`,
        };
      }
      return {
        // Soft-ok: keep token for placeOrderViaHttp GraphQL spam retry.
        ok: Boolean(captchaToken),
        status: spam.status,
        note: `spam ${spam.status} — continue HTTP (may still block completeCheckout)`,
      };
    });

    const paymentMethod = String(task.paymentMethod || "credit_card").toLowerCase();

    if (paymentMethod === "paypal_manual") {
      let paypalApproveUrl = null;
      await tStep("payment_paypal", async () => {
        const res = await request(`${base}/api/storefront/checkouts/${checkoutId}/payments`, {
          method: "POST",
          headers: apiHeaders({ referer: `${base}/checkout`, origin, jar: ctx.jar }),
          body: JSON.stringify({ payment: { methodId: "paypalcommerce" } }),
        }, ctx);
        const json = await readJson(res);
        paypalApproveUrl =
          json?.payment?.redirectUrl ||
          json?.redirectUrl ||
          json?.approvalUrl ||
          null;
        return {
          ok: Boolean(paypalApproveUrl) || res.status < 300,
          status: res.status,
          note: paypalApproveUrl ? "paypal approve url" : `paypal ${res.status}`,
        };
      });
      return {
        ok: Boolean(paypalApproveUrl),
        steps,
        checkoutStage: paypalApproveUrl ? "tokenize" : "details",
        dryRun: true,
        paymentMethod: "paypal_manual",
        paypalApproveUrl,
        finalUrl: paypalApproveUrl || `${base}/checkout`,
        cookies: ctx.jar?.dump?.() ?? {},
        title: pdp.title,
      };
    }

    const card = normalizeCard(task.card);
    await tStep("place_order_gate", async () => {
      if (!placeOrder) return { ok: true, status: null, note: "dry-run — skip charge" };
      if (!card?.ok) return { ok: false, status: null, note: "placeOrder requires card on profile" };
      return { ok: true, status: null, note: "placeOrder armed — Adyen scheme via HTTP (no Playwright)" };
    });

    let orderNumber = null;
    let paymentStatus = null;
    let paymentDeclined = false;

    if (placeOrder && card?.ok) {
      // Discover card method (Adyen scheme) — proves payments API + X-API-INTERNAL.
      const methodsStep = await tStep("payment_methods", async () => {
        const res = await request(
          `${apex}/api/storefront/payments?cartId=${checkoutId}`,
          {
            method: "GET",
            headers: storefrontPaymentHeaders(ctx.jar, ctx.extraHeaders?.["user-agent"] || UA),
          },
          ctx,
        );
        const methods = await readJson(res);
        const adyen = pickAdyenCardMethod(methods);
        return {
          ok: res.status === 200 && Boolean(adyen),
          status: res.status,
          note: adyen
            ? `card method ${adyen.id}/${adyen.gateway}`
            : `no Adyen scheme (status ${res.status})`,
          adyen,
          methods,
        };
      });

      const pay = await tStep("place_order", async () => {
        // Module path is HTTP-only. Playwright is research-only
        // (executor/experiments/toymate-checkout-ui-research.mjs).
        // Reuse CapSolver token from checkout_spam — do not mint a second
        // solve unless we somehow never got one (tokens expire ~2 min).
        if (!spamCleared && !captchaToken && capsolverKey()) {
          const sitekey =
            task.recaptchaSitekey ||
            "6LcjX0sbAAAAACp92-MNpx66FT4pbIWh-FTDmkkz";
          let again = await solveRecaptchaV2({
            pageUrl: `${apex}/checkout`,
            sitekey,
            proxyRaw,
          });
          if (!again.ok) {
            again = await solveRecaptchaV2({
              pageUrl: `${apex}/checkout`,
              sitekey,
              proxyless: true,
            });
          }
          if (again.ok) captchaToken = again.token;
        }
        const http = await placeOrderViaHttp({
          request,
          ctx,
          userAgent: ctx.extraHeaders?.["user-agent"] || UA,
          checkoutId,
          card,
          captchaToken: spamCleared ? null : captchaToken,
          spamAlreadyCleared: spamCleared,
          spamRestAttempted,
          profile,
        });
        orderNumber = http.orderNumber || null;
        paymentDeclined = Boolean(http.declined);
        paymentStatus = http.declined
          ? http.issuerLikely
            ? "declined_insufficient_funds"
            : "declined"
          : orderNumber
            ? "submitted"
            : http.ok
              ? "submitted"
              : "failed";
        const logHint = (http.paymentLogs || [])
          .map((l) => `${l.step}:${l.status ?? l.body?.slice?.(0, 24) ?? "?"}`)
          .join(" | ");
        return {
          ok: Boolean(http.ok || http.declined),
          status: http.status ?? null,
          note: `${http.note || "http place failed"}${logHint ? ` :: ${logHint}` : ""}`.slice(0, 320),
          declined: http.declined,
          bigpay: http.bigpay || null,
          bigpayCode: http.bigpayCode ?? http.bigpay?.code ?? null,
          bigpayTitle: http.bigpayTitle ?? http.bigpay?.title ?? null,
          issuerLikely: Boolean(http.issuerLikely),
          bankProofLikely: Boolean(http.bankProofLikely),
          paymentLogs: (http.paymentLogs || []).slice(0, 12),
          via: "http",
        };
      });

      const bigpayPosts = (pay.paymentLogs || []).filter(
        (l) => l.step === "bigpay" || l.step === "bigpay_cse",
      );
      const authPosts = bigpayPosts.filter(
        (l) => typeof l.status === "number" && l.status > 0,
      ).length;

      return {
        ok: Boolean(orderNumber) || paymentDeclined || pay.ok,
        steps,
        checkoutStage: orderNumber ? "order" : paymentDeclined ? "declined" : "tokenize",
        dryRun: false,
        orderNumber,
        orderId: orderNumber,
        paymentStatus,
        paymentDeclined,
        paymentMethod: "credit_card",
        cardGateway: methodsStep.adyen?.gateway || "adyenv3",
        atcVia: cart.via || null,
        cartId: checkoutId,
        paymentLogs: pay.paymentLogs || [],
        bigpay: pay.bigpay || null,
        bigpayCode: pay.bigpayCode ?? null,
        bigpayTitle: pay.bigpayTitle ?? null,
        issuerLikely: Boolean(pay.issuerLikely),
        bankProofLikely: Boolean(pay.bankProofLikely),
        bigpayAuthPosts: authPosts,
        chargeReqCount: authPosts || null,
        paymentAttempted: authPosts >= 1,
        responseLost: Boolean(
          pay.responseLost ||
            /RESPONSE_LOST|timeout|fetch failed|ECONN/i.test(String(pay.note || pay.error || "")),
        ),
        elapsedMs: Date.now() - t0,
        finalUrl: orderNumber
          ? `${apex}/checkout/order-confirmation`
          : `${apex}/checkout`,
        cookies: ctx.jar?.dump?.() ?? {},
        title: pdp.title,
      };
    }

    return {
      ok: true,
      steps,
      checkoutStage: "tokenize",
      dryRun: true,
      paymentMethod: "credit_card",
      finalUrl: `${base}/checkout`,
      cookies: ctx.jar?.dump?.() ?? {},
      title: pdp.title,
      cartId: checkoutId,
      atcVia: cart.via || null,
      note: "Dry-run reached checkout scaffold — HTTP Adyen CSE place-order when placeOrder=true",
    };
  },
};
