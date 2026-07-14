// Bounded local job queue. Stability first: cap concurrent /run calls so
// Chromium 3DS tails don't OOM the machine. Future store adapters plug in
// via buildPayload(store) — Kmart is the only v1 adapter.

const sidecar = require("./executor-sidecar.cjs");
const { id } = require("./store.cjs");

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

function normalizeProxy(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  // Already URL form
  if (/^https?:\/\//i.test(s)) return s;
  // user:pass@host:port
  if (/^.+@.+:\d+$/.test(s)) return `http://${s}`;
  // user:pass:host:port
  let m = s.match(/^([^:]+):([^:]+):([^:]+):(\d+)$/);
  if (m) return `http://${encodeURIComponent(m[1])}:${encodeURIComponent(m[2])}@${m[3]}:${m[4]}`;
  // host:port:user:pass
  m = s.match(/^([^:]+):(\d+):([^:]+):(.+)$/);
  if (m) return `http://${encodeURIComponent(m[3])}:${encodeURIComponent(m[4])}@${m[1]}:${m[2]}`;
  // host:port (incl. 127.0.0.1:PORT)
  m = s.match(/^([^:]+):(\d+)$/);
  if (m) return `http://${m[1]}:${m[2]}`;
  return s;
}

function buildKmartPayload({ task, profile, proxyRaw, placeOrder }) {
  const pdp = String(task.pdpUrl || task.storeUrl || "").trim();
  if (!/^https:\/\/(www\.)?kmart\.com\.au\//i.test(pdp)) {
    return { ok: false, error: "Kmart PDP URL required" };
  }
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

  return {
    ok: true,
    data: {
      taskId: task.runId || task.id || id("run"),
      storeUrl: pdp,
      variantId: Number(task.variantId) || 1,
      qty: Math.max(1, Math.min(20, Number(task.qty) || 1)),
      proxy: normalizeProxy(proxyRaw),
      dryRun: !placeOrder,
      placeOrder: Boolean(placeOrder),
      debugTrace: true,
      kmartMode: task.kmartMode === "playwright" ? "playwright" : "current",
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
    emit({ type: "job", phase: "done", ...result });
    onFinished?.(result);
    return;
  }

  const payload = built.data;
  payload.taskId = job.runId;

  emit({
    type: "job",
    phase: "start",
    taskId: job.task?.id,
    runId: job.runId,
    label: job.task?.label || payload.storeUrl,
  });

  const progressTimer = setInterval(async () => {
    try {
      const p = await sidecar.progress(job.runId);
      if (p?.found && p.progress) {
        emit({
          type: "job",
          phase: "progress",
          taskId: job.task?.id,
          runId: job.runId,
          progress: p.progress,
        });
      }
    } catch {
      /* ignore poll errors */
    }
  }, 1500);

  try {
    const res = await sidecar.runTask(payload);
    const result = {
      ok: Boolean(res?.ok),
      taskId: job.task?.id,
      runId: job.runId,
      orderNumber: res?.orderNumber ?? res?.result?.orderNumber ?? null,
      error: res?.error || (!res?.ok ? "checkout failed" : null),
      checkoutStage: res?.checkoutStage ?? null,
      elapsedMs: res?.elapsedMs ?? null,
      at: Date.now(),
      raw: {
        ok: res?.ok,
        checkoutStage: res?.checkoutStage,
        orderNumber: res?.orderNumber,
        failedStep: res?.failedStep,
      },
    };
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
