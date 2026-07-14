// Bounded local job queue. Stability first: cap concurrent /run calls so
// Chromium 3DS tails don't OOM the machine. Future store adapters plug in
// via buildPayload(store) — Kmart is the only v1 adapter.
//
// Payload shape intentionally mirrors src/lib/kmart-task.ts
// buildKmartExecutorPayload so behaviour matches the web → Fly path.

const sidecar = require("./executor-sidecar.cjs");
const { id } = require("./store.cjs");
const { normalizeKmartProxy } = require("./proxy-format.cjs");
const { formatExecutorFailure, summarizePayload, stageLogLine } = require("./run-format.cjs");

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

function buildKmartPayload({ task, profile, proxyRaw, placeOrder }) {
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

  // Match web: place order requires a complete card on the profile.
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

  // Same field set as buildKmartExecutorPayload / runOnExecutor InputSchema.
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
      kmartMode: task.kmartMode === "playwright" ? "playwright" : "current",
      httpHandoff: true,
      skipAtc: false,
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

/** Build executor payload by store adapter id. */
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

async function runOne(job) {
  const built = buildPayload(job);
  if (!built.ok) {
    const result = {
      ok: false,
      taskId: job.task?.id,
      runId: job.runId,
      error: built.error,
      at: Date.now(),
    };
    emitLog(job.runId, job.task?.id, "err", `payload rejected: ${built.error}`);
    emit({ type: "job", phase: "done", ...result });
    onFinished?.(result);
    return;
  }

  const payload = built.data;
  payload.taskId = job.runId;

  const summary = summarizePayload(payload);
  emit({
    type: "job",
    phase: "start",
    taskId: job.task?.id,
    runId: job.runId,
    label: job.task?.label || payload.storeUrl,
    summary,
  });
  emitLog(
    job.runId,
    job.task?.id,
    "info",
    `dispatch → local executor | proxy=${summary.proxy} | placeOrder=${summary.placeOrder} | mode=${summary.kmartMode}`,
  );
  emitLog(job.runId, job.task?.id, "info", `pdp=${summary.storeUrl}`);

  let lastStageKey = "";
  const progressTimer = setInterval(async () => {
    try {
      const p = await sidecar.progress(job.runId);
      if (p?.found && p.progress) {
        const line = stageLogLine(p.progress);
        const key = `${p.progress.stage}|${p.progress.step || ""}|${p.progress.detail || ""}`;
        // Only emit when stage/step/detail changes — avoids flooding the log.
        if (key !== lastStageKey) {
          lastStageKey = key;
          emit({
            type: "job",
            phase: "progress",
            taskId: job.task?.id,
            runId: job.runId,
            progress: p.progress,
            message: line,
          });
        }
      }
    } catch (e) {
      emitLog(job.runId, job.task?.id, "warn", `progress poll: ${e.message || e}`);
    }
  }, 1500);

  try {
    const res = await sidecar.runTask(payload);
    const errorText = res?.ok ? null : formatExecutorFailure(res);
    // Main-process console (DevTools → Console / terminal that launched Electron)
    console.log(
      "[desktop:run]",
      JSON.stringify({
        runId: job.runId,
        ok: res?.ok,
        checkoutStage: res?.checkoutStage,
        failedStep: res?.failedStep,
        error: errorText,
        lastSteps: res?.lastSteps ?? res?.steps?.slice?.(-8),
        elapsedMs: res?.elapsedMs,
        proxy: summary.proxy,
      }),
    );
    const result = {
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
      raw: {
        ok: res?.ok,
        checkoutStage: res?.checkoutStage,
        orderNumber: res?.orderNumber,
        failedStep: res?.failedStep,
        adapter: res?.adapter,
        transport: res?.transport,
      },
    };

    if (result.ok) {
      emitLog(
        job.runId,
        job.task?.id,
        "ok",
        `done OK${result.orderNumber ? ` order=${result.orderNumber}` : ""} stage=${result.checkoutStage || "?"} ${result.elapsedMs ?? "?"}ms`,
      );
    } else {
      emitLog(job.runId, job.task?.id, "err", `done FAIL — ${errorText}`);
      const tail = result.lastSteps || [];
      for (const s of tail.slice(-8)) {
        emitLog(
          job.runId,
          job.task?.id,
          s.ok ? "info" : "err",
          `  step ${s.ok ? "OK" : "FAIL"} ${s.step}${s.status != null ? ` [${s.status}]` : ""} — ${String(s.note || "").slice(0, 200)}`,
        );
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
  } finally {
    clearInterval(progressTimer);
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
};
