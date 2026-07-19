// Bounded local job queue. Stability first: cap concurrent /run calls so
// Chromium 3DS tails don't OOM the machine. Future store adapters plug in
// via buildPayload(store) — Kmart is the only v1 adapter.
//
// Payload shape intentionally mirrors src/lib/kmart-task.ts
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
  stageLogLine,
} = require("./run-format.cjs");

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

function buildPayload(job) {
  const store = job.task?.store || "kmart";
  if (store === "kmart") {
    return buildKmartPayload(job);
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
  const errorText = res?.ok ? null : formatExecutorFailure(res);
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
      checkoutStage: res?.checkoutStage,
      failedStep,
      error: errorText,
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
    error: errorText,
    checkoutStage: res?.checkoutStage ?? null,
    failedStep,
    elapsedMs: res?.elapsedMs ?? null,
    at: Date.now(),
    lastSteps,
    steps: Array.isArray(res?.steps) ? res.steps : null,
    paymentTail: Array.isArray(res?.paymentTail) ? res.paymentTail : null,
    attempt: "undici",
    raw: {
      ok: res?.ok,
      checkoutStage: res?.checkoutStage,
      orderNumber: res?.orderNumber,
      failedStep,
      adapter: res?.adapter,
      transport: res?.transport,
    },
  };
}

function logResultTail(job, result) {
  if (result.ok) {
    emitLog(
      job.runId,
      job.task?.id,
      "ok",
      `done OK${result.orderNumber ? ` order=${result.orderNumber}` : ""} stage=${result.checkoutStage || "?"} ${result.elapsedMs ?? "?"}ms`,
    );
    return;
  }
  emitLog(job.runId, job.task?.id, "err", `done FAIL — ${result.error}`);
  for (const s of (result.lastSteps || []).slice(-8)) {
    emitLog(
      job.runId,
      job.task?.id,
      s.ok ? "info" : "err",
      `  step ${s.ok ? "OK" : "FAIL"} ${s.step}${s.status != null ? ` [${s.status}]` : ""} — ${String(s.note || "").slice(0, 200)}`,
    );
  }
}

/** Sticky-only: Akamai / soft-API denial worth a fresh exit. */
function isResidentialAkamaiBlock(result) {
  if (!result || result.ok) return false;
  const blob = [
    result.error,
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
    result.error,
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
      error: built.error,
      at: Date.now(),
      attempt: attemptLabel,
    };
  }

  const payload = built.data;
  payload.taskId = `${job.runId}-${attemptLabel}`;
  const summary = summarizePayload(payload);

  emitLog(
    job.runId,
    job.task?.id,
    "info",
    `→ executor (${attemptLabel}) | proxy=${summary.proxy} | transport=${summary.transport} | mode=${summary.kmartMode} | placeOrder=${summary.placeOrder}`,
  );
  emitLog(job.runId, job.task?.id, "info", `pdp=${summary.storeUrl}`);

  let lastStageKey = "";
  const progressTimer = setInterval(async () => {
    try {
      const p = await sidecar.progress(payload.taskId);
      if (p?.found && p.progress) {
        const line = stageLogLine(p.progress);
        const key = `${p.progress.stage}|${p.progress.step || ""}|${p.progress.detail || ""}`;
        if (key !== lastStageKey) {
          lastStageKey = key;
          emit({
            type: "job",
            phase: "progress",
            taskId: job.task?.id,
            runId: job.runId,
            progress: p.progress,
            message: `[${attemptLabel}] ${line}`,
          });
        }
      }
    } catch (e) {
      emitLog(job.runId, job.task?.id, "warn", `progress poll: ${e.message || e}`);
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
    // often landed on worse Noontide exits. ISP has no session- → unchanged.
    let result = await executeOnce(job, {
      rotateSession: false,
      attemptLabel: sticky ? "resi" : "run",
    });
    logResultTail(job, result);

    // Sticky only: advance through group entries, then mint a fresh session-
    // on the last entry. ISP never enters this loop.
    const maxStickyRetries = Math.min(4, Math.max(2, entries.length || 2));
    let stickyRetries = 0;
    while (
      !result.ok &&
      sticky &&
      shouldStickyResiRetry(result) &&
      stickyRetries < maxStickyRetries
    ) {
      stickyRetries += 1;
      const why = isStickyTunnelDead(result)
        ? "tunnel/TLS failure"
        : /akamai_unsolved/i.test(`${result.failedStep} ${result.error}`)
          ? "unsolved _abck"
          : "Akamai denial";

      let rotateSession = false;
      if (entries.length > 1) {
        job.proxyIndex = (Number(job.proxyIndex) + 1) % entries.length;
        job.proxyRaw = entries[job.proxyIndex];
        // After one full pass of listed exits, mint a fresh session- token.
        rotateSession = stickyRetries >= entries.length;
        emitLog(
          job.runId,
          job.task?.id,
          "warn",
          `Sticky residential ${why} — retry ${stickyRetries}/${maxStickyRetries} entry ${job.proxyIndex + 1}/${entries.length}${rotateSession ? " (fresh session)" : ""} (ISP unchanged)`,
        );
      } else {
        rotateSession = true;
        emitLog(
          job.runId,
          job.task?.id,
          "warn",
          `Sticky residential ${why} — retry ${stickyRetries}/${maxStickyRetries} with a fresh session exit (ISP unchanged)`,
        );
      }

      result = await executeOnce(job, {
        rotateSession,
        attemptLabel: stickyRetries === 1 ? "resi-retry" : `resi-retry#${stickyRetries}`,
      });
      logResultTail(job, result);
    }

    emit({ type: "job", phase: "done", ...result });
    onFinished?.(result);
  } catch (e) {
    const result = {
      ok: false,
      taskId: job.task?.id,
      runId: job.runId,
      error: e.message || String(e),
      at: Date.now(),
    };
    emitLog(job.runId, job.task?.id, "err", `executor threw: ${result.error}`);
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
