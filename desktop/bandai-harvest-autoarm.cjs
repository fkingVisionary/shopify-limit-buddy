/**
 * Auto-arm / auto-stop Bandai F5 harvest around Monitor → checkout jobs.
 *
 * - Arms at enqueue (while monitor polls) so bridges mint before restock.
 * - Claims stay at trigger time (job-runner) — unchanged.
 * - Stops refill when the last auto-armed job finishes, only if we started it.
 * - Manual Harvest start takes ownership (we won't auto-stop).
 * - Does not clear the bank on stop — leftover bridges remain claimable until TTL.
 */

const { shouldCheckoutOnMonitorHit } = require("./bandai-monitor-checkout.cjs");

function isBandaiMonitorCheckoutJob(job, placeOrderDefault = true) {
  const task = job?.task;
  if (!task || String(task.store || "") !== "bandai") return false;
  if (String(task.bandaiMode || "") !== "monitor") return false;
  if (task.bandaiAutoHarvest === false) return false;
  return shouldCheckoutOnMonitorHit(task, job.placeOrder !== false && placeOrderDefault !== false);
}

function resolveHarvestProxyGroupId(job, harvestSnap) {
  const cfg = harvestSnap?.config?.proxyGroupId;
  if (cfg) return String(cfg);
  const task = job?.task || {};
  if (task.bandaiHarvestProxyGroupId) return String(task.bandaiHarvestProxyGroupId);
  // Last resort: task proxy group (may be monitor-only — caller should prefer Harvest tab).
  if (task.proxyGroupId) return String(task.proxyGroupId);
  return null;
}

function createBandaiHarvestAutoArm({ harvest, getEntries, idFn, log } = {}) {
  if (!harvest) throw new Error("harvest required");
  /** @type {Set<string>} */
  const refs = new Set();
  let weStarted = false;
  const emitLog = typeof log === "function" ? log : () => {};
  const nextId =
    typeof idFn === "function"
      ? idFn
      : () => `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  function snapshotRefs() {
    return {
      refs: refs.size,
      weStarted,
      runIds: [...refs],
    };
  }

  /**
   * Ensure harvest is filling for Monitor→checkout jobs about to enqueue.
   * Mutates jobs to assign runId early when missing.
   */
  function ensureForJobs(jobs = [], { placeOrderDefault = true } = {}) {
    const list = Array.isArray(jobs) ? jobs : [];
    const candidates = list.filter((j) => isBandaiMonitorCheckoutJob(j, placeOrderDefault));
    if (!candidates.length) {
      return { ok: true, armed: false, skipped: true, reason: "no_monitor_checkout_jobs" };
    }

    for (const j of candidates) {
      if (!j.runId) j.runId = nextId();
    }

    const snap = harvest.snapshot();
    const proxyGroupId = resolveHarvestProxyGroupId(candidates[0], snap);
    if (!proxyGroupId) {
      const msg =
        "Bandai Harvest auto-arm skipped — set sticky proxy group on Harvest → Bandai (checkout ISP, not monitor proxies)";
      emitLog(msg);
      return { ok: false, armed: false, error: msg, reason: "missing_proxy_group" };
    }

    const area = String(candidates[0].task?.bandaiArea || snap.config?.area || "au")
      .toLowerCase()
      .slice(0, 2);
    const want = Math.min(6, Math.max(1, refs.size + candidates.length));
    const desired = Math.min(6, Math.max(want, Number(snap.config?.desired) || 0));

    const wasRunning = Boolean(snap.running);
    if (!wasRunning) {
      harvest.configure({ proxyGroupId, desired, area });
      harvest.start({
        proxyGroupId,
        desired,
        area,
        getEntries: typeof getEntries === "function" ? getEntries : undefined,
      });
      weStarted = true;
      emitLog(
        `Bandai Harvest auto-armed (desired ${desired}, area ${area}) for Monitor → checkout`,
      );
    } else {
      const patch = { desired };
      if (!snap.config?.proxyGroupId) patch.proxyGroupId = proxyGroupId;
      if (area) patch.area = area;
      harvest.configure(patch);
      // Manual (or prior) arm owns lifecycle — do not steal stop.
      emitLog(`Bandai Harvest already armed — desired → ${desired} for Monitor → checkout`);
    }

    for (const j of candidates) refs.add(String(j.runId));

    const after = harvest.snapshot();
    return {
      ok: true,
      armed: true,
      weStarted,
      wasRunning,
      desired: after.config?.desired,
      ready: after.ready,
      proxyGroupId: after.config?.proxyGroupId || proxyGroupId,
      refs: refs.size,
      runIds: candidates.map((j) => j.runId),
    };
  }

  function release(runId) {
    const id = String(runId || "");
    if (!id || !refs.has(id)) {
      return { released: false, ...snapshotRefs() };
    }
    refs.delete(id);
    if (refs.size === 0 && weStarted) {
      harvest.stop();
      weStarted = false;
      emitLog("Bandai Harvest auto-stopped (Monitor jobs finished; bank kept until TTL/claim)");
      return { released: true, stopped: true, ...snapshotRefs() };
    }
    if (refs.size > 0 && weStarted) {
      const desired = Math.min(6, Math.max(1, refs.size));
      harvest.configure({ desired });
    }
    return { released: true, stopped: false, ...snapshotRefs() };
  }

  /** User clicked Start on Harvest tab — they own stop. */
  function markManualStart() {
    weStarted = false;
  }

  /** User clicked Stop / engine stop — drop refs. */
  function markManualStop() {
    refs.clear();
    weStarted = false;
  }

  return {
    ensureForJobs,
    release,
    markManualStart,
    markManualStop,
    isBandaiMonitorCheckoutJob,
    resolveHarvestProxyGroupId,
    snapshot: snapshotRefs,
  };
}

module.exports = {
  createBandaiHarvestAutoArm,
  isBandaiMonitorCheckoutJob,
  resolveHarvestProxyGroupId,
};
