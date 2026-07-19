// Mirrors src/lib/proxy-probe.ts — classify executor diagnose proxy checks.

const STATUS_LABELS = {
  store_ok: "OK",
  alive: "ALIVE",
  timeout: "TIMEOUT",
  auth: "AUTH",
  connect: "CONNECT",
  store_block: "STORE",
  invalid: "INVALID",
  error: "ERROR",
};

function proxyProbeStatusLabel(status) {
  return STATUS_LABELS[status] ?? String(status || "").toUpperCase();
}

function compactError(message) {
  if (!message) return null;
  return String(message).replace(/\s+/g, " ").trim().slice(0, 240) || null;
}

function isTimeoutMessage(msg) {
  return /timeout|timed out|AbortError|ABORTED|deadline/i.test(msg);
}

function isAuthMessage(msg) {
  return /Proxy authentication failed|ERR_PROXY_AUTH|HTTP\/1\.[01] 407|\b407\b|authentication required/i.test(msg);
}

function isConnectMessage(msg) {
  return /ERR_TUNNEL|ERR_PROXY_CONNECTION|CONNECT|tunnel|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|could not parse proxy/i.test(
    msg,
  );
}

function classifyProxyProbeError(message) {
  const msg = String(message || "");
  if (!msg) return "error";
  if (isTimeoutMessage(msg)) return "timeout";
  if (isAuthMessage(msg)) return "auth";
  if (isConnectMessage(msg)) return "connect";
  return "error";
}

function makeInvalidProbeResult(reason) {
  return {
    ok: false,
    status: "invalid",
    latencyMs: 0,
    exitIp: null,
    targetStatus: null,
    error: reason,
    label: STATUS_LABELS.invalid,
  };
}

function makeErrorProbeResult(message, latencyMs = 0) {
  const status = classifyProxyProbeError(message);
  return {
    ok: false,
    status,
    latencyMs,
    exitIp: null,
    targetStatus: null,
    error: compactError(message),
    label: STATUS_LABELS[status],
  };
}

function classifyDiagnoseProxyCheck(proxyCheck, fallbackElapsedMs = 0) {
  if (!proxyCheck || proxyCheck.skipped) {
    return makeErrorProbeResult(proxyCheck?.error || "proxy probe skipped");
  }

  const latencyMs = Number(proxyCheck.elapsedMs) || fallbackElapsedMs;
  const exitIp = proxyCheck.egressIp ?? null;
  const targetStatus =
    typeof proxyCheck.target?.status === "number" ? proxyCheck.target.status : null;
  const topError = compactError(proxyCheck.error);
  const targetError = compactError(proxyCheck.target?.error);

  if (topError) {
    const status = classifyProxyProbeError(topError);
    return {
      ok: false,
      status,
      latencyMs,
      exitIp,
      targetStatus,
      error: topError,
      label: STATUS_LABELS[status],
    };
  }

  if (proxyCheck.parsed === false) {
    return {
      ok: false,
      status: "connect",
      latencyMs,
      exitIp: null,
      targetStatus: null,
      error: "could not parse proxy string",
      label: STATUS_LABELS.connect,
    };
  }

  if (!exitIp) {
    return {
      ok: false,
      status: "connect",
      latencyMs,
      exitIp: null,
      targetStatus,
      error: targetError || "no egress IP",
      label: STATUS_LABELS.connect,
    };
  }

  const targetOk =
    proxyCheck.target?.ok !== false && (targetStatus == null || (targetStatus > 0 && targetStatus < 500));
  if (targetError || !targetOk) {
    const combined = targetError || (targetStatus != null ? `HTTP ${targetStatus}` : "store probe failed");
    let status = "store_block";
    if (isTimeoutMessage(combined)) status = "timeout";
    else if (isAuthMessage(combined)) status = "auth";
    else if (isConnectMessage(combined) && targetStatus == null) status = "connect";
    return {
      ok: false,
      status,
      latencyMs,
      exitIp,
      targetStatus,
      error: combined,
      label: STATUS_LABELS[status],
    };
  }

  return {
    ok: true,
    status: targetStatus != null ? "store_ok" : "alive",
    latencyMs,
    exitIp,
    targetStatus,
    error: null,
    label: targetStatus != null ? STATUS_LABELS.store_ok : STATUS_LABELS.alive,
  };
}

module.exports = {
  STATUS_LABELS,
  proxyProbeStatusLabel,
  makeInvalidProbeResult,
  makeErrorProbeResult,
  classifyDiagnoseProxyCheck,
  classifyProxyProbeError,
};
