// Toymate AU adapter — BigCommerce + Cloudflare.
// Completely separate from Kmart (no Hyper / Akamai / Paydock).
//
// Modes (task.toymateMode):
//   checkout     — Storefront cart/checkout scaffold (+ optional login)
//   account_gen  — create retailer account (proven path: CapSolver CF + form POST)
//   monitor      — keyword search poll (lightweight)
//
// Payment tokenize for live card place-order still needs an operator HAR.

import { request, UA } from "../http.js";
import {
  solveCloudflareChallenge,
  solveRecaptchaV2,
  extractRecaptchaSitekey,
  looksLikeCfChallenge,
  capsolverKey,
} from "./toymate-cf-solve.js";

const sleep = (ms, jitter = 0) =>
  new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * (jitter + 1))));

function navHeaders({ referer, origin } = {}) {
  return {
    "user-agent": UA,
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

function apiHeaders({ referer, origin } = {}) {
  return {
    "user-agent": UA,
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

function parseFormFields(html) {
  const fields = [];
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(html))) {
    const attrs = m[1];
    const name = attrs.match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    const type = (attrs.match(/\btype=["']([^"']+)["']/i)?.[1] || "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "image") continue;
    const value = attrs.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
    fields.push({ name, type, value, tag: "input" });
  }
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(html))) {
    const name = m[1].match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    const opt = m[2].match(/<option[^>]*value=["']([^"']*)["'][^>]*>/i);
    fields.push({ name, type: "select", value: opt?.[1] ?? "", tag: "select" });
  }
  const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(html))) {
    const name = m[1].match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) continue;
    fields.push({ name, type: "textarea", value: m[2] || "", tag: "textarea" });
  }
  return fields;
}

function extractFormAction(html, base) {
  const m = String(html || "").match(/<form\b[^>]*action=["']([^"']+)["'][^>]*>/i);
  if (!m?.[1]) return `${base}/login.php?action=save_new_account`;
  try {
    return new URL(m[1], base).href;
  } catch {
    return `${base}/login.php?action=save_new_account`;
  }
}

function buildCreateAccountBody(html, profile, password, captchaToken, email) {
  const fields = parseFormFields(html);
  const body = new URLSearchParams();
  const first = String(profile?.first_name || "Test").trim() || "Test";
  const last = String(profile?.last_name || "Buyer").trim() || "Buyer";
  const phone = String(profile?.phone || "0400000000").replace(/\s+/g, "");
  const address1 = String(profile?.address1 || "1 Test St").trim();
  const city = String(profile?.city || "Sydney").trim();
  const province = String(profile?.province || "NSW").trim();
  const zip = String(profile?.zip || "2000").trim();
  const company = "";

  const byHint = (name, hints) => {
    const n = name.toLowerCase();
    return hints.some((h) => n.includes(h));
  };

  const namedValues = {};

  // Pass 1: type + name hints (password/email inputs win even when named FormField[n][m]).
  let passwordFieldsSeen = 0;
  for (const f of fields) {
    const n = f.name;
    const nl = n.toLowerCase();
    if (n === "g-recaptcha-response" || nl.includes("recaptcha")) {
      namedValues[n] = captchaToken || "";
      continue;
    }
    if (f.type === "hidden" || f.type === "checkbox" || f.type === "radio") {
      if (f.value) namedValues[n] = f.value;
      continue;
    }
    if (f.type === "password") {
      namedValues[n] = password;
      passwordFieldsSeen++;
      continue;
    }
    if (f.type === "email" || byHint(nl, ["email", "login_email"])) {
      namedValues[n] = email;
      continue;
    }
    if (byHint(nl, ["password", "login_pass"])) {
      namedValues[n] = password;
      continue;
    }
    if (byHint(nl, ["first", "fname"])) namedValues[n] = first;
    else if (byHint(nl, ["last", "lname", "surname"])) namedValues[n] = last;
    else if (byHint(nl, ["phone", "mobile", "tel"])) namedValues[n] = phone;
    else if (byHint(nl, ["company"])) namedValues[n] = company;
    else if (byHint(nl, ["address", "street"]) && !/2|line2/.test(nl)) namedValues[n] = address1;
    else if (byHint(nl, ["city", "suburb"])) namedValues[n] = city;
    else if (byHint(nl, ["state", "province", "region"])) namedValues[n] = province;
    else if (byHint(nl, ["zip", "postcode", "postal"])) namedValues[n] = zip;
    else if (byHint(nl, ["country"])) namedValues[n] = f.value || "Australia";
    else if (f.value) namedValues[n] = f.value;
  }

  // Pass 2: remaining opaque FormField[*][*] text inputs — profile order (skip email/password slots).
  const opaqueQueue = [first, last, company, phone, address1, "", city, province, zip, "Australia"];
  let oi = 0;
  const sortedOpaque = fields
    .filter((f) => /^FormField\[\d+\]\[\d+\]$/i.test(f.name))
    .map((f) => {
      const mm = f.name.match(/^FormField\[(\d+)\]\[(\d+)\]$/i);
      return { ...f, r: Number(mm[1]), c: Number(mm[2]) };
    })
    .sort((a, b) => a.r - b.r || a.c - b.c);

  for (const f of sortedOpaque) {
    if (namedValues[f.name] != null && namedValues[f.name] !== "") continue;
    if (f.type === "password" || f.type === "email" || f.type === "hidden") continue;
    namedValues[f.name] = opaqueQueue[oi] ?? "";
    oi++;
  }

  // If no password-type inputs were found, force common BC password slots by index.
  if (passwordFieldsSeen === 0) {
    for (const f of sortedOpaque) {
      // Observed Toymate layout: FormField[1][12]/[1][13] = password / confirm.
      if (/^FormField\[1\]\[(12|13)\]$/i.test(f.name)) namedValues[f.name] = password;
      if (/^FormField\[1\]\[11\]$/i.test(f.name)) namedValues[f.name] = email;
    }
  }

  for (const [k, v] of Object.entries(namedValues)) {
    body.set(k, v == null ? "" : String(v));
  }
  if (captchaToken) body.set("g-recaptcha-response", captchaToken);
  for (const f of fields) {
    if (!body.has(f.name) && f.type === "hidden" && f.value) body.set(f.name, f.value);
  }

  return body;
}

