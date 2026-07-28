/**
 * Fly executor proxy helpers + lab payload builders for phone Bot admin.
 */
import { parseProxy } from "../monitor/http-undici.js";

function executorConfig() {
  const url = String(process.env.EXECUTOR_URL || "https://j1ms-bot-executor.fly.dev")
    .trim()
    .replace(/\/+$/, "");
  const token = String(process.env.EXECUTOR_TOKEN || "").trim();
  return { url, token, configured: Boolean(url && token) };
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: object, timeoutMs?: number }} [opts]
 */
export async function executorFetch(path, opts = {}) {
  const { url, token, configured } = executorConfig();
  if (!configured) {
    return { ok: false, error: "EXECUTOR_URL / EXECUTOR_TOKEN not set on Railway", status: 503 };
  }
  const method = opts.method || "GET";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}${path.startsWith("/") ? path : `/${path}`}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(opts.body ? { "content-type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : json?.error || `http_${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === "AbortError" ? "timeout" : e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

export function executorStatus() {
  return executorConfig();
}

function firstProxyLine(raw) {
  for (const line of String(raw || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const url = parseProxy(t);
    if (url) return { raw: t, url };
  }
  return null;
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build Bandai /run body from vault + form.
 * @param {object} form
 * @param {object} vault
 */
export function buildBandaiLabPayload(form, vault) {
  const mode = String(form.mode || "login_check").toLowerCase();
  const area = String(form.area || vault.defaults?.bandaiArea || "au")
    .trim()
    .toLowerCase();
  const sku = String(form.sku || vault.defaults?.bandaiSku || "").trim();
  const placeOrder = form.placeOrder === true && mode === "checkout";

  if (!["login_check", "checkout"].includes(mode)) {
    return { ok: false, error: "mode must be login_check or checkout" };
  }

  const accountId = form.accountId || null;
  let account = null;
  if (form.email && form.password) {
    account = { email: String(form.email).trim(), password: String(form.password) };
  } else if (accountId) {
    const hit = (vault.accounts || []).find((a) => a.id === accountId);
    if (hit) account = { email: hit.email, password: hit.password, id: hit.id };
  } else if ((vault.accounts || []).length === 1) {
    const hit = vault.accounts[0];
    account = { email: hit.email, password: hit.password, id: hit.id };
  }
  if (!account?.email || !account?.password) {
    return { ok: false, error: "Bandai account required (vault or paste email/password)" };
  }

  const proxyPick = firstProxyLine(form.proxy || vault.checkoutProxies);
  if (!proxyPick) {
    return { ok: false, error: "Checkout proxy required — paste an ISP line in Bot vault" };
  }

  const profile = vault.profile || {};
  const storeUrl =
    mode === "login_check" || !sku
      ? `https://p-bandai.com/${area}/`
      : /^https?:\/\//i.test(sku)
        ? sku
        : `https://p-bandai.com/${area}/item/${sku}`;

  let card = null;
  if (placeOrder) {
    const pan = String(profile.card_number || "").replace(/\s+/g, "");
    const cvv = String(profile.card_cvv || "").trim();
    const mm = String(profile.card_exp_month || "").trim();
    const yy = String(profile.card_exp_year || "").trim();
    if (pan.length < 12 || !cvv || !mm || !yy) {
      return { ok: false, error: "Live placeOrder needs full card on Bot vault profile" };
    }
    card = {
      number: pan,
      cvv,
      expMonth: mm.padStart(2, "0").slice(-2),
      expYear: yy.replace(/^20/, "").slice(-2),
      holder:
        String(profile.card_name || "").trim() ||
        [profile.first_name, profile.last_name].filter(Boolean).join(" ") ||
        "Cardholder",
    };
  }

  const taskId = String(form.taskId || id("bandai")).slice(0, 80);
  return {
    ok: true,
    data: {
      taskId,
      storeUrl,
      pdpUrl: storeUrl,
      variantId: 1,
      qty: Math.max(1, Math.min(5, Number(form.qty) || 1)),
      proxy: proxyPick.raw,
      dryRun: !placeOrder,
      placeOrder,
      debugTrace: true,
      forceUndici: true,
      forceTls: false,
      bandaiMode: mode,
      bandaiArea: area,
      shippingAreaCode: area,
      bandaiF5Bridge: true,
      areaItemNo: form.areaItemNo || undefined,
      account,
      profile: {
        email: profile.email || account.email,
        first_name: profile.first_name || null,
        last_name: profile.last_name || null,
        address1: profile.address1 || null,
        city: profile.city || null,
        province: profile.province || null,
        zip: profile.zip || null,
        phone: profile.phone || null,
      },
      ...(card ? { card } : {}),
    },
    meta: { store: "bandai", mode, sku: sku || null, placeOrder, proxyHost: proxyPick.url },
  };
}

/**
 * @param {object} form
 * @param {object} vault
 */
export function buildKmartLabPayload(form, vault) {
  const storeUrl = String(form.storeUrl || vault.defaults?.kmartUrl || "").trim();
  const variantId = Number(form.variantId || vault.defaults?.kmartVariantId || 0);
  if (!storeUrl || !variantId) {
    return { ok: false, error: "Kmart needs storeUrl + variantId" };
  }
  const placeOrder = form.placeOrder === true;
  const proxyPick = firstProxyLine(form.proxy || vault.checkoutProxies);
  const profile = vault.profile || {};
  let card = null;
  if (placeOrder) {
    const pan = String(profile.card_number || "").replace(/\s+/g, "");
    const cvv = String(profile.card_cvv || "").trim();
    const mm = String(profile.card_exp_month || "").trim();
    const yy = String(profile.card_exp_year || "").trim();
    if (pan.length < 12 || !cvv || !mm || !yy) {
      return { ok: false, error: "Live placeOrder needs full card on Bot vault profile" };
    }
    card = {
      number: pan,
      cvv,
      expMonth: mm.padStart(2, "0").slice(-2),
      expYear: yy.replace(/^20/, "").slice(-2),
      holder: String(profile.card_name || "").trim() || "Cardholder",
    };
  }
  const taskId = String(form.taskId || id("kmart")).slice(0, 80);
  return {
    ok: true,
    data: {
      taskId,
      storeUrl,
      variantId,
      qty: Math.max(1, Math.min(5, Number(form.qty) || 1)),
      proxy: proxyPick?.raw || null,
      useProxy: Boolean(proxyPick),
      dryRun: !placeOrder,
      placeOrder,
      debugTrace: true,
      forceUndici: true,
      profile: {
        email: profile.email || null,
        first_name: profile.first_name || null,
        last_name: profile.last_name || null,
        address1: profile.address1 || null,
        city: profile.city || null,
        province: profile.province || null,
        zip: profile.zip || null,
        phone: profile.phone || null,
      },
      ...(card ? { card } : {}),
    },
    meta: { store: "kmart", mode: placeOrder ? "checkout" : "dry", placeOrder },
  };
}

export function redactRunPayload(data) {
  if (!data || typeof data !== "object") return data;
  const out = { ...data };
  if (out.card) {
    const n = String(out.card.number || "");
    out.card = { last4: n.slice(-4), expMonth: out.card.expMonth, expYear: out.card.expYear };
  }
  if (out.account) {
    out.account = { email: out.account.email, id: out.account.id || null };
  }
  if (out.proxy) {
    out.proxy = String(out.proxy).replace(/:[^:@/]+@/, ":***@").replace(/:([^:]+):([^:]+)$/, ":$1:***");
  }
  return out;
}
