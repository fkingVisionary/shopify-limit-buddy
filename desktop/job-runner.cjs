// Bounded local job queue. Stability first: cap concurrent /run calls so
// Chromium 3DS tails don't OOM the machine. Store adapters plug in via
// buildPayload(store) — Kmart + Toymate + Bandai + Pokémon Centre (isolated).
//
// Kmart payload shape intentionally mirrors src/lib/kmart-task.ts
// buildKmartExecutorPayload so behaviour matches the web → Fly path.
// Single undici attempt — no TLS/Playwright auto-retry ladder (not scalable).

const sidecar = require("./executor-sidecar.cjs");
const { id } = require("./store.cjs");
const { normalizeKmartProxy } = require("./proxy-format.cjs");
const {
  formatExecutorFailure,
  isAkamaiWwwBlocked,
  isProxyEgressFailed,
  summarizePayload,
} = require("./run-format.cjs");
const { consumerProgressMessage, consumerOutcome } = require("./consumer-status.cjs");
const { resolveAccountForTask } = require("./account-assign.cjs");
const { resolveDesktopBandaiPayPath } = require("./bandai-pay-path.cjs");
const { vaultRegisteredEmails, findRegisteredAccount } = require("./account-vault.cjs");
const {
  shouldCheckoutOnMonitorHit,
  taskForMonitorCheckout,
} = require("./bandai-monitor-checkout.cjs");

let queue = [];
let inflight = 0;
let running = false;
let maxConcurrent = 5;
let emit = () => {};
let onFinished = null;
/** @type {null | (() => object|null)} */
let takeBandaiHarvestFn = null;

function setEmitter(fn) {
  emit = typeof fn === "function" ? fn : () => {};
}

function setFinishedHandler(fn) {
  onFinished = typeof fn === "function" ? fn : null;
}

function configure(opts = {}) {
  const n = opts.maxConcurrent;
  if (n != null) maxConcurrent = Math.max(1, Math.min(50, Number(n) || 5));
  if (Object.prototype.hasOwnProperty.call(opts, "takeBandaiHarvest")) {
    takeBandaiHarvestFn = typeof opts.takeBandaiHarvest === "function" ? opts.takeBandaiHarvest : null;
  }
}

function state() {
  return {
    running,
    inflight,
    queued: queue.length,
    maxConcurrent,
  };
}

/** @deprecated use normalizeKmartProxy — kept for tests */
function normalizeProxy(raw) {
  const r = normalizeKmartProxy(raw);
  return r.ok ? r.proxy : null;
}

/** Sticky markers — keep in sync with executor/http.js isStickyProxyUrl. */
function isStickyProxy(proxyUrl) {
  const s = String(proxyUrl || "");
  if (/session-[A-Za-z0-9]+|sessid=|sessionid=|-sid-[A-Za-z0-9]+/i.test(s)) return true;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(u.hostname) && u.username) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Mint a fresh sticky-session token (Noontide session- / IP Fist -sid-).
 * Bare-IP ISP URLs are unchanged.
 */
function rotateStickyProxySession(proxyUrl, { force = false } = {}) {
  if (!proxyUrl) return proxyUrl;
  if (!force && process.env.DESKTOP_ROTATE_PROXY_SESSION !== "1") return proxyUrl;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const s = String(proxyUrl);
  if (/-sid-[A-Za-z0-9]+/i.test(s)) return s.replace(/-sid-[A-Za-z0-9]+/i, `-sid-${stamp}`);
  if (/session-[A-Za-z0-9]+/i.test(s)) return s.replace(/session-[A-Za-z0-9]+/i, `session-${stamp}`);
  return proxyUrl;
}

function buildKmartPayload({ task, profile, proxyRaw, placeOrder, rotateSession }) {
  const pdp = String(task.pdpUrl || task.storeUrl || "").trim();
  if (!/^https:\/\/(www\.)?kmart\.com\.au\//i.test(pdp)) {
    return { ok: false, error: "Kmart PDP URL required" };
  }

  const proxyNorm = normalizeKmartProxy(proxyRaw);
  if (!proxyNorm.ok) return { ok: false, error: proxyNorm.error };

  const pan = String(profile?.card_number || "").replace(/\s+/g, "");
  const cvv = String(profile?.card_cvv || "").trim();
  const mm = String(profile?.card_exp_month || "").trim();
  const yy = String(profile?.card_exp_year || "").trim();
  const holder =
    String(profile?.card_name || "").trim() ||
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() ||
    "Cardholder";

  if (placeOrder && (pan.length < 12 || cvv.length < 3 || !mm || yy.length < 2)) {
    return { ok: false, error: "Place order needs complete card on the profile" };
  }

  const card =
    pan.length >= 12 && cvv.length >= 3
      ? {
          number: pan,
          cvv,
          expMonth: mm.padStart(2, "0").slice(-2),
          expYear: yy.slice(-2),
          holder,
        }
      : null;

  // Match src/lib/kmart-task.ts buildKmartExecutorPayload (dashboard → Fly).
  // Proxy is always the task's proxy group entry. Sticky resi mints a fresh
  // session- token when rotateSession is set (dead exits stay burned forever).
  // ISP has no session- marker — rotate is a no-op.
  const proxy = rotateStickyProxySession(proxyNorm.proxy, {
    force: rotateSession === true || process.env.DESKTOP_ROTATE_PROXY_SESSION === "1",
  });
  return {
    ok: true,
    data: {
      taskId: task.runId || task.id || id("run"),
      storeUrl: pdp,
      variantId: Number(task.variantId) || 1,
      qty: Math.max(1, Math.min(20, Number(task.qty) || 1)),
      proxy,
      dryRun: !placeOrder,
      placeOrder: Boolean(placeOrder),
      debugTrace: true,
      kmartMode: "current",
      profile: {
        email: profile?.email || null,
        first_name: profile?.first_name || null,
        last_name: profile?.last_name || null,
        address1: profile?.address1 || null,
        city: profile?.city || null,
        province: profile?.province || null,
        zip: profile?.zip || null,
        phone: profile?.phone || null,
      },
      card,
      placeOrderMutation: task.placeOrderMutation || null,
    },
  };
}