function accountCreatedOk(status, text, finalUrl) {
  const t = String(text || "");
  const u = String(finalUrl || "");
  if (/action=account_created/i.test(u) || /action=account_created/i.test(t)) return true;
  if (/Your Account Has Been Created/i.test(t)) return true;
  if (status >= 200 && status < 400 && /account has been created/i.test(t)) return true;
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

  await tStep("cf_warm", async () => {
    const res = await request(`${base}/`, { headers: navHeaders() }, ctx);
    status = res.status;
    html = await readText(res);
    const challenged = looksLikeCfChallenge(html, status);
    if (!challenged && status > 0 && status < 400) {
      return { ok: true, status, note: `home ${status} (no CF challenge)` };
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
      pageUrl: `${base}/`,
      html,
      proxyRaw,
      userAgent: UA,
    });
    if (!solved.ok) {
      return { ok: false, status, note: solved.error || "CF solve failed", blocked: true };
    }
    applyCookiesToJar(ctx.jar, solved.cookies);
    const res2 = await request(`${base}/`, { headers: navHeaders() }, ctx);
    const html2 = await readText(res2);
    const still = looksLikeCfChallenge(html2, res2.status);
    html = html2;
    status = res2.status;
    return {
      ok: !still && res2.status > 0 && res2.status < 400,
      status: res2.status,
      note: still ? "CF still challenging after solve" : `cf_clearance ok (${solved.note})`,
      blocked: still,
    };
  });

  return { html, status, origin };
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

    // Prefer apex for form actions (create-account posts to toymate.com.au).
    let base = "https://www.toymate.com.au";
    try {
      const u = new URL(String(task.storeUrl || task.pdpUrl || base));
      if (/toymate\.com\.au$/i.test(u.hostname)) {
        base = `${u.protocol}//${u.hostname === "toymate.com.au" ? "www.toymate.com.au" : u.hostname}`;
      }
    } catch {
      /* default */
    }
    const apex = "https://toymate.com.au";
    const origin = base;

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
      await warmCloudflare(ctx, base, proxyRaw, steps, tStep);

      const createUrl = `${apex}/login.php?action=create_account`;
      const page = await tStep("create_account_get", async () => {
        const res = await request(createUrl, {
          headers: navHeaders({ referer: `${base}/` }),
        }, ctx);
        const html = await readText(res);
        const blocked = looksLikeCfChallenge(html, res.status);
        return {
          ok: res.status === 200 && !blocked,
          status: res.status,
          note: blocked ? "CF blocked create page" : `form ${res.status}`,
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
            ...navHeaders({ referer: createUrl, origin: apex }),
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
          },
          body: body.toString(),
        }, ctx);
        const text = await readText(res);
        const ok = accountCreatedOk(res.status, text, res.url);
        return {
          ok,
          status: res.status,
          note: ok
            ? `account_created ${email}`
            : `create failed ${res.status} — ${text.replace(/\s+/g, " ").slice(0, 160)}`,
          text,
          finalUrl: res.url,
        };
      });

      return {
        ok: Boolean(created.ok),
        steps,
        accountGen: true,
        account: created.ok ? { email, password } : null,
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
      await warmCloudflare(ctx, base, proxyRaw, steps, tStep);
      const q = String(task.input || task.keywords || task.pdpUrl || "").trim();
      const searchUrl = `${base}/search.php?search_query=${encodeURIComponent(q)}`;
      const mon = await tStep("keyword_search", async () => {
        const res = await request(searchUrl, {
          headers: navHeaders({ referer: `${base}/` }),
        }, ctx);
        const html = await readText(res);
        const productUrl =
          html.match(/href=["'](https?:\/\/[^"']*\/[^"']*\/?\d+\/?)["']/i)?.[1] ||
          html.match(/href=["'](\/[^"']*\/\d+\/?)["']/i)?.[1] ||
          null;
        const abs = productUrl
          ? productUrl.startsWith("http")
            ? productUrl
            : new URL(productUrl, base).href
          : null;
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
    await warmCloudflare(ctx, base, proxyRaw, steps, tStep);

    const account = accountFromTask(task);
    if (account?.email && account?.password) {
      await tStep("account_login", async () => {
        const loginPage = await request(`${apex}/login.php`, {
          headers: navHeaders({ referer: `${base}/` }),
        }, ctx);
        const html = await readText(loginPage);
        const tokenM = html.match(/name=["']authenticity_token["']\s+value=["']([^"']+)["']/i);
        const body = new URLSearchParams({
          login_email: account.email,
          login_pass: account.password,
          ...(tokenM?.[1] ? { authenticity_token: tokenM[1] } : {}),
        });
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
        const ok = res.status >= 200 && res.status < 400 && !/invalid|incorrect/i.test(loginText);
        return { ok, status: res.status, note: ok ? `logged in ${account.email}` : "login may have failed" };
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

    const pdp = await tStep("pdp_get", async () => {
      const res = await request(productUrl, {
        headers: navHeaders({ referer: `${base}/` }),
      }, ctx);
      const html = await readText(res);
      const ids = extractProductIds(html);
      const blocked = looksLikeCfChallenge(html, res.status);
      return {
        ok: res.status === 200 && Boolean(ids.productId || ids.variantId || task.variantId),
        status: res.status,
        note: blocked
          ? `WAF ${res.status}`
          : `productId=${ids.productId || "?"} variant=${ids.variantId || task.variantId || "?"}`,
        ids,
        title: ids.title,
        blocked,
      };
    });

    const productId = Number(task.productId || pdp.ids?.productId || 0) || null;
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

    const cart = await tStep("cart_create", async () => {
      const line = { quantity: qty, productId: productId || variantId };
      if (productId && variantId && productId !== variantId) line.variantId = variantId;
      const res = await request(`${base}/api/storefront/carts`, {
        method: "POST",
        headers: apiHeaders({ referer: productUrl, origin }),
        body: JSON.stringify({ lineItems: [line] }),
      }, ctx);
      const json = await readJson(res);
      const cartId = json?.id || json?.cartId || null;
      return {
        ok: Boolean(cartId) && res.status >= 200 && res.status < 300,
        status: res.status,
        note: cartId ? `cart ${cartId}` : `cart ${res.status}`,
        cartId,
        json,
      };
    });

    if (!cart.cartId) {
      return {
        ok: false,
        steps,
        error: "Storefront cart create failed",
        failedStep: "cart_create",
        checkoutStage: "cart",
        dryRun: !placeOrder,
        cookies: ctx.jar?.dump?.() ?? {},
      };
    }

    const checkoutId = cart.cartId;

    await tStep("checkout_get", async () => {
      const res = await request(
        `${base}/api/storefront/checkouts/${checkoutId}?include=cart.lineItems.physicalItems.options,customer,payments,promotions.banners`,
        { headers: apiHeaders({ referer: `${base}/checkout`, origin }) },
        ctx,
      );
      const json = await readJson(res);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, note: `checkout ${res.status}`, json };
    });

    const ship = {
      firstName: profile.first_name || "Test",
      lastName: profile.last_name || "Buyer",
      email: profile.email || "buyer@example.com",
      phone: profile.phone || "0400000000",
      address1: profile.address1 || "1 Test Street",
      city: profile.city || "Sydney",
      stateOrProvinceCode: profile.province || "NSW",
      postalCode: profile.zip || "2000",
      countryCode: "AU",
    };

    await tStep("checkout_set_address", async () => {
      const consignmentBody = [
        {
          shippingAddress: ship,
          lineItems: [{ itemId: cart.json?.lineItems?.physicalItems?.[0]?.id, quantity: qty }],
        },
      ];
      // Prefer item id from checkout if present later — best-effort.
      const res = await request(
        `${base}/api/storefront/checkouts/${checkoutId}/consignments?include=consignments.availableShippingOptions`,
        {
          method: "POST",
          headers: apiHeaders({ referer: `${base}/checkout`, origin }),
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
            headers: apiHeaders({ referer: `${base}/checkout`, origin }),
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
        headers: apiHeaders({ referer: `${base}/checkout`, origin }),
        body: JSON.stringify({ ...ship }),
      }, ctx);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        note: `billing ${res.status}`,
      };
    });

    let captchaToken = task.captchaToken || null;
    await tStep("checkout_spam", async () => {
      if (!captchaToken) {
        // Spam endpoint may 400 without token — still attempt; dry-run continues.
        return { ok: true, status: null, note: "no captcha token — skip spam-protection" };
      }
      const res = await request(`${base}/api/storefront/checkouts/${checkoutId}/spam-protection`, {
        method: "POST",
        headers: apiHeaders({ referer: `${base}/checkout`, origin }),
        body: JSON.stringify({ spamProtection: { method: "recaptcha_v2", token: captchaToken } }),
      }, ctx);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        note: `spam ${res.status}`,
      };
    });

    const paymentMethod = String(task.paymentMethod || "credit_card").toLowerCase();

    if (paymentMethod === "paypal_manual") {
      let paypalApproveUrl = null;
      await tStep("payment_paypal", async () => {
        const res = await request(`${base}/api/storefront/checkouts/${checkoutId}/payments`, {
          method: "POST",
          headers: apiHeaders({ referer: `${base}/checkout`, origin }),
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
      return { ok: true, status: null, note: "placeOrder armed — gateway fields may need HAR" };
    });

    let orderNumber = null;
    let paymentStatus = null;

    if (placeOrder && card?.ok) {
      const pay = await tStep("place_order", async () => {
        // Best-effort BC storefront instrument. Refine from operator HAR.
        const res = await request(`${base}/api/storefront/checkouts/${checkoutId}/orders`, {
          method: "POST",
          headers: apiHeaders({ referer: `${base}/checkout`, origin }),
          body: JSON.stringify({}),
        }, ctx);
        if (res.status >= 400) {
          const payRes = await request(`${base}/api/storefront/checkouts/${checkoutId}/payments`, {
            method: "POST",
            headers: apiHeaders({ referer: `${base}/checkout`, origin }),
            body: JSON.stringify({
              payment: {
                methodId: task.cardMethodId || "creditcard",
                paymentData: {
                  creditCardNumber: card.number,
                  creditCardName: card.holder,
                  creditCardMonth: Number(card.expMonth),
                  creditCardYear: Number(
                    card.expYear.length === 2 ? `20${card.expYear}` : card.expYear,
                  ),
                  creditCardCode: card.cvv,
                  shouldSaveInstrument: false,
                },
              },
            }),
          }, ctx);
          const payJson = await readJson(payRes);
          orderNumber = payJson?.order?.orderId || payJson?.id || payJson?.orderId || null;
          paymentStatus = payRes.status >= 200 && payRes.status < 300 ? "submitted" : "failed";
          return {
            ok: Boolean(orderNumber) || payRes.status < 300,
            status: payRes.status,
            note: orderNumber ? `order ${orderNumber}` : `payment ${payRes.status}`,
          };
        }
        const json = await readJson(res);
        orderNumber = json?.orderId || json?.id || null;
        paymentStatus = res.status >= 200 && res.status < 300 ? "submitted" : "failed";
        return {
          ok: Boolean(orderNumber) || res.status < 300,
          status: res.status,
          note: orderNumber ? `order ${orderNumber}` : `order ${res.status}`,
        };
      });

      return {
        ok: Boolean(orderNumber) || pay.ok,
        steps,
        checkoutStage: orderNumber ? "order" : "tokenize",
        dryRun: false,
        orderNumber,
        orderId: orderNumber,
        paymentStatus,
        paymentMethod: "credit_card",
        finalUrl: orderNumber ? `${base}/checkout/order-confirmation` : `${base}/checkout`,
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
      note: "Dry-run reached checkout scaffold — supply HAR to lock live card tokenize",
    };
  },
};
