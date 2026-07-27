/**
 * Auto-arm / auto-stop Pokémon Centre edge harvest around Monitor → checkout jobs.
 *
 * - Arms at enqueue (while monitor polls) so Reese+DD jars mint before restock.
 * - Claims stay at trigger / run-start — not during monitor polls on monitor proxies.
 * - Prefer Harvest tab checkout ISP group over the task's monitor proxy group.
 * - Manual Harvest start takes ownership (we won't auto-stop).
 */

const { shouldCheckoutOnMonitorHit } = require("./pokemoncentre-monitor-checkout.cjs");

function isPcStore(store) {
  const s = String(store || "").toLowerCase();
  return s === "pokemoncentre" || s === "pokemon" || s === "pokemoncenter";
}

function isPcMonitorCheckoutJob(job, placeOrderDefault = true) {
  const task = job?.task;
  if (!task || !isPcStore(task.store)) return false;
  if (String(task.pcMode || task.pokemoncentreMode || "") !== "monitor") return false;
  if (task.pcAutoHarvest === false) return false;
  return shouldCheckoutOnMonitorHit(task, job.placeOrder !== false && placeOrderDefault !== false);
}

function resolveHarvestProxyGroupId(job, harvestSnap) {
  const cfg = harvestSnap?.config?.proxyGroupId;
  if (cfg) return String(cfg);
  const task = job?.task || {};
  // Explicit checkout ISP group — never confuse with monitor poll proxies.
  if (task.pcHarvestProxyGroupId) return String(task.pcHarvestProxyGroupId);
  if (task.harvestProxyGroupId) return String(task.harvestProxyGroupId);
  // Last resort: task proxy group (may be monitor-only — caller should prefer Harvest tab).
  if (task.proxyGroupId) return String(task.proxyGroupId);
  return null;
}

function createPokemonCentreHarvestAutoArm({ harvest, getEntries, idFn, log } = {}) {
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

  function ensureForJobs(jobs = [], { placeOrderDefault = true } = {}) {
    const list = Array.isArray(jobs) ? jobs : [];
    const candidates = list.filter((j) => isPcMonitorCheckoutJob(j, placeOrderDefault));
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
        "PC Harvest auto-arm skipped — set sticky proxy group on Harvest → Pokémon Centre (checkout ISP, not monitor proxies)";
      emitLog(msg);
      return { ok: false, armed: false, error: msg, reason: "missing_proxy_group" };
    }

    const locale = String(
      candidates[0].task?.pcLocale || snap.config?.locale || "en-au",
    ).toLowerCase();
    const want = Math.min(12, Math.max(1, refs.size + candidates.length));
    const desired = Math.min(12, Math.max(want, Number(snap.config?.desired) || 0));
    const solveCaptcha = snap.config?.solveCaptcha === true;

    const wasRunning = Boolean(snap.running);
    if (!wasRunning) {
      harvest.configure({ proxyGroupId, desired, locale, solveCaptcha });
      harvest.start({
        proxyGroupId,
        desired,
        locale,
        solveCaptcha,
        getEntries: typeof getEntries === "function" ? getEntries : undefined,
      });
      weStarted = true;
      emitLog(
        `PC Harvest auto-armed (desired ${desired}, locale ${locale}) for Monitor → checkout`,
      );
    } else {
      const patch = { desired };
      if (!snap.config?.proxyGroupId) patch.proxyGroupId = proxyGroupId;
      if (locale) patch.locale = locale;
      harvest.configure(patch);
      emitLog(`PC Harvest already armed — desired → ${desired} for Monitor → checkout`);
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
      emitLog("PC Harvest auto-stopped (Monitor jobs finished; bank kept until TTL/claim)");
      return { released: true, stopped: true, ...snapshotRefs() };
    }
    if (refs.size > 0 && weStarted) {
      const desired = Math.min(12, Math.max(1, refs.size));
      harvest.configure({ desired });
    }
    return { released: true, stopped: false, ...snapshotRefs() };
  }

  function markManualStart() {
    weStarted = false;
  }

  function markManualStop() {
    refs.clear();
    weStarted = false;
  }

  return {
    ensureForJobs,
    release,
    markManualStart,
    markManualStop,
    isPcMonitorCheckoutJob,
    resolveHarvestProxyGroupId,
    snapshot: snapshotRefs,
  };
}

module.exports = {
  createPokemonCentreHarvestAutoArm,
  isPcMonitorCheckoutJob,
  resolveHarvestProxyGroupId,
};