function buildToymatePayload({ task, profile, proxyRaw, placeOrder, rotateSession, accounts, excludeAccountIds }) {
  const mode = String(task.toymateMode || "checkout").toLowerCase();
  const input = String(task.pdpUrl || task.input || task.storeUrl || "").trim();
  if (mode !== "account_gen" && !/^https:\/\/(www\.)?toymate\.com\.au\//i.test(input)) {
    return { ok: false, error: "Toymate product URL required (or use Account gen mode)" };
  }

  const proxyNorm = normalizeKmartProxy(proxyRaw); // same URL normalisation; store-agnostic parser
  if (!proxyNorm.ok) return { ok: false, error: proxyNorm.error };

  const pan = String(profile?.card_number || "").replace(/\s+/g, "");
  const cvv = String(profile?.card_cvv || "").trim();
  const mm = String(profile?.card_exp_month || "").trim();
  const yy = String(profile?.card_exp_year || "").trim();
  const holder =
    String(profile?.card_name || "").trim() ||
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() ||
    "Cardholder";

  const wantsPlace = mode === "checkout" && placeOrder;
  if (wantsPlace && (pan.length < 12 || cvv.length < 3 || !mm || yy.length < 2)) {
    return { ok: false, error: "Place order needs complete card on the profile" };
  }

  const card =
    pan.length >= 12 && cvv.length >= 3
      ? {
          number: pan,
          cvv,
          expMonth: mm.padStart(2, "0").slice(-2),
          expYear: yy.slice(-2),
          holder,
        }
      : null;

  const proxy = rotateStickyProxySession(proxyNorm.proxy, {
    force: rotateSession === true || process.env.DESKTOP_ROTATE_PROXY_SESSION === "1",
  });

  const storeUrl =
    mode === "account_gen"
      ? "https://www.toymate.com.au"
      : input || "https://www.toymate.com.au";

  // Checkout: vault login — prefer pre-resolved task.account from main enqueue.
  let resolvedAccount = null;
  let accountAssignSource = null;
  if (mode === "checkout") {
    const assign = String(task.accountAssign || "auto").toLowerCase();
    if (assign === "guest" || assign === "none" || task.accountAssignSource === "guest") {
      resolvedAccount = null;
      accountAssignSource = "guest";
    } else if (task.account?.email && task.account?.password) {
      resolvedAccount = {
        email: task.account.email,
        password: task.account.password,
        id: task.account.id || null,
      };
      accountAssignSource = task.accountAssignSource || "pre";
    } else {
      const resolved = resolveAccountForTask({
        task,
        profile,
        accounts: accounts || task._accounts || [],
        excludeIds: excludeAccountIds || task._excludeAccountIds || [],
      });
      if (resolved.error) {
        return { ok: false, error: resolved.error };
      }
      resolvedAccount = resolved.account
        ? {
            email: resolved.account.email,
            password: resolved.account.password,
            id: resolved.account.id,
          }
        : null;
      accountAssignSource = resolved.source;
    }
  }

  return {
    ok: true,
    data: {
      taskId: task.runId || task.id || id("run"),
      storeUrl,
      pdpUrl: mode === "account_gen" ? storeUrl : input,
      variantId: Number(task.variantId) || 1,
      qty: Math.max(1, Math.min(20, Number(task.qty) || 1)),
      proxy,
      dryRun: mode !== "checkout" ? true : !placeOrder,
      placeOrder: mode === "checkout" ? Boolean(placeOrder) : false,
      debugTrace: true,
      // Force undici — Toymate CF path was proven without tls-worker.
      forceUndici: true,
      forceTls: false,
      toymateMode: mode,
      paymentMethod: task.paymentMethod || "credit_card",
      captchaToken: task.captchaToken || null,
      accountPassword:
        typeof task.accountPassword === "string" && task.accountPassword.trim()
          ? task.accountPassword.trim()
          : null,
      account: resolvedAccount,
      accountAssignSource,
      harvestedSession:
        task.harvestedSession && typeof task.harvestedSession === "object"
          ? {
              id: task.harvestedSession.id || null,
              proxy: task.harvestedSession.proxy || null,
              proxyHost: task.harvestedSession.proxyHost || null,
              userAgent: task.harvestedSession.userAgent || null,
              cookies: task.harvestedSession.cookies || {},
              captchaToken: task.harvestedSession.captchaToken || null,
              harvestedAt: task.harvestedSession.harvestedAt || null,
              cfExpiresAt: task.harvestedSession.cfExpiresAt || null,
              spamExpiresAt: task.harvestedSession.spamExpiresAt || null,
            }
          : null,
      captchaToken:
        task.captchaToken ||
        task.harvestedSession?.captchaToken ||
        null,
      profile: {
        email: profile?.email || null,
        first_name: profile?.first_name || null,
        last_name: profile?.last_name || null,
        address1: profile?.address1 || null,
        city: profile?.city || null,
        province: profile?.province || null,
        zip: profile?.zip || null,
        phone: profile?.phone || null,
      },
      card: mode === "checkout" ? card : null,
    },
  };
}

