// Map local executor /run JSON the same way the web UI uses mapKmartRunToTaskPatch.
// The adapter often returns ok:false with lastSteps/checkoutStage and NO top-level error.

function stepBlob(res) {
  const steps = Array.isArray(res?.steps) ? res.steps : [];
  const lastSteps = Array.isArray(res?.lastSteps) ? res.lastSteps : [];
  return [...steps, ...lastSteps];
}

/** True when proxy was set but exit IP matched direct (or parse failed). */
function isProxyEgressFailed(res) {
  if (!res || res.ok) return false;
  if (res.failedStep === "proxy_egress" || res.failedStep === "proxy_parse") return true;
  return stepBlob(res).some(
    (s) =>
      s &&
      s.ok === false &&
      /^(proxy_egress|proxy_parse|proxy_config)$/.test(String(s.step || "")) &&
      /same=true|parseFailed/i.test(String(s.note || "")),
  );
}

function formatExecutorFailure(res) {
  if (!res || typeof res !== "object") return "checkout failed (empty response)";
  if (res.error) return String(res.error);

  const steps = Array.isArray(res.steps) ? res.steps : [];
  const lastSteps = Array.isArray(res.lastSteps) ? res.lastSteps : steps.slice(-12);
  const failed = [...steps].reverse().find((s) => s && s.ok === false);
  const failedRecent = lastSteps.filter((s) => s && s.ok === false).slice(-4);
  const blob = JSON.stringify({ steps: lastSteps, failed, checkoutStage: res.checkoutStage });

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
  if (isProxyEgressFailed(res)) {
    bits.push(
      "hint: Proxy is configured but exit IP matches direct egress — the tunnel is not changing exit. Fix the proxy entry / local manager so exit IP actually changes.",
    );
  } else if (/resolve_ip:required|resolve_ip:warn/i.test(blob)) {
    bits.push(
      "hint: IP-echo hosts failed through this proxy (common on some residential pools). Run continues; try ISP or another resi provider if Akamai still 403s.",
    );
  } else if (/Access Denied|AkamaiGHost|pdp_get.*403|category_browse.*403/i.test(blob)) {
    bits.push(
      "hint: Akamai blocked WWW (category/PDP). Proxy must change egress — ISP exits often clear this when residential does not.",
    );
  }
  if (/bm_sv=false/i.test(blob) && /Access Denied/i.test(blob) && !isProxyEgressFailed(res)) {
    bits.push("hint: SBSD posted OK but bm_sv never minted — classic prelude to hard 403 on category/PDP.");
  }
  if (!bits.length && res.ok === false) {
    bits.push("executor ok=false (no failed step notes — check proxy/egress)");
  }
  return bits.join(" | ") || "checkout failed";
}

/** True when this looks like an Akamai WWW wall (not a card/3DS/proxy fail). */
function isAkamaiWwwBlocked(res) {
  if (!res || res.ok) return false;
  if (isProxyEgressFailed(res)) return false;
  const text = [
    res.error,
    res.checkoutStage,
    res.failedStep,
    ...(Array.isArray(res.lastSteps) ? res.lastSteps.map((s) => `${s.step} ${s.status} ${s.note}`) : []),
    ...(Array.isArray(res.steps) ? res.steps.map((s) => `${s.step} ${s.status} ${s.note}`) : []),
  ]
    .filter(Boolean)
    .join(" ");
  return /Access Denied|AkamaiGHost|pdp_get#?\d*\s*HTTP 403|pdp_get[^\n]*403|category_browse[^\n]*403|stage=pre_cart/i.test(
    text,
  );
}

function summarizePayload(payload) {
  return {
    taskId: payload.taskId,
    storeUrl: payload.storeUrl,
    qty: payload.qty,
    placeOrder: payload.placeOrder === true,
    dryRun: payload.dryRun !== false,
    kmartMode: payload.kmartMode || "current",
    transport: payload.forceTls === true || payload.transport === "tls" ? "tls" : "undici",
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

/** Compact one-line timeline for every executor step (UI + console + e2e). */
function formatStepLine(s, { maxNote = 220 } = {}) {
  if (!s) return "";
  const mark = s.ok === false ? "FAIL" : s.ok === true ? "OK  " : "----";
  const status = s.status != null ? ` HTTP ${s.status}` : "";
  const ms = s.ms != null ? ` ${s.ms}ms` : "";
  const note = String(s.note || "").replace(/\s+/g, " ").trim().slice(0, maxNote);
  return `${mark} ${s.step || "?"}${status}${ms}${note ? ` — ${note}` : ""}`;
}

function formatStepTimeline(steps, { maxNote = 220 } = {}) {
  if (!Array.isArray(steps) || !steps.length) return [];
  return steps.map((s) => formatStepLine(s, { maxNote }));
}

/** Pull cookie / SoftBlock signals out of step notes for a quick scan. */
function extractAkamaiSignals(steps) {
  const blob = (Array.isArray(steps) ? steps : [])
    .map((s) => `${s.step} ${s.note || ""}`)
    .join("\n");
  const abck = blob.match(/abck=(\d+b\s+ind=-?\d+|[^,\s]+)/i);
  const bmSv = /bm_sv=true/i.test(blob) ? true : /bm_sv=false/i.test(blob) ? false : null;
  const denied = /Access Denied|AkamaiGHost|denied=true/i.test(blob);
  const sensorSolved = /ind=0|~0~|abck_raw/i.test(blob) && /ind=0|abck_raw/i.test(blob);
  return {
    abckHint: abck?.[1] || null,
    bm_sv: bmSv,
    accessDeniedSeen: denied,
    sensorSolvedHint: sensorSolved,
  };
}

module.exports = {
  formatExecutorFailure,
  isAkamaiWwwBlocked,
  isProxyEgressFailed,
  summarizePayload,
  stageLogLine,
  formatStepLine,
  formatStepTimeline,
  extractAkamaiSignals,
};
