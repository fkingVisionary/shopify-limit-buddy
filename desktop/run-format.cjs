// Map local executor /run JSON the same way the web UI uses mapKmartRunToTaskPatch.
// The adapter often returns ok:false with lastSteps/checkoutStage and NO top-level error.

function formatExecutorFailure(res) {
  if (!res || typeof res !== "object") return "checkout failed (empty response)";
  if (res.error) return String(res.error);

  const steps = Array.isArray(res.steps) ? res.steps : [];
  const lastSteps = Array.isArray(res.lastSteps) ? res.lastSteps : steps.slice(-12);
  const failed = [...steps].reverse().find((s) => s && s.ok === false);
  const failedRecent = lastSteps.filter((s) => s && s.ok === false).slice(-4);

  const bits = [];
  if (res.failedStep) bits.push(String(res.failedStep));
  if (res.checkoutStage) bits.push(`stage=${res.checkoutStage}`);
  if (failed) {
    bits.push(`${failed.step}${failed.status != null ? ` HTTP ${failed.status}` : ""}: ${String(failed.note || "").slice(0, 180)}`);
  }
  for (const s of failedRecent) {
    if (failed && s.step === failed.step && s.note === failed.note) continue;
    bits.push(`${s.step}${s.status != null ? ` HTTP ${s.status}` : ""}: ${String(s.note || "").slice(0, 120)}`);
  }
  if (!bits.length && res.ok === false) {
    bits.push("executor ok=false (no failed step notes — check proxy/egress)");
  }
  return bits.join(" | ") || "checkout failed";
}

function summarizePayload(payload) {
  return {
    taskId: payload.taskId,
    storeUrl: payload.storeUrl,
    qty: payload.qty,
    placeOrder: payload.placeOrder === true,
    dryRun: payload.dryRun !== false,
    kmartMode: payload.kmartMode || "current",
    proxy: payload.proxy || "(direct — this machine's egress)",
    hasCard: Boolean(payload.card?.number),
    hasProfile: Boolean(payload.profile?.email || payload.profile?.first_name),
  };
}

function stageLogLine(progress) {
  if (!progress) return null;
  const parts = [
    progress.label || progress.stage,
    progress.step ? `[${progress.step}]` : null,
    progress.detail || progress.hint || null,
  ].filter(Boolean);
  return parts.join(" — ");
}

module.exports = {
  formatExecutorFailure,
  summarizePayload,
  stageLogLine,
};
