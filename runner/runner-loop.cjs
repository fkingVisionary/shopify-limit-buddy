// The runner loop: short-polls the control plane for jobs, executes each via
// the local Playwright state machine, posts results back. Single-flight: at
// most one checkout in-flight at a time (real Shopify rate limits + the user
// can pair more devices for parallelism later).

const { runCheckout } = require("./checkout.cjs");

const POLL_INTERVAL_MS = 2000;

const runnerState = {
  controlPlaneUrl: "",
  deviceName: "Runner",
  deviceToken: "",
  deviceId: "",
  status: "idle",   // idle | polling | running | error
  lastError: null,
  recent: [],       // last few job summaries
};

let pollTimer = null;
let running = false;
let stopRequested = false;

function emit(emitter, evt) {
  try { emitter && emitter(evt); } catch {}
}

async function postResult(result) {
  try {
    await fetch(`${runnerState.controlPlaneUrl}/api/public/runner/report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-runner-token": runnerState.deviceToken,
      },
      body: JSON.stringify(result),
    });
  } catch (e) {
    runnerState.lastError = `report failed: ${e.message}`;
  }
}

async function pollOnce(emitter) {
  if (running) return;
  try {
    const res = await fetch(`${runnerState.controlPlaneUrl}/api/public/runner/poll`, {
      headers: { "x-runner-token": runnerState.deviceToken },
    });
    if (!res.ok) {
      runnerState.status = "error";
      runnerState.lastError = `poll HTTP ${res.status}`;
      emit(emitter, { type: "status", status: runnerState.status, error: runnerState.lastError });
      return;
    }
    const { job } = await res.json();
    if (!job) {
      runnerState.status = "polling";
      emit(emitter, { type: "status", status: "polling" });
      return;
    }

    running = true;
    runnerState.status = "running";
    emit(emitter, { type: "job-start", job: { id: job.id, storeUrl: job.storeUrl, dryRun: job.dryRun } });

    const start = Date.now();
    let result;
    try {
      result = await runCheckout(job);
    } catch (e) {
      result = {
        jobId: job.id, ok: false, failedStep: "transport",
        error: e.message, steps: [], screenshotB64: null,
        elapsedMs: Date.now() - start,
      };
    }

    runnerState.recent.push({
      id: job.id,
      ok: result.ok,
      orderId: result.ok ? result.orderId : null,
      error: result.ok ? null : result.error,
      at: Date.now(),
    });
    if (runnerState.recent.length > 20) runnerState.recent.shift();

    await postResult(result);
    emit(emitter, { type: "job-done", result: {
      jobId: result.jobId, ok: result.ok,
      summary: result.ok ? (result.dryRun ? "Dry-run OK" : `Order ${result.orderId ?? "?"}`) : `${result.failedStep}: ${result.error}`,
    }});
  } catch (e) {
    runnerState.status = "error";
    runnerState.lastError = e.message;
    emit(emitter, { type: "status", status: "error", error: e.message });
  } finally {
    running = false;
  }
}

function startRunnerLoop(emitter) {
  stopRequested = false;
  if (pollTimer) return;
  runnerState.status = "polling";
  emit(emitter, { type: "status", status: "polling" });
  const tick = async () => {
    if (stopRequested) return;
    await pollOnce(emitter);
    if (!stopRequested) pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  tick();
}

function stopRunnerLoop() {
  stopRequested = true;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  runnerState.status = "idle";
}

module.exports = { startRunnerLoop, stopRunnerLoop, runnerState };
