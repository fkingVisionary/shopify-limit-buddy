// Bounded local job queue. Stability first: cap concurrent /run calls so
// Chromium 3DS tails don't OOM the machine. Store adapters plug in via
// buildPayload(store) — Kmart + Toymate + Bandai (isolated branches).
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

let queue = [];
let inflight = 0;
let running = false;
let maxConcurrent = 5;
let emit = () => {};
let onFinished = null;

function setEmitter(fn) {
  emit = typeof fn === "function" ? fn : () => {};
}

function setFinishedHandler(fn) {
  onFinished = typeof fn === "function" ? fn : null;
}

function configure({ maxConcurrent: n } = {}) {
  if (n != null) maxConcurrent = Math.max(1, Math.min(50, Number(n) || 5));
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
      error: "Bandai product URL (p-bandai.com/au/…) or product code required",
    };
  }

  const proxyNorm = normalizeKmartProxy(proxyRaw);
  if (!proxyNorm.ok) return { ok: false, error: proxyNorm.error };

  const proxy = rotateStickyProxySession(proxyNorm.proxy, {
    force: rotateSession === true || process.env.DESKTOP_ROTATE_PROXY_SESSION === "1",
  });

  const storeUrl =
    mode === "account_gen" || mode === "monitor" || !input
      ? "https://p-bandai.com/au/"
      : /^https?:\/\//i.test(input)
        ? input
        : `https://p-bandai.com/au/item/${input}`;

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

  if (mode === "account_gen") {
    if (!otp.onlinesimApiKey) {
      return { ok: false, error: "OnlineSim API key missing in Settings" };
    }
    if (!otp.imapHost || !otp.imapUser || !otp.imapAppPassword) {
      return { ok: false, error: "IMAP host/user/app password required in Settings" };
    }
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
      // HTTP-first: F5 sensor bridge mints headers; full Playwright checkout opt-in only.
      bandaiBrowserCheckout: task.bandaiBrowserCheckout === true,
      bandaiF5Bridge: task.bandaiF5Bridge !== false,
      bandaiMode: mode,
      campaignSn: task.campaignSn || null,
      accountPassword:
        typeof task.accountPassword === "string" && task.accountPassword.trim()
          ? task.accountPassword.trim()
          : null,
      account: resolvedAccount,
      accountAssignSource,
      otp: mode === "account_gen" ? otp : undefined,
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
  // Keep analytical step tail in the main-process console only — not the consumer log.
  if (result.debugError) {
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
    return finishResult(job, res, summary);
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
    const maxProxyRetries = sticky
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