function buildBandaiPayload({
  task,
  profile,
  proxyRaw,
  placeOrder,
  rotateSession,
  accounts,
  excludeAccountIds,
  settings,
}) {
  const mode = String(task.bandaiMode || "checkout").toLowerCase();
  const input = String(task.pdpUrl || task.input || task.storeUrl || "").trim();
  const REGION_RE = /^(au|us|nz|sg|hk|tw|fr)$/i;
  const areaFromUrl = (input.match(/p-bandai\.com\/([a-z]{2})(?:\/|$)/i) || [])[1];
  const bandaiArea = String(task.bandaiArea || task.areaCode || areaFromUrl || "au")
    .trim()
    .toLowerCase();
  if (!REGION_RE.test(bandaiArea)) {
    return {
      ok: false,
      error: `Unsupported Bandai region "${bandaiArea}" (use au/us/nz/sg/hk/tw/fr — not jp)`,
    };
  }
  if (
    mode !== "account_gen" &&
    mode !== "monitor" &&
    mode !== "chance" &&
    input &&
    !/^https:\/\/(www\.)?p-bandai\.com\//i.test(input) &&
    !/^[A-Za-z0-9_-]+$/.test(input)
  ) {
    return {
      ok: false,
      error: "Bandai product URL (p-bandai.com/{au|us|…}/item/…) or product code required",
    };
  }

  const proxyNorm = normalizeKmartProxy(proxyRaw);
  if (!proxyNorm.ok) return { ok: false, error: proxyNorm.error };

  // Harvested F5 bridges are IP-bound — never rotate sticky session on claim.
  const harvestedProxy =
    typeof task.harvestedProxy === "string" && task.harvestedProxy.trim()
      ? task.harvestedProxy.trim()
      : typeof task.proxyOverride === "string" && task.proxyOverride.trim()
        ? task.proxyOverride.trim()
        : null;
  const harvestedBridgeId =
    typeof task.harvestedBridgeId === "string" && task.harvestedBridgeId.trim()
      ? task.harvestedBridgeId.trim()
      : null;

  const proxy = harvestedProxy
    ? harvestedProxy
    : rotateStickyProxySession(proxyNorm.proxy, {
        force: rotateSession === true || process.env.DESKTOP_ROTATE_PROXY_SESSION === "1",
      });

  const storeUrl =
    mode === "account_gen" || mode === "monitor" || !input
      ? `https://p-bandai.com/${bandaiArea}/`
      : /^https?:\/\//i.test(input)
        ? input
        : `https://p-bandai.com/${bandaiArea}/item/${input}`;

  let resolvedAccount = null;
  let accountAssignSource = null;
  if (mode === "checkout" || mode === "chance") {
    if (task.account?.email && task.account?.password) {
      resolvedAccount = {
        email: task.account.email,
        password: task.account.password,
        id: task.account.id || null,
      };
      accountAssignSource = task.accountAssignSource || "pre";
    } else {
      const resolved = resolveAccountForTask({
        task,
        profile,
        accounts: accounts || task._accounts || [],
        excludeIds: excludeAccountIds || task._excludeAccountIds || [],
      });
      if (resolved.error) {
        return { ok: false, error: resolved.error };
      }
      resolvedAccount = resolved.account
        ? {
            email: resolved.account.email,
            password: resolved.account.password,
            id: resolved.account.id,
          }
        : null;
      accountAssignSource = resolved.source;
    }
    if (!resolvedAccount?.email || !resolvedAccount?.password) {
      return {
        ok: false,
        error: "Bandai login required — generate an account or assign one from the vault",
      };
    }
  }

  const s = settings || task._settings || {};
  const otp = {
    smsProvider: String(s.smsProvider || "auto").trim().toLowerCase(),
    smspoolApiKey: String(s.smspoolApiKey || "").trim(),
    smspoolCountry: String(s.smspoolCountry || "GB").trim(),
    onlinesimApiKey: String(s.onlinesimApiKey || "").trim(),
    onlinesimMode: String(s.onlinesimMode || "rent"),
    onlinesimServiceSlug: String(s.onlinesimServiceSlug || "other"),
    onlinesimCountry: 61,
    imapHost: String(s.imapHost || "").trim(),
    imapPort: Number(s.imapPort) || 993,
    imapUser: String(s.imapUser || "").trim(),
    imapAppPassword: String(s.imapAppPassword || "").trim(),
    imapMailbox: String(s.imapMailbox || "INBOX"),
  };

  const vaultEmails = vaultRegisteredEmails(accounts || task._accounts || [], "bandai");

  if (mode === "account_gen") {
    const hasSms = Boolean(otp.smspoolApiKey || otp.onlinesimApiKey);
    if (!hasSms) {
      return { ok: false, error: "SMSPool (preferred) or OnlineSim API key missing in Settings" };
    }
    if (!otp.imapHost || !otp.imapUser || !otp.imapAppPassword) {
      return { ok: false, error: "IMAP host/user/app password required in Settings" };
    }
    // Without uniquify, refuse if this exact signup email is already vault-registered.
    const signupGuess = String(
      task.signupEmail || profile?.email || otp.imapUser || "",
    )
      .trim()
      .toLowerCase();
    const domain = signupGuess.split("@")[1] || "";
    const catchallUniquify = domain === "bullposted.com";
    const forceUniquify = task.uniquifyEmail === true || task.bandaiUniquifyEmail === true;
    const willUniquify = forceUniquify || catchallUniquify;
    if (signupGuess && !willUniquify) {
      const hit = findRegisteredAccount({
        accounts: accounts || task._accounts || [],
        storeId: "bandai",
        email: signupGuess,
        matchBase: false,
      });
      if (hit) {
        return {
          ok: false,
          error: `Bandai account already in vault for ${hit.email} (${hit.status}) — use checkout or delete the vault row before re-registering`,
        };
      }
    }
  }

  let card = null;
  if (mode === "checkout" && placeOrder) {
    const pan = String(profile?.card_number || "").replace(/\s+/g, "");
    const cvv = String(profile?.card_cvv || "").trim();
    const mm = String(profile?.card_exp_month || "").trim();
    const yy = String(profile?.card_exp_year || "").trim();
    const holder =
      String(profile?.card_name || "").trim() ||
      [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
      "Cardholder";
    if (!pan || !cvv || !mm || !yy) {
      return { ok: false, error: "Place order needs complete card on the profile" };
    }
    card = {
      number: pan,
      expMonth: mm.padStart(2, "0"),
      expYear: yy.replace(/^20/, "").slice(-2),
      cvv,
      holder,
    };
  }

  return {
    ok: true,
    data: {
      taskId: task.runId || task.id || id("run"),
      storeUrl,
      pdpUrl: mode === "account_gen" ? storeUrl : input || storeUrl,
      variantId: Number(task.variantId) || 1,
      qty: Math.max(1, Math.min(5, Number(task.qty) || 1)),
      proxy,
      dryRun: mode !== "checkout" ? true : !placeOrder,
      placeOrder: mode === "checkout" ? Boolean(placeOrder) : false,
      debugTrace: true,
      forceUndici: true,
      forceTls: false,
      // ATC always HTTP+F5. Pay path: fast=HTTP GE+riskHydrate, safe=Playwright GE.
      ...resolveDesktopBandaiPayPath(task, {
        mode,
        placeOrder: mode === "checkout" ? Boolean(placeOrder) : false,
      }),
      bandaiF5Bridge: task.bandaiF5Bridge !== false,
      bandaiMode: mode,
      bandaiArea,
      shippingAreaCode: task.shippingAreaCode || bandaiArea,
      // Backend ATC id (NAI…) — preferred over frontend PDP N-code under load.
      areaItemNo:
        typeof task.bandaiAreaItemNo === "string" && task.bandaiAreaItemNo.trim()
          ? task.bandaiAreaItemNo.trim()
          : typeof task.bandaiBackendPid === "string" && task.bandaiBackendPid.trim()
            ? task.bandaiBackendPid.trim()
            : typeof task.areaItemNo === "string" && task.areaItemNo.trim()
              ? task.areaItemNo.trim()
              : undefined,
      bandaiAreaItemNo:
        typeof task.bandaiAreaItemNo === "string" && task.bandaiAreaItemNo.trim()
          ? task.bandaiAreaItemNo.trim()
          : undefined,
      harvestedBridgeId: harvestedBridgeId || undefined,
      bandaiMonitorMode: mode === "monitor" ? task.bandaiMonitorMode || "local" : undefined,
      bandaiWatchSku: task.bandaiWatchSku || null,
      bandaiWatchKeywords: task.bandaiWatchKeywords || null,
      bandaiMonitorIntervalMs:
        mode === "monitor"
          ? Math.max(2000, Number(task.bandaiMonitorIntervalMs) || 10000)
          : undefined,
      bandaiMonitorDelayMs:
        mode === "monitor" ? Math.max(0, Number(task.bandaiMonitorDelayMs) || 0) : undefined,
      keywords:
        mode === "monitor"
          ? task.bandaiWatchKeywords || task.keywords || input || null
          : undefined,
      productId: mode === "monitor" ? task.bandaiWatchSku || null : undefined,
      card,
      campaignSn: task.campaignSn || null,
      accountPassword:
        typeof task.accountPassword === "string" && task.accountPassword.trim()
          ? task.accountPassword.trim()
          : null,
      account: resolvedAccount,
      accountAssignSource,
      otp: mode === "account_gen" ? otp : undefined,
      // Exact Bandai memberIds already vault-registered — agen must not re-register.
      vaultEmails: mode === "account_gen" ? vaultEmails : undefined,
      uniquifyEmail:
        mode === "account_gen"
          ? task.uniquifyEmail === true || task.bandaiUniquifyEmail === true || undefined
          : undefined,
      profile: {
        email: profile?.email || null,
        first_name: profile?.first_name || null,
        last_name: profile?.last_name || null,
        address1: profile?.address1 || null,
        city: profile?.city || null,
        province: profile?.province || null,
        zip: profile?.zip || null,
        phone: profile?.phone || null,
      },
    },
  };
}

function buildPokemonCentrePayload({
  task,
  profile,
  proxyRaw,
  placeOrder,
  rotateSession,
}) {
  const mode = String(task.pcMode || task.pokemoncentreMode || "monitor").toLowerCase();
  const input = String(task.pdpUrl || task.input || task.storeUrl || "").trim();
  const localeRaw = String(task.pcLocale || task.locale || "").trim().toLowerCase();
  const localeFromUrl = (input.match(/pokemoncenter\.com\/(en-[a-z]{2})(?:\/|$)/i) || [])[1];
  let pcLocale = localeRaw || localeFromUrl || "en-au";
  if (/^(au|enau)$/i.test(pcLocale)) pcLocale = "en-au";
  if (/^(nz|ennz)$/i.test(pcLocale)) pcLocale = "en-nz";
  if (!/^en-(au|nz|ca|gb|us)$/i.test(pcLocale)) {
    return {
      ok: false,
      error: `Unsupported Pokémon Centre locale "${pcLocale}" (use en-au/en-nz/en-ca/en-gb/en-us — not JP online)`,
    };
  }

  if (
    mode !== "edge" &&
    mode !== "monitor" &&
    mode !== "har_probe" &&
    input &&
    !/^https:\/\/(www\.)?pokemoncenter\.com\//i.test(input) &&
    !/^[A-Za-z0-9._-]+$/.test(input)
  ) {
    return {
      ok: false,
      error: "Pokémon Centre PDP URL (pokemoncenter.com/en-au/product/…) or SKU required",
    };
  }

  const proxyNorm = normalizeKmartProxy(proxyRaw);
  if (!proxyNorm.ok) return { ok: false, error: proxyNorm.error };

  const proxy = rotateStickyProxySession(proxyNorm.proxy, {
    force: rotateSession === true || process.env.DESKTOP_ROTATE_PROXY_SESSION === "1",
  });

  const storeUrl =
    mode === "edge" || mode === "monitor" || mode === "har_probe" || !input
      ? `https://www.pokemoncenter.com/${pcLocale}/`
      : /^https?:\/\//i.test(input)
        ? input
        : `https://www.pokemoncenter.com/${pcLocale}/product/${input}`;

  let card = null;
  if (mode === "checkout" && placeOrder) {
    const pan = String(profile?.card_number || "").replace(/\s+/g, "");
    const cvv = String(profile?.card_cvv || "").trim();
    const mm = String(profile?.card_exp_month || "").trim();
    const yy = String(profile?.card_exp_year || "").trim();
    const holder =
      String(profile?.card_name || "").trim() ||
      [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
      "Cardholder";
    if (!pan || !cvv || !mm || !yy) {
      return { ok: false, error: "Place order needs complete card on the profile" };
    }
    card = {
      number: pan,
      expMonth: mm.padStart(2, "0"),
      expYear: yy.replace(/^20/, "").slice(-2),
      cvv,
      holder,
    };
  }

  return {
    ok: true,
    data: {
      taskId: task.runId || task.id || id("run"),
      storeUrl,
      pdpUrl: mode === "edge" ? storeUrl : input || storeUrl,
      variantId: Number(task.variantId) || 1,
      sku: task.sku || (!/^https?:/i.test(input) ? input : undefined) || undefined,
      qty: Math.max(1, Math.min(5, Number(task.qty) || 1)),
      proxy,
      dryRun: mode !== "checkout" ? true : !placeOrder,
      placeOrder: mode === "checkout" ? Boolean(placeOrder) : false,
      debugTrace: true,
      forceUndici: true,
      forceTls: false,
      pcMode: mode,
      pcLocale,
      pcBrowserCheckout:
        task.pcBrowserCheckout === true || (mode === "checkout" && Boolean(placeOrder)),
      globaleMid: task.globaleMid || task.geMerchantId || undefined,
      card,
      profile: {
        email: profile?.email || null,
        first_name: profile?.first_name || null,
        last_name: profile?.last_name || null,
        address1: profile?.address1 || null,
        city: profile?.city || null,
        province: profile?.province || null,
        zip: profile?.zip || null,
        phone: profile?.phone || null,
      },
    },
  };
}

function buildDisneyPayload({ task, profile, proxyRaw, placeOrder }) {
  const mode = String(task.disneyMode || "pay").toLowerCase();
  const DEFAULT_PDP =
    "https://www.disneystore.com.au/disney-lorcana-trading-card-game-by-ravensburger-gateway-050368983992.html";
  const input = String(task.pdpUrl || task.input || task.storeUrl || "").trim() || DEFAULT_PDP;
  if (
    input &&
    !/^https:\/\/(www\.)?(disneystore|shopdisney)\.com\.au\//i.test(input) &&
    !/^\d{6,}$/.test(input)
  ) {
    return {
      ok: false,
      error: "Disney PDP URL (disneystore.com.au/…html) or pid required",
    };
  }

  const harvested =
    task.harvestedSession && typeof task.harvestedSession === "object"
      ? task.harvestedSession
      : null;

  const proxyNorm = normalizeKmartProxy(harvested?.proxy || proxyRaw);
  if (!proxyNorm.ok) return { ok: false, error: proxyNorm.error };

  // Harvested Akamai jars are exit-bound — never rotate sticky session on claim.
  const proxy = harvested?.proxy
    ? String(harvested.proxy).trim()
    : rotateStickyProxySession(proxyNorm.proxy, {
        force: process.env.DESKTOP_ROTATE_PROXY_SESSION === "1",
      });

  const pdpUrl = /^https?:\/\//i.test(input)
    ? input
    : /^\d{6,}$/.test(input)
      ? DEFAULT_PDP.replace(/\d{6,}(?=\.html)/, input)
      : DEFAULT_PDP;

  const pan = String(profile?.card_number || "").replace(/\s+/g, "");
  const cvv = String(profile?.card_cvv || "").trim();
  const mm = String(profile?.card_exp_month || "").trim();
  const yy = String(profile?.card_exp_year || "").trim();
  const holder =
    String(profile?.card_name || "").trim() ||
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() ||
    "Cardholder";

  const wantsPay = mode === "pay" || mode === "checkout" || mode === "ge";
  if (placeOrder && wantsPay && (pan.length < 12 || cvv.length < 3 || !mm || yy.length < 2)) {
    return { ok: false, error: "Place order needs complete card on the profile" };
  }

  const card =
    pan.length >= 12 && cvv.length >= 3
      ? {
          number: pan,
          cvv,
          expMonth: mm.padStart(2, "0").slice(-2),
          expYear: yy.length === 2 ? `20${yy}` : yy,
          name: holder,
          holder,
        }
      : null;

  const disneyMode = ["warm", "monitor", "atc", "ge", "pay", "checkout"].includes(mode)
    ? mode === "checkout"
      ? "pay"
      : mode
    : "pay";

  return {
    ok: true,
    data: {
      taskId: task.runId || task.id || id("run"),
      storeUrl: "https://www.disneystore.com.au",
      pdpUrl,
      disneyMode,
      disneyGePay: disneyMode === "pay" || disneyMode === "ge",
      quantity: Math.max(1, Math.min(20, Number(task.qty) || 1)),
      proxy,
      dryRun: !placeOrder,
      placeOrder: Boolean(placeOrder) && wantsPay,
      fakeDecline: !placeOrder && wantsPay,
      debugTrace: true,
      // Empty harvest → cold path; claim sets harvestedSession + same sticky proxy.
      harvestedSession: harvested
        ? {
            id: harvested.id || null,
            proxy: harvested.proxy || null,
            proxyHost: harvested.proxyHost || null,
            userAgent: harvested.userAgent || null,
            cookies: harvested.cookies || {},
            captchaToken: harvested.captchaToken || null,
            harvestedAt: harvested.harvestedAt || null,
            abckExpiresAt: harvested.abckExpiresAt || null,
            captchaExpiresAt: harvested.captchaExpiresAt || null,
            egressIp: harvested.egressIp || null,
            captchaSitekey: harvested.captchaSitekey || null,
            captchaAction: harvested.captchaAction || "AddToCart",
            pdpUrl: harvested.pdpUrl || pdpUrl,
            origin: harvested.origin || "https://www.disneystore.com.au",
            abckValid: true,
          }
        : null,
      recaptchaToken: task.recaptchaToken || harvested?.captchaToken || null,
      preferLastGoodProxy: !harvested,
      profile: {
        email: profile?.email || null,
        first_name: profile?.first_name || null,
        last_name: profile?.last_name || null,
        address1: profile?.address1 || null,
        city: profile?.city || null,
        province: profile?.province || null,
        zip: profile?.zip || null,
        phone: profile?.phone || null,
      },
      guest: {
        email: profile?.email || "disney.checkout@example.com",
        firstName: profile?.first_name || "Test",
        lastName: profile?.last_name || "User",
        address1: profile?.address1 || "1 George Street",
        city: profile?.city || "Sydney",
        zip: profile?.zip || "2000",
        phone: profile?.phone || "0412345678",
        stateId: "49179",
      },
      card: wantsPay ? card : null,
    },
  };
}

function buildPayload(job) {
  const store = job.task?.store || "kmart";
  if (store === "kmart") {
    return buildKmartPayload(job);
  }
  if (store === "toymate") {
    return buildToymatePayload(job);
  }
  if (store === "bandai") {
    return buildBandaiPayload(job);
  }
  if (store === "disney") {
    return buildDisneyPayload(job);
  }
  if (store === "pokemoncentre" || store === "pokemon" || store === "pokemoncenter") {
    return buildPokemonCentrePayload(job);
  }
  return { ok: false, error: `Store adapter not installed yet: ${store}` };
}

function enqueue(jobs) {
  const list = Array.isArray(jobs) ? jobs : [jobs];
  for (const job of list) {
    queue.push({
      ...job,
      runId: job.runId || id("run"),
      enqueuedAt: Date.now(),
    });
  }
  emit({ type: "queue", ...state() });
  pump();
}

function start() {
  running = true;
  emit({ type: "runner", ...state() });
  pump();
}

function stop() {
  running = false;
  queue = [];
  emit({ type: "runner", ...state(), message: "stopped — queue cleared" });
}

function pump() {
  if (!running) return;
  while (inflight < maxConcurrent && queue.length > 0) {
    const job = queue.shift();
    inflight++;
    emit({ type: "queue", ...state() });
    void runOne(job).finally(() => {
      inflight--;
      emit({ type: "queue", ...state() });
      pump();
    });
  }
}

function emitLog(runId, taskId, level, message, extra) {
  emit({
    type: "job",
    phase: "log",
    runId,
    taskId,
    level: level || "info",
    message: String(message || ""),
    ...(extra || {}),
  });
}

function finishResult(job, res, summary) {
  const debugError = res?.ok ? null : formatExecutorFailure(res);
  const outcome = consumerOutcome(res);
  const lastSteps = Array.isArray(res?.lastSteps)
    ? res.lastSteps
    : Array.isArray(res?.steps)
      ? res.steps.slice(-40)
      : null;
  const failedStep =
    res?.failedStep ??
    (Array.isArray(res?.steps) ? [...res.steps].reverse().find((s) => s && s.ok === false)?.step : null) ??
    null;
  console.log(
    "[desktop:run]",
    JSON.stringify({
      runId: job.runId,
      ok: res?.ok,
      consumer: outcome.label,
      consumerCode: outcome.code,
      checkoutStage: res?.checkoutStage,
      failedStep,
      error: debugError,
      lastSteps: lastSteps?.slice?.(-8) ?? lastSteps,
      elapsedMs: res?.elapsedMs,
      proxy: summary.proxy,
      transport: summary.transport,
      kmartMode: summary.kmartMode,
    }),
  );
  return {
    ok: Boolean(res?.ok),
    taskId: job.task?.id,
    runId: job.runId,
    orderNumber: res?.orderNumber ?? null,
    // Consumer-facing label (UI). Analytical detail stays in debugError / console.
    error: res?.ok ? null : outcome.label,
    consumerLabel:
      res?.ok && res?.accountGen && res?.account?.email
        ? `Account ${res.account.email}`
        : outcome.label,
    consumerCode: outcome.code,
    stockStatus: outcome.stockStatus,
    proxyAttempts: Array.isArray(res?.proxyAttempts) ? res.proxyAttempts : null,
    proxyRotated: Boolean(res?.proxyRotated),
    debugError,
    checkoutStage: res?.checkoutStage ?? null,
    failedStep,
    elapsedMs: res?.elapsedMs ?? null,
    at: Date.now(),
    lastSteps,
    steps: Array.isArray(res?.steps) ? res.steps : null,
    paymentTail: Array.isArray(res?.paymentTail) ? res.paymentTail : null,
    account: res?.account ?? null,
    accountGen: Boolean(res?.accountGen),
    paypalApproveUrl: res?.paypalApproveUrl ?? null,
    attempt: "undici",
    raw: {
      ok: res?.ok,
      checkoutStage: res?.checkoutStage,
      orderNumber: res?.orderNumber,
      failedStep,
      adapter: res?.adapter,
      transport: res?.transport,
      accountGen: Boolean(res?.accountGen),
    },
  };
}

function logResultTail(job, result) {
  if (result.ok) {
    emitLog(
      job.runId,
      job.task?.id,
      "ok",
      result.consumerLabel || "Order confirmed",
    );
    return;
  }
  emitLog(job.runId, job.task?.id, "err", result.consumerLabel || result.error || "Something went wrong");
  if (result.failedStep) {
    emitLog(job.runId, job.task?.id, "err", `failedStep=${result.failedStep}`);
  }
  // Surface one line of analytical detail in the UI for drop diagnosis (still capped).
  if (result.debugError) {
    emitLog(job.runId, job.task?.id, "err", `detail: ${String(result.debugError).slice(0, 220)}`);
    console.log(`[desktop:run:debug] ${job.runId} ${result.debugError}`);
  }
  for (const s of (result.lastSteps || []).slice(-8)) {
    console.log(
      `[desktop:run:debug] ${job.runId} step ${s.ok ? "OK" : "FAIL"} ${s.step}${s.status != null ? ` [${s.status}]` : ""} — ${String(s.note || "").slice(0, 200)}`,
    );
  }
}

/** Sticky-only: Akamai / soft-API denial worth a fresh exit. */
function isResidentialAkamaiBlock(result) {
  if (!result || result.ok) return false;
  if (result.consumerCode === "akamai") return true;
  const blob = [
    result.debugError,
    result.failedStep,
    result.checkoutStage,
    ...(result.lastSteps || []).map((s) => `${s.step} ${s.note}`),
  ]
    .filter(Boolean)
    .join(" ");
  return /Access Denied|AkamaiGHost|akamai_unsolved|pdp_get|cart_get:all_profiles_denied|pdp_soft_api|category_browse/i.test(
    blob,
  );
}

/** Sticky-only: dead tunnel / TLS CONNECT failure (burned sticky exit). */
function isStickyTunnelDead(result) {
  if (!result || result.ok) return false;
  if (isProxyEgressFailed(result)) return false;
  const blob = [
    result.debugError,
    result.failedStep,
    ...(result.lastSteps || []).map((s) => `${s.step} ${s.status ?? ""} ${s.note}`),
  ]
    .filter(Boolean)
    .join(" ");
  return /sticky_tunnel|fetch failed|socket disconnected|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ECONNREFUSED|other side closed|socket hang up|Client network socket disconnected/i.test(
    blob,
  );
}

function shouldStickyResiRetry(result) {
  return isResidentialAkamaiBlock(result) || isStickyTunnelDead(result);
}

async function runBandaiMonitorInProcess(job, payload, { checkoutOnHit = false } = {}) {
  const path = require("path");
  const { eventMatchesWatch, parseTaskWatch } = await import(
    pathToFileUrl(path.join(__dirname, "..", "executor", "monitor", "event-filter.js"))
  );
  const monitorDir = path.join(__dirname, "..", "executor", "monitor");
  const mode = String(payload.bandaiMonitorMode || "local").toLowerCase();
  // Dry monitor (no checkout): small poll budget for labs.
  // Checkout-on-hit: keep polling until match (optional safety cap via env/task).
  const configuredMax = Number(job.task?.monitorMaxPolls || process.env.BANDAI_MONITOR_MAX_POLLS);
  const maxPolls = checkoutOnHit
    ? configuredMax > 0
      ? Math.max(1, configuredMax)
      : Number.POSITIVE_INFINITY
    : Math.max(1, configuredMax || 3);
  const maxWaitMs = Math.max(
    0,
    Number(job.task?.monitorMaxWaitMs || process.env.BANDAI_MONITOR_MAX_WAIT_MS) || 0,
  );
  const hits = [];
  const watch = parseTaskWatch({
    productId: payload.productId || payload.bandaiWatchSku,
    keywords: payload.keywords || payload.bandaiWatchKeywords,
    pdpUrl: payload.pdpUrl,
    bandaiWatchSku: payload.bandaiWatchSku,
    bandaiWatchKeywords: payload.bandaiWatchKeywords,
  });

  emitLog(
    job.runId,
    job.task?.id,
    "info",
    `Bandai monitor mode=${mode} checkoutOnHit=${checkoutOnHit} maxPolls=${Number.isFinite(maxPolls) ? maxPolls : "∞"}`,
  );

  const injectHit =
    /^(1|true|yes)$/i.test(String(process.env.BANDAI_MONITOR_INJECT_HIT || "")) ||
    job.task?.monitorInjectHit === true;

  function injectProductId(fallbackWatch) {
    return (
      (fallbackWatch?.productIds && fallbackWatch.productIds[0]) ||
      payload.bandaiWatchSku ||
      "N2542159011"
    );
  }

  if (mode === "global") {
    const { createGlobalMonitorHub } = await import(
      pathToFileUrl(path.join(monitorDir, "global-monitor-hub.js"))
    );
    const hub = createGlobalMonitorHub({
      attachBridge: false,
      monitorOpts: {
        intervalMs: Number(payload.bandaiMonitorIntervalMs) || 10000,
      },
      log: (line) => emitLog(job.runId, job.task?.id, "info", line),
    });
    const sub = hub.subscribeTask(
      {
        taskId: payload.taskId,
        bandaiMonitorMode: "global",
        productId: payload.productId || payload.bandaiWatchSku,
        keywords: payload.keywords || payload.bandaiWatchKeywords,
        pdpUrl: payload.pdpUrl,
      },
      {
        onHit: (ev) => {
          if (!ev?.inStock) return;
          hits.push(ev);
          emitLog(
            job.runId,
            job.task?.id,
            "ok",
            `MATCH ${ev.productId} ${ev.title || ev.reason || ""}`,
          );
        },
      },
    );
    if (!sub.ok) {
      return {
        ok: false,
        error: sub.error || "subscribe failed",
        monitor: true,
        bandaiMonitorMode: "global",
      };
    }
    emitLog(
      job.runId,
      job.task?.id,
      "info",
      `Subscribed watch sku=${(sub.watch.productIds || []).join(",") || "-"} kw=${(sub.watch.keywords || []).join(",") || "-"}`,
    );

    let polls = 0;
    const waitStarted = Date.now();
    await new Promise((resolve) => {
      const done = () => {
        hub.monitor.off("poll", onPoll);
        resolve();
      };
      const onPoll = (s) => {
        polls += 1;
        emitLog(
          job.runId,
          job.task?.id,
          "info",
          `global poll #${s.polls} products=${s.products} inStock=${s.inStock} events=${s.events}`,
        );
        if (injectHit && polls >= 1 && !hits.length) {
          const pid = injectProductId(sub.watch);
          hub._injectStockChanged({
            productId: String(pid),
            title: "inject-hit",
            inStock: true,
            reason: "inject",
            timestamp: Date.now(),
          });
        }
        if (hits.length) return done();
        if (polls >= maxPolls) return done();
        if (maxWaitMs > 0 && Date.now() - waitStarted >= maxWaitMs) return done();
      };
      hub.monitor.on("poll", onPoll);
      hub.monitor.on("error", (e) =>
        emitLog(job.runId, job.task?.id, "err", e.error || "monitor error"),
      );
      hub.start();
    });
    await hub.stop();
    hub.detach();

    if (checkoutOnHit && hits.length) {
      return {
        ok: true,
        monitor: true,
        checkout: true,
        bandaiMonitorMode: "global",
        hit: hits[0],
        hits,
        note: `matched ${hits[0].productId} — starting checkout`,
      };
    }
    return {
      ok: true,
      monitor: true,
      bandaiMonitorMode: "global",
      hits,
      note: hits.length ? `matched ${hits.length}` : `no match in ${polls} polls (baseline/filter)`,
      dryRun: true,
    };
  }

  // local — task proxies
  const { createTaskLocalMonitor } = await import(
    pathToFileUrl(path.join(monitorDir, "task-local-monitor.js"))
  );
  const entries = Array.isArray(job.proxyEntries)
    ? job.proxyEntries.map((e) => String(e || "").trim()).filter(Boolean)
    : [];
  const proxies = entries.length ? entries : job.proxyRaw ? [job.proxyRaw] : [];
  if (!proxies.length) {
    return { ok: false, error: "Task-local monitor needs a proxy group", monitor: true };
  }
  let local;
  try {
    local = createTaskLocalMonitor({
      bandaiArea: payload.bandaiArea || "au",
      productId: payload.productId || payload.bandaiWatchSku,
      keywords: payload.keywords || payload.bandaiWatchKeywords,
      pdpUrl: payload.pdpUrl,
      proxies,
      monitorIntervalMs: payload.bandaiMonitorIntervalMs,
      monitorDelayMs: payload.bandaiMonitorDelayMs,
    });
  } catch (e) {
    return { ok: false, error: e.message || String(e), monitor: true };
  }

  let polls = 0;
  const waitStarted = Date.now();
  await new Promise((resolve) => {
    const done = () => resolve();
    local.on("poll", (s) => {
      polls += 1;
      emitLog(
        job.runId,
        job.task?.id,
        "info",
        `local poll #${s.polls} products=${s.products} inStock=${s.inStock} events=${s.events}`,
      );
      if (injectHit && polls >= 1 && !hits.length) {
        const pid = injectProductId(local.watch);
        local.emit("stock_changed", {
          productId: String(pid),
          title: "inject-hit",
          inStock: true,
          reason: "inject",
          timestamp: Date.now(),
        });
      }
      if (hits.length) return done();
      if (polls >= maxPolls) return done();
      if (maxWaitMs > 0 && Date.now() - waitStarted >= maxWaitMs) return done();
    });
    local.on("stock_changed", (ev) => {
      if (!eventMatchesWatch(ev, local.watch || watch)) return;
      hits.push(ev);
      emitLog(job.runId, job.task?.id, "ok", `LOCAL ${ev.productId} ${ev.reason}`);
      if (checkoutOnHit) done();
    });
    local.on("error", (e) =>
      emitLog(job.runId, job.task?.id, "err", e.error || "local monitor error"),
    );
    local.start();
  });
  await local.stop();

  if (checkoutOnHit && hits.length) {
    return {
      ok: true,
      monitor: true,
      checkout: true,
      bandaiMonitorMode: "local",
      hit: hits[0],
      hits,
      note: `matched ${hits[0].productId} — starting checkout`,
    };
  }
  return {
    ok: true,
    monitor: true,
    bandaiMonitorMode: "local",
    hits,
    note: hits.length ? `matched ${hits.length}` : `no change in ${polls} polls`,
    dryRun: true,
  };
}

function pathToFileUrl(p) {
  const path = require("path");
  const u = path.resolve(p);
  return process.platform === "win32"
    ? `file:///${u.replace(/\\/g, "/")}`
    : `file://${u}`;
}

async function executeOnce(job, { rotateSession = false, attemptLabel = "run" } = {}) {
  const built = buildPayload({ ...job, rotateSession });
  if (!built.ok) {
    return {
      ok: false,
      taskId: job.task?.id,
      runId: job.runId,
      error: "Something went wrong",
      consumerLabel: "Something went wrong",
      consumerCode: "error",
      stockStatus: "unknown",
      debugError: built.error,
      at: Date.now(),
      attempt: attemptLabel,
    };
  }

  const payload = built.data;
  payload.taskId = `${job.runId}-${attemptLabel}`;
  const summary = summarizePayload(payload);

  // Bandai monitor (global filter / task-local). Optionally hand off to checkout
  // on the first matching in-stock hit (claims F5 harvest when armed).
  if (
    job.task?.store === "bandai" &&
    String(job.task?.bandaiMode || payload.bandaiMode || "") === "monitor"
  ) {
    const checkoutOnHit = shouldCheckoutOnMonitorHit(job.task, job.placeOrder !== false);
    emitLog(
      job.runId,
      job.task?.id,
      "info",
      checkoutOnHit ? "Starting Bandai monitor → checkout on hit" : "Starting Bandai monitor",
    );
    try {
      const mon = await runBandaiMonitorInProcess(job, payload, { checkoutOnHit });
      if (!mon.checkout || !mon.hit) {
        return finishResult(job, mon, summary);
      }

      const switched = taskForMonitorCheckout(job.task, mon.hit, payload.bandaiArea || "au");
      if (!switched.ok) {
        return finishResult(
          job,
          { ok: false, error: switched.error, monitor: true, hits: mon.hits },
          summary,
        );
      }

      // Claim warm F5 bridge at trigger time (not enqueue) so Harvest stays useful
      // while the monitor was armed.
      const harvestSession = takeBandaiHarvestFn?.() || null;
      if (harvestSession?.id) {
        switched.task.harvestedBridgeId = harvestSession.id;
        switched.task.harvestedProxy = harvestSession.proxy;
        switched.task.proxyOverride = harvestSession.proxy;
        emitLog(
          job.runId,
          job.task?.id,
          "info",
          `Using harvested F5 bridge (${harvestSession.proxyHost || "proxy"} age≈${Math.round((Date.now() - (harvestSession.harvestedAt || Date.now())) / 1000)}s)`,
        );
      } else {
        emitLog(job.runId, job.task?.id, "info", "No harvested F5 bridge — cold checkout");
      }

      emitLog(
        job.runId,
        job.task?.id,
        "ok",
        `Restock ${switched.target.productId} — Autocheckout${job.placeOrder !== false ? " (live)" : " (dry)"}`,
      );

      const checkoutJob = {
        ...job,
        task: switched.task,
        proxyRaw: harvestSession?.proxy || job.proxyRaw,
        proxyEntries: harvestSession?.proxy
          ? [harvestSession.proxy]
          : job.proxyEntries,
        placeOrder: job.placeOrder !== false,
      };
      const builtCheckout = buildPayload({ ...checkoutJob, rotateSession: false });
      if (!builtCheckout.ok) {
        return finishResult(
          job,
          {
            ok: false,
            error: builtCheckout.error,
            monitor: true,
            monitorHit: switched.target,
            hits: mon.hits,
          },
          summary,
        );
      }
      const checkoutPayload = builtCheckout.data;
      checkoutPayload.taskId = `${job.runId}-checkout`;
      const checkoutSummary = summarizePayload(checkoutPayload);

      // Fall through to sidecar checkout (same progress polling as normal runs).
      return await runSidecarCheckout(checkoutJob, checkoutPayload, checkoutSummary, {
        attemptLabel: attemptLabel === "run" ? "monitor-checkout" : `${attemptLabel}-checkout`,
        monitorHit: switched.target,
        monitorHits: mon.hits,
      });
    } catch (e) {
      return finishResult(
        job,
        {
          ok: false,
          error: e?.message || String(e),
          monitor: true,
        },
        summary,
      );
    }
  }

  return await runSidecarCheckout(job, payload, summary, { attemptLabel });
}

async function runSidecarCheckout(job, payload, summary, extra = {}) {
  const attemptLabel = extra.attemptLabel || "run";
  console.log(
    "[desktop:run]",
    JSON.stringify({
      runId: job.runId,
      phase: "start-executor",
      attempt: attemptLabel,
      proxy: summary.proxy,
      transport: summary.transport,
      kmartMode: summary.kmartMode,
      placeOrder: summary.placeOrder,
      pdp: summary.storeUrl,
      monitorHit: extra.monitorHit?.productId || null,
    }),
  );
  emitLog(job.runId, job.task?.id, "info", "Starting");
  if (payload.account?.email) {
    emitLog(
      job.runId,
      job.task?.id,
      "info",
      `Account ${payload.accountAssignSource || "assigned"}: ${payload.account.email}`,
    );
  } else if (job.task?.store === "toymate" && String(job.task?.toymateMode || "checkout") === "checkout") {
    emitLog(job.runId, job.task?.id, "info", "Guest checkout (no vault login)");
  }

  let lastStageKey = "";
  const progressTimer = setInterval(async () => {
    try {
      const p = await sidecar.progress(payload.taskId);
      if (p?.found && p.progress) {
        const line = consumerProgressMessage(p.progress);
        const key = `${p.progress.stage}|${line}`;
        if (key !== lastStageKey) {
          lastStageKey = key;
          emit({
            type: "job",
            phase: "progress",
            taskId: job.task?.id,
            runId: job.runId,
            progress: p.progress,
            message: line,
            consumerLabel: line,
          });
        }
      }
    } catch (e) {
      console.warn(`[desktop:run] progress poll: ${e.message || e}`);
    }
  }, 1500);

  try {
    const res = await sidecar.runTask(payload);
    const finished = finishResult(job, res, summary);
    if (extra.monitorHit) {
      finished.monitorHit = extra.monitorHit;
      finished.monitorTriggered = true;
      finished.harvestedBridge = Boolean(payload.harvestedBridgeId);
    }
    return finished;
  } finally {
    clearInterval(progressTimer);
  }
}

async function runOne(job) {
  emit({
    type: "job",
    phase: "start",
    taskId: job.task?.id,
    runId: job.runId,
    label: job.task?.label || job.task?.pdpUrl,
  });

  try {
    const entries = Array.isArray(job.proxyEntries)
      ? job.proxyEntries.map((e) => String(e || "").trim()).filter(Boolean)
      : [];
    if (job.proxyIndex == null) job.proxyIndex = 0;
    if (!job.proxyRaw && entries.length) {
      job.proxyRaw = entries[job.proxyIndex % entries.length];
    }

    const sticky = isStickyProxy(job.proxyRaw || "") || entries.some((e) => isStickyProxy(e));
    // Harvested CF / F5 sessions are IP-bound — do not rotate off that exit.
    const harvestLocked = Boolean(
      job.task?.harvestedSession?.cookies || job.task?.harvestedBridgeId || job.task?.harvestedProxy,
    );

    // Sticky: use the listed session- token first (user-provided exits).
    // Always minting a random session on attempt 1 ignored the proxy list and
    // often landed on worse Noontide exits. ISP advances host:port lines only.
    let result = await executeOnce(job, {
      rotateSession: false,
      attemptLabel: sticky ? "resi" : "run",
    });
    logResultTail(job, result);

    // Rotate when Akamai walls the run (incl. GraphQL cart_get after get-token).
    // ISP: walk listed host:port exits. Sticky: walk entries, then mint session-.
    // Skip entirely when a harvested Toymate CF session is locked to this proxy.
    const maxProxyRetries = harvestLocked
      ? 0
      : sticky
        ? Math.min(4, Math.max(2, entries.length || 2))
        : entries.length > 1
          ? Math.min(3, entries.length - 1)
          : 0;
    let proxyRetries = 0;
    while (
      !result.ok &&
      shouldStickyResiRetry(result) &&
      proxyRetries < maxProxyRetries &&
      (entries.length > 1 || sticky)
    ) {
      proxyRetries += 1;
      const why = isStickyTunnelDead(result)
        ? "tunnel/TLS failure"
        : /akamai_unsolved/i.test(`${result.failedStep} ${result.debugError || ""}`)
          ? "unsolved _abck"
          : "Akamai denial";

      let rotateSession = false;
      if (entries.length > 1) {
        job.proxyIndex = (Number(job.proxyIndex) + 1) % entries.length;
        job.proxyRaw = entries[job.proxyIndex];
        rotateSession = sticky && proxyRetries >= entries.length;
      } else {
        rotateSession = sticky;
      }
      console.warn(
        `[desktop:run] proxy rotate ${proxyRetries}/${maxProxyRetries} (${why}) entry ${
          entries.length ? `${(job.proxyIndex || 0) + 1}/${entries.length}` : "session"
        }${rotateSession ? " fresh session" : ""}`,
      );
      emitLog(
        job.runId,
        job.task?.id,
        "warn",
        `Switching proxy (${proxyRetries}/${maxProxyRetries})`,
      );

      result = await executeOnce(job, {
        rotateSession,
        attemptLabel: sticky
          ? proxyRetries === 1
            ? "resi-retry"
            : `resi-retry#${proxyRetries}`
          : proxyRetries === 1
            ? "isp-retry"
            : `isp-retry#${proxyRetries}`,
      });
      logResultTail(job, result);
    }

    emit({ type: "job", phase: "done", ...result });
    onFinished?.(result);
  } catch (e) {
    const debugError = e.message || String(e);
    console.error(`[desktop:run] executor threw: ${debugError}`);
    const result = {
      ok: false,
      taskId: job.task?.id,
      runId: job.runId,
      error: "Something went wrong",
      consumerLabel: "Something went wrong",
      consumerCode: "error",
      stockStatus: "unknown",
      debugError,
      at: Date.now(),
    };
    emitLog(job.runId, job.task?.id, "err", result.consumerLabel);
    emit({ type: "job", phase: "done", ...result });
    onFinished?.(result);
  }
}

module.exports = {
  setEmitter,
  setFinishedHandler,
  configure,
  state,
  enqueue,
  start,
  stop,
  buildPayload,
  normalizeProxy,
  isAkamaiWwwBlocked,
  isProxyEgressFailed,
};
