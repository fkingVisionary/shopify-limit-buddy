// Bounded local job queue. Stability first: cap concurrent /run calls so
// Chromium 3DS tails don't OOM the machine. Future store adapters plug in
// via buildPayload(store) — Kmart is the only v1 adapter.
//
// Payload shape intentionally mirrors src/lib/kmart-task.ts
// buildKmartExecutorPayload so behaviour matches the web → Fly path.
//
// Desktop-only: on Akamai WWW Access Denied (common on Windows home egress
// vs Fly Linux), optionally retry with TLS impersonation then Playwright warm
// — same executor endpoints, no architecture rewrite.

const sidecar = require("./executor-sidecar.cjs");
const { id } = require("./store.cjs");
const { normalizeKmartProxy } = require("./proxy-format.cjs");
const {
  formatExecutorFailure,
  isAkamaiWwwBlocked,
  summarizePayload,
  stageLogLine,
} = require("./run-format.cjs");

let queue = [];
let inflight = 0;
let running = false;
let maxConcurrent = 5;
let akamaiRetry = true; // settings: retryTlsPlaywright
let emit = () => {};
let onFinished = null;

function setEmitter(fn) {
  emit = typeof fn === "function" ? fn : () => {};
}

function setFinishedHandler(fn) {
  onFinished = typeof fn === "function" ? fn : null;
}

function configure({ maxConcurrent: n, akamaiRetry: retry } = {}) {
  if (n != null) maxConcurrent = Math.max(1, Math.min(50, Number(n) || 5));
  if (typeof retry === "boolean") akamaiRetry = retry;
}

function state() {
  return {
    running,
    inflight,
    queued: queue.length,
    maxConcurrent,
    akamaiRetry,
  };
}

/** @deprecated use normalizeKmartProxy — kept for tests */
function normalizeProxy(raw) {
  const r = normalizeKmartProxy(raw);
  return r.ok ? r.proxy : null;
}

function buildKmartPayload({ task, profile, proxyRaw, placeOrder, transport, kmartMode, forceTls }) {
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

  const mode =
    kmartMode === "playwright" || task.kmartMode === "playwright" ? "playwright" : "current";
  const wantTls = forceTls === true || transport === "tls";

  return {
    ok: true,
    data: {
      taskId: task.runId || task.id || id("run"),
      storeUrl: pdp,
      variantId: Number(task.variantId) || 1,
      qty: Math.max(1, Math.min(20, Number(task.qty) || 1)),
      proxy: proxyNorm.proxy,
      dryRun: !placeOrder,
      placeOrder: Boolean(placeOrder),
      debugTrace: true,
      kmartMode: mode,
      httpHandoff: true,
      skipAtc: false,
      ...(wantTls ? { transport: "tls", forceTls: true } : { forceUndici: true }),
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

function finishResult(job, res, summary, attemptLabel) {
  const errorText = res?.ok ? null : formatExecutorFailure(res);
  console.log(
    "[desktop:run]",
    JSON.stringify({
      runId: job.runId,
      attempt: attemptLabel,
      ok: res?.ok,
      checkoutStage: res?.checkoutStage,
      failedStep: res?.failedStep,
      error: errorText,
      lastSteps: res?.lastSteps ?? res?.steps?.slice?.(-8),
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
    failedStep: res?.failedStep ?? null,
    elapsedMs: res?.elapsedMs ?? null,
    at: Date.now(),
    lastSteps: Array.isArray(res?.lastSteps) ? res.lastSteps : null,
    paymentTail: Array.isArray(res?.paymentTail) ? res.paymentTail : null,
    attempt: attemptLabel,
    raw: {
      ok: res?.ok,
      checkoutStage: res?.checkoutStage,
      orderNumber: res?.orderNumber,
      failedStep: res?.failedStep,
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
      `done OK${result.orderNumber ? ` order=${result.orderNumber}` : ""} stage=${result.checkoutStage || "?"} ${result.elapsedMs ?? "?"}ms (${result.attempt || "run"})`,
    );
    return;
  }
  emitLog(job.runId, job.task?.id, "err", `done FAIL (${result.attempt || "run"}) — ${result.error}`);
  for (const s of (result.lastSteps || []).slice(-8)) {
    emitLog(
      job.runId,
      job.task?.id,
      s.ok ? "info" : "err",
      `  step ${s.ok ? "OK" : "FAIL"} ${s.step}${s.status != null ? ` [${s.status}]` : ""} — ${String(s.note || "").slice(0, 200)}`,
    );
  }
}

async function executeAttempt(job, overrides, attemptLabel) {
  const built = buildPayload({ ...job, ...overrides });
  if (!built.ok) {
    return { ok: false, error: built.error, attempt: attemptLabel };
  }
  const payload = built.data;
  // Unique taskId per attempt so progress doesn't collide.
  payload.taskId = `${job.runId}-${attemptLabel}`;
  const summary = summarizePayload(payload);

  emitLog(
    job.runId,
    job.task?.id,
    "info",
    `attempt=${attemptLabel} → executor | proxy=${summary.proxy} | transport=${summary.transport} | mode=${summary.kmartMode} | placeOrder=${summary.placeOrder}`,
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
    return finishResult(job, res, summary, attemptLabel);
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

  // Attempt ladder (desktop only). Same executor; different transport/mode.
  // 1) undici (Fly-default path)
  // 2) on Akamai WWW block → tls impersonation
  // 3) still blocked → playwright warm handoff
  const attempts = [{ label: "undici", overrides: { forceTls: false, transport: "undici", kmartMode: "current" } }];
  if (akamaiRetry) {
    attempts.push({ label: "tls", overrides: { forceTls: true, transport: "tls", kmartMode: "current" } });
    attempts.push({ label: "playwright", overrides: { forceTls: false, transport: "undici", kmartMode: "playwright" } });
  }

  try {
    let result = null;
    for (let i = 0; i < attempts.length; i++) {
      const { label, overrides } = attempts[i];
      result = await executeAttempt(job, overrides, label);
      logResultTail(job, result);
      if (result.ok) break;
      const more = i < attempts.length - 1;
      if (more && isAkamaiWwwBlocked(result)) {
        emitLog(
          job.runId,
          job.task?.id,
          "warn",
          `Akamai WWW block after ${label} — retrying with ${attempts[i + 1].label} (Windows/home egress often needs this; Fly undici may not)`,
        );
        continue;
      }
      if (more && !isAkamaiWwwBlocked(result)) {
        // Non-Akamai failure (card, etc.) — don't burn TLS/Playwright retries.
        break;
      }
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
};
