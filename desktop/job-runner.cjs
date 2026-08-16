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
const {
  classifyBandaiRunResult,
  sleep: sleepMs,
} = require("./bandai-retry-policy.cjs");
const { isPaymentAlreadySubmitted } = require("./payment-latch.cjs");
const { auditEnqueueBatch } = require("./pay-forensics-audit.cjs");
const { resolveAccountForTask } = require("./account-assign.cjs");
const { resolveDesktopBandaiPayPath } = require("./bandai-pay-path.cjs");
const { vaultRegisteredEmails, findRegisteredAccount } = require("./account-vault.cjs");
const {
  shouldCheckoutOnMonitorHit,
  taskForMonitorCheckout,
} = require("./bandai-monitor-checkout.cjs");
const {
  pickAreaItemNo,
  isBackendAreaItemNo,
  isFrontendProductCode,
  resolveAreaItemNoHttp,
} = require("./bandai-nai-resolve.cjs");

let queue = [];
let inflight = 0;
let running = false;
let maxConcurrent = 5;
/**
 * Refcount of task ids currently queued or running.
 * Blocks a second Start on the same task row while it's already live —
 * does NOT block other tasks, duplicated task rows (new ids), or quantity>1
 * jobs from the same enqueue batch.
 */
const activeTaskCounts = new Map();
/** Task ids the user asked to stop — break Bandai loops + abort in-flight /run. */
const abortTaskIds = new Set();
/** @type {Map<string, AbortController>} */
const abortControllers = new Map();
/** desktop taskId → Set of live executor taskIds (for POST /cancel). */
const activeExecutorTaskIds = new Map();

function acquireTaskId(tid) {
  if (!tid) return;
  activeTaskCounts.set(tid, (activeTaskCounts.get(tid) || 0) + 1);
}

function releaseTaskId(tid) {
  if (!tid) return;
  const n = (activeTaskCounts.get(tid) || 1) - 1;
  if (n <= 0) activeTaskCounts.delete(tid);
  else activeTaskCounts.set(tid, n);
}

function isTaskAborted(tid) {
  return Boolean(tid && abortTaskIds.has(tid));
}

function abortControllerFor(tid) {
  if (!tid) return null;
  let ac = abortControllers.get(tid);
  if (!ac || ac.signal.aborted) {
    ac = new AbortController();
    abortControllers.set(tid, ac);
  }
  return ac;
}

function clearAbortState(tid) {
  if (!tid) return;
  abortTaskIds.delete(tid);
  abortControllers.delete(tid);
  activeExecutorTaskIds.delete(tid);
}

function trackExecutorTaskId(desktopTaskId, executorTaskId) {
  const tid = String(desktopTaskId || "");
  const eid = String(executorTaskId || "");
  if (!tid || !eid) return;
  let set = activeExecutorTaskIds.get(tid);
  if (!set) {
    set = new Set();
    activeExecutorTaskIds.set(tid, set);
  }
  set.add(eid);
}

function untrackExecutorTaskId(desktopTaskId, executorTaskId) {
  const tid = String(desktopTaskId || "");
  const eid = String(executorTaskId || "");
  const set = activeExecutorTaskIds.get(tid);
  if (!set) return;
  if (eid) set.delete(eid);
  if (!set.size) activeExecutorTaskIds.delete(tid);
}

/** Fire-and-forget sidecar cancel for every live executor id on these desktop tasks. */
function cancelExecutorRunsForTasks(ids) {
  const set = new Set((ids || []).map((x) => String(x || "")).filter(Boolean));
  if (!set.size || typeof sidecar?.cancelRun !== "function") return;
  for (const tid of set) {
    const eids = activeExecutorTaskIds.get(tid);
    if (!eids?.size) continue;
    for (const eid of [...eids]) {
      void sidecar.cancelRun(eid).then((res) => {
        if (res?.found) {
          console.warn(`[desktop:run] sidecar cancel ok taskId=${tid} executor=${eid}`);
        }
      });
    }
  }
}

function cancelledResult(job, reason = "stopped") {
  return {
    ok: false,
    taskId: job?.task?.id,
    runId: job?.runId,
    error: "Stopped",
    consumerLabel: "Stopped",
    consumerCode: "stopped",
    failedStep: "stopped",
    stockStatus: "unknown",
    debugError: reason,
    at: Date.now(),
    stopped: true,
  };
}

/** Interruptible sleep — returns early when the task is aborted. */
async function sleepUnlessAborted(tid, ms) {
  const total = Math.max(0, Number(ms) || 0);
  const step = 200;
  let left = total;
  while (left > 0) {
    if (!running || isTaskAborted(tid)) return false;
    const slice = Math.min(step, left);
    await sleepMs(slice);
    left -= slice;
  }
  return !isTaskAborted(tid);
}
/** When false, UI only gets consumer labels (failedStep/detail/polls stay on console). */
let detailedLogs = true;
let emit = () => {};
let onFinished = null;
/** @type {null | (() => object|null)} */
let takeBandaiHarvestFn = null;
/** @type {null | (() => void)} */
let pauseBandaiHarvestRefillFn = null;
/** @type {null | (() => void)} */
let resumeBandaiHarvestRefillFn = null;
/** @type {null | (() => object|null)} */
let takeToymateHarvestFn = null;
/** @type {null | (() => void)} */
let pauseToymateHarvestRefillFn = null;
/** @type {null | (() => void)} */
let resumeToymateHarvestRefillFn = null;
/** @type {null | ((sku: string, area?: string) => object|null)} */
let lookupBandaiProductFn = null;
/** @type {null | ((entry: object) => void)} */
let publishBandaiProductFn = null;

function setEmitter(fn) {
  emit = typeof fn === "function" ? fn : () => {};
}

function setFinishedHandler(fn) {
  onFinished = typeof fn === "function" ? fn : null;
}

function configure(opts = {}) {
  const n = opts.maxConcurrent;
  if (n != null) maxConcurrent = Math.max(1, Math.min(200, Number(n) || 5));
  if (Object.prototype.hasOwnProperty.call(opts, "detailedLogs")) {
    detailedLogs = opts.detailedLogs !== false;
  }
  if (Object.prototype.hasOwnProperty.call(opts, "takeBandaiHarvest")) {
    takeBandaiHarvestFn = typeof opts.takeBandaiHarvest === "function" ? opts.takeBandaiHarvest : null;
  }
  if (Object.prototype.hasOwnProperty.call(opts, "pauseBandaiHarvestRefill")) {
    pauseBandaiHarvestRefillFn =
      typeof opts.pauseBandaiHarvestRefill === "function" ? opts.pauseBandaiHarvestRefill : null;
  }
  if (Object.prototype.hasOwnProperty.call(opts, "resumeBandaiHarvestRefill")) {
    resumeBandaiHarvestRefillFn =
      typeof opts.resumeBandaiHarvestRefill === "function" ? opts.resumeBandaiHarvestRefill : null;
  }
  if (Object.prototype.hasOwnProperty.call(opts, "takeToymateHarvest")) {
    takeToymateHarvestFn =
      typeof opts.takeToymateHarvest === "function" ? opts.takeToymateHarvest : null;
  }
  if (Object.prototype.hasOwnProperty.call(opts, "pauseToymateHarvestRefill")) {
    pauseToymateHarvestRefillFn =
      typeof opts.pauseToymateHarvestRefill === "function" ? opts.pauseToymateHarvestRefill : null;
  }
  if (Object.prototype.hasOwnProperty.call(opts, "resumeToymateHarvestRefill")) {
    resumeToymateHarvestRefillFn =
      typeof opts.resumeToymateHarvestRefill === "function" ? opts.resumeToymateHarvestRefill : null;
  }
  if (Object.prototype.hasOwnProperty.call(opts, "lookupBandaiProduct")) {
    lookupBandaiProductFn =
      typeof opts.lookupBandaiProduct === "function" ? opts.lookupBandaiProduct : null;
  }
  if (Object.prototype.hasOwnProperty.call(opts, "publishBandaiProduct")) {
    publishBandaiProductFn =
      typeof opts.publishBandaiProduct === "function" ? opts.publishBandaiProduct : null;
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
    mode !== "login_check" &&
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
    mode === "account_gen" || mode === "monitor" || mode === "login_check" || !input
      ? `https://p-bandai.com/${bandaiArea}/`
      : /^https?:\/\//i.test(input)
        ? input
        : `https://p-bandai.com/${bandaiArea}/item/${input}`;

  let resolvedAccount = null;
  let accountAssignSource = null;
  if (mode === "checkout" || mode === "atc" || mode === "login_check") {
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

  const payRaw = String(task.paymentMethod || "credit_card").toLowerCase();
  const paymentMethod =
    payRaw === "paypal_guest" || payRaw === "paypal_manual" ? payRaw : "credit_card";
  const wantPaypal = /^paypal/i.test(paymentMethod);
  // Browser PayPal.com guest fill is lab-only (DataDome). Default = HTTP mint URL.
  const paypalBrowserApprove =
    task.paypalBrowserApprove === true ||
    process.env.PAYPAL_BROWSER_APPROVE === "1" ||
    process.env.PAYPAL_BROWSER_APPROVE === "true";

  let card = null;
  // Card path needs PAN. PayPal HTTP mint does not. Browser guest fill does.
  if (mode === "checkout" && placeOrder && (!wantPaypal || paypalBrowserApprove)) {
    const pan = String(profile?.card_number || "").replace(/\s+/g, "");
    const cvv = String(profile?.card_cvv || "").trim();
    const mm = String(profile?.card_exp_month || "").trim();
    const yy = String(profile?.card_exp_year || "").trim();
    const holder =
      String(profile?.card_name || "").trim() ||
      [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
      "Cardholder";
    if (!pan || !cvv || !mm || !yy) {
      return {
        ok: false,
        error: wantPaypal
          ? "PayPal browser guest needs complete card on the billing profile"
          : "Place order needs complete card on the profile",
      };
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
      paymentMethod,
      paypalBrowserApprove,
      // Headless unless explicitly headed for lab watch.
      paypalHeadless: task.paypalHeadless !== false,
      debugTrace: true,
      forceUndici: true,
      forceTls: false,
      // Sticky pool for in-adapter SoftBlock login rotate (fail-path only).
      proxyPool: Array.isArray(task._proxyEntries)
        ? task._proxyEntries
        : Array.isArray(task.proxyEntries)
          ? task.proxyEntries
          : undefined,
      bandaiLoginProxyRotate: task.bandaiLoginProxyRotate !== false,
      bandaiLoginProxyRotates:
        task.bandaiLoginProxyRotates != null
          ? Number(task.bandaiLoginProxyRotates)
          : undefined,
      bandaiPayFromCart: task.bandaiPayFromCart === true,
      heldCart:
        task.heldCart && typeof task.heldCart === "object"
          ? {
              cartSn: task.heldCart.cartSn ?? null,
              cartId: task.heldCart.cartId ?? null,
              cartItemSn: task.heldCart.cartItemSn ?? null,
              areaItemNo: task.heldCart.areaItemNo ?? null,
              productCode: task.heldCart.productCode ?? null,
              cartHoldAt: task.heldCart.cartHoldAt ?? null,
              payWindowMs: task.heldCart.payWindowMs ?? null,
            }
          : undefined,
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
        card_name: profile?.card_name || null,
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
  // Snapshot before this batch — quantity>1 siblings share a task id and must all enqueue.
  const priorActive = new Set(activeTaskCounts.keys());
  let skipped = 0;
  const accepted = [];
  for (const job of list) {
    const tid = job?.task?.id;
    // Same task row already live from a previous start → skip (double-click / double fire).
    if (tid && priorActive.has(tid)) {
      skipped += 1;
      console.warn(`[desktop:run] skip duplicate enqueue taskId=${tid}`);
      emit({
        type: "job",
        phase: "log",
        taskId: tid,
        level: "warn",
        message: "Already running — skipped duplicate start",
      });
      continue;
    }
    // Fresh Start clears a prior manual Stop latch for this row.
    if (tid) {
      abortTaskIds.delete(tid);
      abortControllers.delete(tid);
    }
    acquireTaskId(tid);
    const queued = {
      ...job,
      runId: job.runId || id("run"),
      enqueuedAt: Date.now(),
    };
    queue.push(queued);
    accepted.push(queued);
  }
  try {
    auditEnqueueBatch(accepted, {
      source: "job-runner.enqueue",
      skippedDuplicates: skipped || 0,
    });
  } catch {
    /* forensics never blocks queue */
  }
  emit({ type: "queue", ...state(), skippedDuplicates: skipped || undefined });
  pump();
}

function start() {
  running = true;
  emit({ type: "runner", ...state() });
  pump();
}

function stop() {
  running = false;
  const queuedIds = queue.map((j) => j?.task?.id).filter(Boolean);
  queue = [];
  for (const tid of queuedIds) releaseTaskId(tid);
  // Abort every live task so Bandai loops + in-flight /run exit.
  const live = [...activeTaskCounts.keys()];
  // Sidecar cancel FIRST — client socket abort alone does not stop issuer pay.
  cancelExecutorRunsForTasks(live);
  for (const tid of live) {
    abortTaskIds.add(tid);
    try {
      abortControllers.get(tid)?.abort();
    } catch {
      /* ignore */
    }
  }
  emit({ type: "runner", ...state(), message: "stopped — queue cleared" });
}

/**
 * Cancel specific task rows: drop queued jobs, abort in-flight /run, break Bandai loops.
 * Does not disable the task — user can Start again.
 * @param {string[]} ids
 * @returns {{ ok: true, stopped: number }}
 */
function stopTasks(ids) {
  const set = new Set((ids || []).map((x) => String(x || "")).filter(Boolean));
  if (!set.size) return { ok: true, stopped: 0 };

  // Tell the sidecar to abort before we tear down the client /run socket —
  // otherwise GE pay can still complete after the UI shows Stopped.
  cancelExecutorRunsForTasks([...set]);

  for (const tid of set) {
    abortTaskIds.add(tid);
    try {
      abortControllers.get(tid)?.abort();
    } catch {
      /* ignore */
    }
  }

  const kept = [];
  let dequeued = 0;
  for (const job of queue) {
    const tid = job?.task?.id;
    if (tid && set.has(tid)) {
      dequeued += 1;
      releaseTaskId(tid);
      emit({
        type: "job",
        phase: "done",
        ...cancelledResult(job, "stopped_queued"),
        lastStatus: "idle",
        lastLabel: "Stopped",
      });
      continue;
    }
    kept.push(job);
  }
  queue = kept;

  for (const tid of set) {
    if (activeTaskCounts.has(tid)) {
      emit({
        type: "job",
        phase: "status",
        taskId: tid,
        consumerLabel: "Stopping…",
        lastLabel: "Stopping…",
        lastStatus: "running",
      });
    }
  }

  emit({ type: "queue", ...state() });
  return { ok: true, stopped: set.size, dequeued };
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
  const opts = extra || {};
  // Operator-only diagnostics — skip UI when detailedLogs is off.
  if (opts.detailed && !detailedLogs) {
    if (level === "err") {
      console.log(`[desktop:run:debug] ${runId} ${message}`);
    }
    return;
  }
  const { detailed: _detailed, ...rest } = opts;
  emit({
    type: "job",
    phase: "log",
    runId,
    taskId,
    level: level || "info",
    message: String(message || ""),
    ...rest,
  });
}

/** Same as emitLog but only shown when Settings → Detailed diagnostics is on. */
function emitDetailedLog(runId, taskId, level, message, extra) {
  emitLog(runId, taskId, level, message, { ...(extra || {}), detailed: true });
}

/** Live status for the Tasks table badge (optionally also activity log). */
function emitLiveStatus(job, label, status = "running", { log = true } = {}) {
  const line = String(label || "Starting");
  emit({
    type: "job",
    phase: "status",
    taskId: job?.task?.id,
    runId: job?.runId,
    consumerLabel: line,
    lastLabel: line,
    lastStatus: status,
  });
  if (log) emitLog(job?.runId, job?.task?.id, "info", line);
}

function advanceJobProxy(job, { sticky, entries, dropHarvest = false } = {}) {
  if (entries.length > 1) {
    job.proxyIndex = (Number(job.proxyIndex) + 1) % entries.length;
    job.proxyRaw = entries[job.proxyIndex];
  }
  if (dropHarvest && job.task) {
    delete job.task.harvestedBridgeId;
    delete job.task.harvestedProxy;
    delete job.task.proxyOverride;
  }
  // Sticky single-line or after walking the list → mint a fresh session- token next run.
  return Boolean(sticky);
}

function applyHeldCartForPayRetry(job, result) {
  if (!job?.task || !result) return;
  const held =
    result.heldCart && result.heldCart.cartSn
      ? result.heldCart
      : result.cartSn
        ? {
            cartSn: result.cartSn,
            cartId: result.cartId ?? null,
            cartItemSn: result.cartItemSn ?? null,
            areaItemNo: result.areaItemNo ?? result.productCode ?? null,
            productCode: result.productCode ?? null,
            cartHoldAt: result.cartHoldAt ?? Date.now(),
          }
        : null;
  if (!held?.cartSn) return;
  const taskSku = String(
    job.task.bandaiWatchSku ||
      job.task.sku ||
      String(job.task.pdpUrl || "").match(/\b(N\d{7,}[A-Za-z0-9]*|A\d{7,}[A-Za-z0-9]*)\b/i)?.[1] ||
      "",
  )
    .trim()
    .toUpperCase();
  const heldSku = String(held.productCode || held.sku || "").trim().toUpperCase();
  // Only reject when hold explicitly names a different product.
  if (taskSku && heldSku && heldSku !== taskSku) {
    console.log(
      `[job] skip heldCart pay-retry task=${job.task.id} heldSku=${heldSku} taskSku=${taskSku}`,
    );
    job.task.heldCart = null;
    job.task.bandaiPayFromCart = false;
    return;
  }
  // Stamp productCode so later heldMatchesProduct stays true on Retry pay.
  if (!held.productCode && taskSku) held.productCode = taskSku;
  job.task.heldCart = held;
  job.task.bandaiPayFromCart = true;
  if (held.areaItemNo) job.task.bandaiAreaItemNo = held.areaItemNo;
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
    (Array.isArray(res?.steps)
      ? [...res.steps]
          .reverse()
          .find(
            (s) =>
              s &&
              s.ok === false &&
              // Soft pre-ATC step — don't mask a later pay/checkout failure.
              String(s.step || "") !== "shipping_ensure",
          )?.step ||
        [...res.steps].reverse().find((s) => s && s.ok === false)?.step
      : null) ??
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
  const task = job.task || {};
  const sku =
    String(res?.productCode || task.bandaiWatchSku || task.productId || task.sku || "").trim() ||
    null;
  return {
    ok: Boolean(res?.ok),
    taskId: task.id,
    runId: job.runId,
    orderNumber: res?.orderNumber ?? null,
    store: task.store || res?.store || null,
    title: res?.title || task.title || task.label || null,
    taskLabel: task.label || null,
    sku,
    qty: Math.max(1, Number(task.qty) || 1),
    imageUrl: res?.imageUrl || task.imageUrl || null,
    price: res?.price ?? res?.total ?? res?.amount ?? null,
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
    // Already masked by summarizePayload — safe for local troubleshooting log.
    proxy: summary.proxy || null,
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
    // Bandai held-cart / pay-window (Retry pay)
    paymentStatus: res?.paymentStatus ?? null,
    atcOnly: Boolean(res?.atcOnly),
    cartSn: res?.cartSn ?? null,
    cartId: res?.cartId ?? null,
    cartItemSn: res?.cartItemSn ?? null,
    areaItemNo: res?.areaItemNo ?? null,
    productCode: res?.productCode ?? null,
    cartHoldAt: (() => {
      const n = Number(res?.cartHoldAt ?? res?.heldCart?.cartHoldAt);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    payWindowMs: (() => {
      const n = Number(res?.payWindowMs ?? res?.heldCart?.payWindowMs);
      return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
    })(),
    // Decline / already-submitted must never look like held retry pay.
    heldPayRetry:
      outcome.code === "declined" || outcome.code === "held_cart_gone"
        ? false
        : Boolean(res?.heldPayRetry) || Boolean(res?.atcOnly),
    heldCartGone: Boolean(res?.heldCartGone),
    heldCart: (() => {
      if (outcome.code === "declined" || outcome.code === "held_cart_gone") return null;
      const src = res?.heldCart?.cartSn
        ? res.heldCart
        : res?.cartSn
          ? {
              cartSn: res.cartSn,
              cartId: res.cartId || null,
              cartItemSn: res.cartItemSn || null,
              areaItemNo: res.areaItemNo || null,
              productCode: res.productCode || null,
              title: res.title || null,
            }
          : null;
      if (!src?.cartSn) return null;
      const holdAt = Number(src.cartHoldAt ?? res?.cartHoldAt);
      return {
        cartSn: src.cartSn,
        cartId: src.cartId ?? res?.cartId ?? null,
        cartItemSn: src.cartItemSn ?? res?.cartItemSn ?? null,
        areaItemNo: src.areaItemNo ?? res?.areaItemNo ?? null,
        productCode: src.productCode ?? res?.productCode ?? null,
        title: src.title ?? res?.title ?? null,
        // Always stamp a clock so the Tasks countdown can render.
        cartHoldAt: Number.isFinite(holdAt) && holdAt > 0 ? holdAt : Date.now(),
        payWindowMs: (() => {
          const n = Number(src.payWindowMs ?? res?.payWindowMs);
          return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
        })(),
      };
    })(),
    chargeReqCount: res?.chargeReqCount ?? res?.bigpayAuthPosts ?? null,
    undiciAttempts: res?.undiciAttempts ?? null,
    bigpayAuthPosts: res?.bigpayAuthPosts ?? null,
    responseLost: Boolean(res?.responseLost),
    paymentAttempted: Boolean(
      res?.paymentAttempted ||
        res?.responseLost ||
        Number(res?.chargeReqCount ?? res?.undiciAttempts ?? res?.bigpayAuthPosts ?? 0) >= 1,
    ),
    loginCheck: Boolean(res?.loginCheck),
    atcWallMs: res?.atcWallMs ?? null,
    transactionId: res?.transactionId || res?.geTransactionId || null,
    via: res?.via ?? null,
    isSameCartToken: res?.isSameCartToken ?? null,
    note: res?.note ?? null,
    raw: {
      ok: res?.ok,
      checkoutStage: res?.checkoutStage,
      orderNumber: res?.orderNumber,
      failedStep,
      adapter: res?.adapter,
      transport: res?.transport,
      accountGen: Boolean(res?.accountGen),
      heldPayRetry: Boolean(res?.heldPayRetry),
      paymentStatus: res?.paymentStatus ?? null,
      loginCheck: Boolean(res?.loginCheck),
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
    emitDetailedLog(job.runId, job.task?.id, "err", `failedStep=${result.failedStep}`);
  }
  // Analytical detail for solo testing / support — gated by detailedLogs.
  if (result.debugError) {
    const cap = /RELOAD_ONLY|RedirectErrorType|IsTheSameCartToken|ge_risk_hydrate/i.test(
      String(result.debugError),
    )
      ? 480
      : 220;
    emitDetailedLog(
      job.runId,
      job.task?.id,
      "err",
      `detail: ${String(result.debugError).slice(0, cap)}`,
    );
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

/** Bandai login SoftBlock / sensor flake — outer belt when adapter rotate exhausted. */
function isBandaiLoginBlock(result) {
  if (!result || result.ok) return false;
  const step = String(result.failedStep || "");
  const blob = [
    result.debugError,
    result.error,
    result.note,
    ...(result.lastSteps || []).map((s) => `${s.step} ${s.status ?? ""} ${s.note}`),
  ]
    .filter(Boolean)
    .join(" ");
  const soft =
    /SoftBlock|sensor mint|NETWORK CONGESTION|PAGE NOT AVAILABLE|Access Denied|Request rejected|\b501\b|\b503\b|\b502\b|\b504\b|Execution context was destroyed|ERR_CONNECTION/i.test(
      blob,
    );
  if (step === "login") return soft;
  // Adapter throw after SoftBlock rotate (dead bridge evaluate) — keep climbing.
  if ((step === "adapter_error" || step === "run_error") && soft && /\blogin\b/i.test(blob)) {
    return true;
  }
  return false;
}

function shouldStickyResiRetry(result) {
  return (
    isResidentialAkamaiBlock(result) || isStickyTunnelDead(result) || isBandaiLoginBlock(result)
  );
}

/**
 * Ensure Backend PID (NAI…) is on the task before ATC. Prefer existing fields;
 * otherwise warm+GET /api/products off the critical path (monitor arm / pre-fire).
 */
async function ensureBandaiNaiForTask(task, { proxy, area, log } = {}) {
  if (!task || typeof task !== "object") return { ok: false, skipped: true };
  const existing = pickAreaItemNo({
    bandaiAreaItemNo: task.bandaiAreaItemNo,
    bandaiBackendPid: task.bandaiBackendPid,
    areaItemNo: task.areaItemNo,
    heldCartAreaItemNo: task.heldCart?.areaItemNo,
  });
  if (existing) {
    task.bandaiAreaItemNo = existing;
    task.areaItemNo = existing;
    return { ok: true, areaItemNo: existing, cached: true };
  }
  const sku = String(
    task.bandaiWatchSku ||
      task.productId ||
      task.input ||
      task.pdpUrl ||
      "",
  )
    .match(/\b(N\d{7,}[A-Z0-9]*|A\d{7,}[A-Z0-9]*|NAI[A-Z0-9]+)\b/i)?.[1];
  if (!sku) return { ok: false, skipped: true, error: "no watch SKU" };
  if (isBackendAreaItemNo(sku)) {
    task.bandaiAreaItemNo = sku;
    task.areaItemNo = sku;
    return { ok: true, areaItemNo: sku, cached: true };
  }
  if (!isFrontendProductCode(sku)) return { ok: false, skipped: true, error: "not frontend SKU" };

  const region = area || task.bandaiArea || "au";
  // Shared monitor / local cache — skip public resolve when another member already resolved.
  try {
    const shared = lookupBandaiProductFn?.(sku, region);
    if (shared && isBackendAreaItemNo(shared.areaItemNo)) {
      task.bandaiAreaItemNo = shared.areaItemNo;
      task.areaItemNo = shared.areaItemNo;
      if (typeof log === "function") {
        log(`Backend PID from shared cache ${shared.areaItemNo} for ${sku}`);
      }
      return { ok: true, areaItemNo: shared.areaItemNo, cached: "shared" };
    }
  } catch {
    /* ignore */
  }

  const resolved = await resolveAreaItemNoHttp({
    productCode: sku,
    area: region,
    proxy: proxy || task.proxyOverride || null,
  });
  if (resolved.ok && resolved.areaItemNo) {
    task.bandaiAreaItemNo = resolved.areaItemNo;
    task.areaItemNo = resolved.areaItemNo;
    try {
      publishBandaiProductFn?.({
        sku,
        areaItemNo: resolved.areaItemNo,
        title: resolved.title || task.title || "",
        area: region,
        source: "resolve",
      });
    } catch {
      /* ignore */
    }
    if (typeof log === "function") {
      log(
        `Pre-resolved Backend PID ${resolved.areaItemNo} for ${sku}${resolved.ms != null ? ` (${resolved.ms}ms)` : ""}`,
      );
    }
    return { ok: true, areaItemNo: resolved.areaItemNo, ms: resolved.ms };
  }
  if (typeof log === "function") {
    log(`Backend PID pre-resolve skipped: ${resolved.error || "n/a"} — ATC may product_get`);
  }
  return { ok: false, error: resolved.error || "resolve failed" };
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

  emitLog(job.runId, job.task?.id, "info", "Watching for restock");
  emitDetailedLog(
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
      log: (line) => emitDetailedLog(job.runId, job.task?.id, "info", line),
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
            `In stock — ${ev.productId || ev.title || "product"}`,
          );
          emitDetailedLog(
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
    emitDetailedLog(
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
        emitDetailedLog(
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
      emitDetailedLog(
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
      emitLog(
        job.runId,
        job.task?.id,
        "ok",
        `In stock — ${ev.productId || "product"}`,
      );
      emitDetailedLog(
        job.runId,
        job.task?.id,
        "ok",
        `LOCAL ${ev.productId} ${ev.reason}`,
      );
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

/** @type {null | ((job: object, opts: object) => Promise<object>)} */
let executeOnceOverride = null;

async function executeOnce(job, { rotateSession = false, attemptLabel = "run" } = {}) {
  if (typeof executeOnceOverride === "function") {
    return executeOnceOverride(job, { rotateSession, attemptLabel });
  }
  // Bandai Autocheckout / ATC: claim F5 at run-start (not enqueue) so bank TTL
  // stays fresh through the queue — matches Monitor restock claim timing.
  if (
    job.task?.store === "bandai" &&
      ["checkout", "atc"].includes(String(job.task?.bandaiMode || "checkout")) &&
      !job.task.harvestedBridgeId &&
      typeof takeBandaiHarvestFn === "function"
  ) {
    const harvestSession = takeBandaiHarvestFn() || null;
    if (harvestSession?.id) {
      job.task.harvestedBridgeId = harvestSession.id;
      job.task.harvestedProxy = harvestSession.proxy;
      job.task.proxyOverride = harvestSession.proxy;
      if (harvestSession.proxy) {
        job.proxyRaw = harvestSession.proxy;
        job.proxyEntries = [harvestSession.proxy];
        job.proxyIndex = 0;
      }
      emitLog(job.runId, job.task?.id, "info", "Using warm harvest session");
      emitDetailedLog(
        job.runId,
        job.task?.id,
        "info",
        `Using harvested F5 bridge (${harvestSession.proxyHost || "proxy"} age≈${Math.round((Date.now() - (harvestSession.harvestedAt || Date.now())) / 1000)}s)`,
      );
    }
  }

  // Toymate checkout: claim CF (+ spam) at run-start — spam TTL ~100s dies in queue.
  if (
    job.task?.store === "toymate" &&
    String(job.task?.toymateMode || "checkout") === "checkout" &&
    !job.task.harvestedSession?.cookies &&
    typeof takeToymateHarvestFn === "function"
  ) {
    const harvestSession = takeToymateHarvestFn() || null;
    if (harvestSession?.cookies) {
      job.task.harvestedSession = harvestSession;
      job.task.captchaToken = harvestSession.captchaToken || job.task.captchaToken || null;
      if (harvestSession.proxy) {
        job.proxyRaw = harvestSession.proxy;
        job.proxyEntries = [harvestSession.proxy];
        job.proxyIndex = 0;
      }
      emitLog(job.runId, job.task?.id, "info", "Using harvested CF session");
      emitDetailedLog(
        job.runId,
        job.task?.id,
        "info",
        `Using harvested CF session (${harvestSession.proxyHost || "proxy"}${
          harvestSession.captchaToken ? " + spam" : ""
        } age≈${Math.round((Date.now() - (harvestSession.harvestedAt || Date.now())) / 1000)}s)`,
      );
    }
  }

  // Autocheckout: ensure Backend PID before sidecar (skip if already set / pay-from-cart).
  if (
    job.task?.store === "bandai" &&
      ["checkout", "atc"].includes(String(job.task?.bandaiMode || "checkout")) &&
      !job.task.bandaiPayFromCart &&
      !pickAreaItemNo({
      bandaiAreaItemNo: job.task.bandaiAreaItemNo,
      bandaiBackendPid: job.task.bandaiBackendPid,
      areaItemNo: job.task.areaItemNo,
    })
  ) {
    try {
      await ensureBandaiNaiForTask(job.task, {
        proxy: job.task.harvestedProxy || job.proxyRaw || job.proxyEntries?.[0] || null,
        area: job.task.bandaiArea || "au",
        log: (msg) => emitDetailedLog(job.runId, job.task?.id, "info", msg),
      });
    } catch {
      /* best-effort — adapter still has product_get */
    }
  }

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
  // Correlate desktop UI task ↔ executor /run ↔ issuer POSTs (forensics only).
  payload.desktopTaskId = job.task?.id || null;
  payload.desktopRunId = job.runId || null;
  payload.desktopAttempt = attemptLabel;
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
    // Resolve N… → NAI… while monitor polls (off ATC critical path).
    if (checkoutOnHit) {
      try {
        await ensureBandaiNaiForTask(job.task, {
          proxy: job.proxyRaw || job.proxyEntries?.[0] || null,
          area: payload.bandaiArea || job.task.bandaiArea || "au",
          log: (msg) => emitDetailedLog(job.runId, job.task?.id, "info", msg),
        });
      } catch (e) {
        emitDetailedLog(
          job.runId,
          job.task?.id,
          "info",
          `Backend PID pre-resolve error: ${e?.message || e}`,
        );
      }
    }
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
        emitLog(job.runId, job.task?.id, "info", "Using warm harvest session");
        emitDetailedLog(
          job.runId,
          job.task?.id,
          "info",
          `Using harvested F5 bridge (${harvestSession.proxyHost || "proxy"} age≈${Math.round((Date.now() - (harvestSession.harvestedAt || Date.now())) / 1000)}s)`,
        );
      } else {
        emitLog(job.runId, job.task?.id, "info", "Cold checkout (no harvest session)");
      }

      // Last chance: resolve NAI from hit / warm GET before sidecar ATC.
      if (!pickAreaItemNo({ bandaiAreaItemNo: switched.task.bandaiAreaItemNo })) {
        try {
          await ensureBandaiNaiForTask(switched.task, {
            proxy: harvestSession?.proxy || job.proxyRaw || job.proxyEntries?.[0] || null,
            area: payload.bandaiArea || switched.task.bandaiArea || "au",
            log: (msg) => emitDetailedLog(job.runId, job.task?.id, "info", msg),
          });
        } catch {
          /* best-effort */
        }
      }

      emitLog(
        job.runId,
        job.task?.id,
        "ok",
        `Restock ${switched.target.productId} — starting checkout`,
      );
      emitDetailedLog(
        job.runId,
        job.task?.id,
        "ok",
        `Restock ${switched.target.productId}${
          switched.task.bandaiAreaItemNo ? ` (${switched.task.bandaiAreaItemNo})` : ""
        } — Autocheckout${job.placeOrder !== false ? " (live)" : " (dry)"}`,
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
  const bandaiMode = String(job.task?.bandaiMode || payload.bandaiMode || "checkout").toLowerCase();
  const toyMode = String(job.task?.toymateMode || "checkout").toLowerCase();
  const pauseBandaiHarvest =
    job.task?.store === "bandai" &&
    bandaiMode !== "monitor" &&
    bandaiMode !== "account_gen" &&
    typeof pauseBandaiHarvestRefillFn === "function";
  const pauseToymateHarvest =
    job.task?.store === "toymate" &&
    toyMode === "checkout" &&
    typeof pauseToymateHarvestRefillFn === "function";
  const pauseHarvest = pauseBandaiHarvest || pauseToymateHarvest;
  if (pauseHarvest) {
    try {
      if (pauseBandaiHarvest) pauseBandaiHarvestRefillFn();
      if (pauseToymateHarvest) pauseToymateHarvestRefillFn();
      emitLog(job.runId, job.task?.id, "info", "Harvest refill paused (checkout lane)");
    } catch {
      /* ignore */
    }
  }
  const cardLast4 = String(payload.card?.number || "")
    .replace(/\s+/g, "")
    .slice(-4) || null;
  console.log(
    "[pay-forensics]",
    JSON.stringify({
      t: new Date().toISOString(),
      ts: Date.now(),
      event: "desktop_run_start",
      desktopTaskId: job.task?.id || null,
      desktopRunId: job.runId,
      desktopAttempt: attemptLabel,
      executorTaskId: payload.taskId,
      store: job.task?.store || null,
      placeOrder: Boolean(payload.placeOrder),
      cardLast4,
      proxy: summary.proxy,
      pdp: summary.storeUrl,
      monitorHit: extra.monitorHit?.productId || null,
    }),
  );
  console.log(
    "[desktop:run]",
    JSON.stringify({
      runId: job.runId,
      taskId: job.task?.id || null,
      phase: "start-executor",
      attempt: attemptLabel,
      cardLast4,
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

  const tid = job.task?.id;
  if (isTaskAborted(tid)) {
    return cancelledResult(job, "stopped_before_run");
  }
  const ac = abortControllerFor(tid);

  let lastStageKey = "";
  const progressTimer = setInterval(async () => {
    try {
      if (isTaskAborted(tid)) return;
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
            lastLabel: line,
            lastStatus: "running",
          });
        }
      }
    } catch (e) {
      console.warn(`[desktop:run] progress poll: ${e.message || e}`);
    }
  }, 1500);

  trackExecutorTaskId(tid, payload.taskId);
  try {
    const res = await sidecar.runTask(payload, { signal: ac?.signal });
    if (isTaskAborted(tid) || res?.cancelled || res?.failedStep === "stopped") {
      return cancelledResult(job, "stopped_after_run");
    }
    const finished = finishResult(job, res, summary);
    if (extra.monitorHit) {
      finished.monitorHit = extra.monitorHit;
      finished.monitorTriggered = true;
      finished.harvestedBridge = Boolean(payload.harvestedBridgeId);
    }
    return finished;
  } catch (e) {
    if (isTaskAborted(tid) || e?.code === "ABORT_ERR" || /aborted/i.test(String(e?.message || ""))) {
      return cancelledResult(job, "stopped_abort");
    }
    throw e;
  } finally {
    untrackExecutorTaskId(tid, payload.taskId);
    clearInterval(progressTimer);
    if (pauseHarvest) {
      try {
        if (pauseBandaiHarvest && typeof resumeBandaiHarvestRefillFn === "function") {
          resumeBandaiHarvestRefillFn();
        }
        if (pauseToymateHarvest && typeof resumeToymateHarvestRefillFn === "function") {
          resumeToymateHarvestRefillFn();
        }
      } catch {
        /* ignore */
      }
    }
  }
}

async function runOneLegacyRotate(job, { sticky, entries, harvestLocked }) {
  let result = await executeOnce(job, {
    rotateSession: false,
    attemptLabel: sticky ? "resi" : "run",
  });
  logResultTail(job, result);

  // Cross-store latch (THIS job's result only): Disney/PKC/Toymate used to
  // re-enter placeOrder after tunnel death / RESPONSE_LOST → second Revolut
  // auth. Stop cold for this runId — sibling tasks on the same profile keep
  // running; nothing here is profile/card-global.
  if (!result.ok && isPaymentAlreadySubmitted(result)) {
    console.warn(
      `[desktop:run] pay latch — skip sticky rotate (posts=${result.chargeReqCount ?? result.bigpayAuthPosts ?? result.undiciAttempts ?? "?"} responseLost=${Boolean(result.responseLost)})`,
    );
    emitLiveStatus(job, "Payment submitted — check bank");
    emitDetailedLog(
      job.runId,
      job.task?.id,
      "warn",
      "Payment already submitted — not rotating / not retrying placeOrder (double-charge guard)",
    );
    return {
      ...result,
      consumerLabel: result.consumerLabel || "Payment submitted — check bank",
      paymentAttempted: true,
    };
  }

  const maxProxyRetriesBase = sticky
    ? Math.min(4, Math.max(2, entries.length || 2))
    : entries.length > 1
      ? Math.min(3, entries.length - 1)
      : 0;
  const maxProxyRetries =
    harvestLocked && !isBandaiLoginBlock(result) ? 0 : maxProxyRetriesBase;
  let proxyRetries = 0;
  while (
    !result.ok &&
    shouldStickyResiRetry(result) &&
    proxyRetries < maxProxyRetries &&
    (entries.length > 1 || sticky)
  ) {
    // Re-check latch each loop — a prior attempt may have reached issuer.
    if (isPaymentAlreadySubmitted(result)) {
      console.warn(
        `[desktop:run] pay latch mid-rotate — abort further placeOrder retries`,
      );
      emitLiveStatus(job, "Payment submitted — check bank");
      return {
        ...result,
        consumerLabel: result.consumerLabel || "Payment submitted — check bank",
        paymentAttempted: true,
      };
    }

    proxyRetries += 1;
    const why = isStickyTunnelDead(result)
      ? "tunnel/TLS failure"
      : isBandaiLoginBlock(result)
        ? "Bandai login SoftBlock"
        : /akamai_unsolved/i.test(`${result.failedStep} ${result.debugError || ""}`)
          ? "unsolved _abck"
          : "Akamai denial";

    const rotateSession = advanceJobProxy(job, {
      sticky,
      entries,
      dropHarvest: isBandaiLoginBlock(result),
    });
    // advanceJobProxy returns whether to mint session; for multi-entry sticky, mint after full walk
    const mint =
      entries.length > 1 ? sticky && proxyRetries >= entries.length : rotateSession;

    console.warn(
      `[desktop:run] proxy rotate ${proxyRetries}/${maxProxyRetries} (${why}) entry ${
        entries.length ? `${(job.proxyIndex || 0) + 1}/${entries.length}` : "session"
      }${mint ? " fresh session" : ""}`,
    );
    emitLiveStatus(job, "Rotating proxy");
    emitDetailedLog(
      job.runId,
      job.task?.id,
      "warn",
      `Switching proxy (${proxyRetries}/${maxProxyRetries}) — ${why}`,
    );

    result = await executeOnce(job, {
      rotateSession: mint,
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
  return result;
}

/**
 * Bandai persistent lane: retry / rotate / wait-restock until stop, decline, or success.
 */
async function runOneBandai(job, { sticky, entries }) {
  const tid = job.task?.id;
  const mode = String(job.task?.bandaiMode || "checkout").toLowerCase();
  // Drop traffic: keep hammering ATC/login/checkout until critical stop or this budget.
  const maxLoops = Math.max(
    8,
    Math.min(500, Number(job.task?.bandaiMaxLoops || process.env.BANDAI_MAX_LOOPS) || 200),
  );
  let rotateCount = 0;
  let retryCount = 0;
  let rotateSession = false;
  let result = null;

  for (let loop = 1; loop <= maxLoops && running; loop++) {
    if (isTaskAborted(tid)) {
      result = cancelledResult(job, "stopped_loop");
      break;
    }
    // New attempt gets a fresh AbortController (prior Stop aborted the old one).
    if (tid) abortControllerFor(tid);

    if (mode === "monitor") {
      emitLiveStatus(job, "Waiting for restock");
    } else if (job.task?.bandaiPayFromCart) {
      emitLiveStatus(job, "Retrying pay");
    } else if (loop === 1) {
      emitLiveStatus(job, "Starting");
    }

    result = await executeOnce(job, {
      rotateSession,
      attemptLabel: `bandai#${loop}`,
    });
    rotateSession = false;
    logResultTail(job, result);

    if (result?.stopped || isTaskAborted(tid)) {
      result = cancelledResult(job, result?.debugError || "stopped");
      break;
    }

    // Clear one-shot pay-from-cart flag after the attempt (re-applied if policy says retry pay).
    if (job.task) job.task.bandaiPayFromCart = false;

    const decision = classifyBandaiRunResult(result, {
      mode,
      loop,
      rotateCount,
      retryCount,
      proxyCount: entries.length || 1,
      maxRotate: Math.max(16, entries.length * 6 || 48),
      maxRetry: 40,
    });

    if (decision.action === "stop") {
      if (decision.liveLabel && decision.liveLabel !== result.consumerLabel) {
        result = { ...result, consumerLabel: decision.liveLabel, consumerCode: decision.consumerCode || result.consumerCode };
      }
      // Hard decline / pay already submitted — never keep a held-cart retry latch.
      if (
        job.task &&
        (decision.reason === "hard_decline" ||
          decision.reason === "pay_already_submitted" ||
          decision.consumerCode === "declined" ||
          result.consumerCode === "declined")
      ) {
        job.task.heldCart = null;
        job.task.bandaiPayFromCart = false;
        result = { ...result, heldCart: null, heldPayRetry: false };
      }
      break;
    }

    emitLiveStatus(job, decision.liveLabel || "Retrying");
    emitDetailedLog(
      job.runId,
      job.task?.id,
      "info",
      `Bandai policy ${decision.action} (${decision.reason}) loop=${loop}/${maxLoops}`,
    );

    if (decision.action === "rotate") {
      rotateCount += 1;
      if (decision.clearHeldCart && job.task) {
        job.task.heldCart = null;
        job.task.bandaiPayFromCart = false;
        if (!job.task.bandaiWatchSku) job.task.bandaiAreaItemNo = null;
      }
      rotateSession = advanceJobProxy(job, {
        sticky,
        entries,
        dropHarvest: true,
      });
      if (entries.length > 1) {
        // After a full walk of the list, mint a fresh sticky session token.
        if (sticky && rotateCount >= entries.length) rotateSession = true;
      } else {
        rotateSession = sticky;
      }
      if (!(await sleepUnlessAborted(tid, decision.delayMs))) {
        result = cancelledResult(job, "stopped_delay");
        break;
      }
      continue;
    }

    if (decision.action === "retry") {
      retryCount += 1;
      if (decision.clearHeldCart && job.task) {
        job.task.heldCart = null;
        job.task.bandaiPayFromCart = false;
        // Keep bandaiAreaItemNo only when it still matches the watch SKU resolve path;
        // drop orphan NAI so the next loop resolves fresh for this product.
        if (!job.task.bandaiWatchSku) job.task.bandaiAreaItemNo = null;
        emitDetailedLog(
          job.runId,
          job.task?.id,
          "info",
          "Cleared held cart — will ATC this SKU fresh",
        );
      } else if (decision.retryPay) {
        applyHeldCartForPayRetry(job, result);
      }
      if (!(await sleepUnlessAborted(tid, decision.delayMs))) {
        result = cancelledResult(job, "stopped_delay");
        break;
      }
      continue;
    }

    if (decision.action === "wait_restock") {
      retryCount += 1;
      // Drop pay-from-cart; next loop is a fresh ATC / monitor wait.
      if (job.task) {
        delete job.task.bandaiPayFromCart;
      }
      if (!(await sleepUnlessAborted(tid, decision.delayMs))) {
        result = cancelledResult(job, "stopped_delay");
        break;
      }
      continue;
    }

    break;
  }

  if (tid) clearAbortState(tid);
  return result;
}

async function runOne(job) {
  const tid = job?.task?.id || null;
  emit({
    type: "job",
    phase: "start",
    taskId: tid,
    runId: job.runId,
    label: job.task?.label || job.task?.pdpUrl,
    consumerLabel: "Starting",
    lastLabel: "Starting",
    lastStatus: "running",
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
    if (entries.length && job.task) job.task._proxyEntries = entries;
    const harvestLocked = Boolean(
      job.task?.harvestedSession?.cookies || job.task?.harvestedBridgeId || job.task?.harvestedProxy,
    );

    const isBandai = String(job.task?.store || "") === "bandai";
    const result = isBandai
      ? await runOneBandai(job, { sticky, entries })
      : await runOneLegacyRotate(job, { sticky, entries, harvestLocked });

    // Decline → drop in-memory hold so Retry pay cannot re-fire on stale cartSn.
    if (
      isBandai &&
      job.task &&
      (result?.consumerCode === "declined" ||
        /^declined$/i.test(String(result?.checkoutStage || "")))
    ) {
      job.task.heldCart = null;
      job.task.bandaiPayFromCart = false;
    }

    emit({ type: "job", phase: "done", ...result });
    onFinished?.(result);
  } catch (e) {
    const debugError = e.message || String(e);
    console.error(`[desktop:run] executor threw: ${debugError}`);
    const result = {
      ok: false,
      taskId: tid,
      runId: job.runId,
      error: "Something went wrong",
      consumerLabel: "Something went wrong",
      consumerCode: "error",
      stockStatus: "unknown",
      debugError,
      at: Date.now(),
    };
    emitLog(job.runId, tid, "err", result.consumerLabel);
    emit({ type: "job", phase: "done", ...result });
    onFinished?.(result);
  } finally {
    releaseTaskId(tid);
    if (tid) clearAbortState(tid);
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
  stopTasks,
  isTaskAborted,
  buildPayload,
  normalizeProxy,
  isAkamaiWwwBlocked,
  isProxyEgressFailed,
  /** Test-only: replace executeOnce (null restores real sidecar path). */
  __setExecuteOnceForTests(fn) {
    executeOnceOverride = typeof fn === "function" ? fn : null;
  },
};
