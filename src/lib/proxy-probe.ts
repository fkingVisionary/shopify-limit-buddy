/** Shared proxy probe result taxonomy (web + desktop). */

export type ProxyProbeStatus =
  | "store_ok"
  | "alive"
  | "timeout"
  | "auth"
  | "connect"
  | "store_block"
  | "invalid"
  | "error";

export type ProxyProbeResult = {
  ok: boolean;
  status: ProxyProbeStatus;
  latencyMs: number;
  exitIp: string | null;
  targetStatus: number | null;
  error: string | null;
  label: string;
};

const STATUS_LABELS: Record<ProxyProbeStatus, string> = {
  store_ok: "OK",
  alive: "ALIVE",
  timeout: "TIMEOUT",
  auth: "AUTH",
  connect: "CONNECT",
  store_block: "STORE",
  invalid: "INVALID",
  error: "ERROR",
};

export function proxyProbeStatusLabel(status: ProxyProbeStatus): string {
  return STATUS_LABELS[status] ?? status.toUpperCase();
}

function compactError(message: string | null | undefined): string | null {
  if (!message) return null;
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || null;
}

function isTimeoutMessage(msg: string): boolean {
  return /timeout|timed out|AbortError|ABORTED|deadline/i.test(msg);
}

function isAuthMessage(msg: string): boolean {
  return /Proxy authentication failed|ERR_PROXY_AUTH|HTTP\/1\.[01] 407|\b407\b|authentication required/i.test(msg);
}

function isConnectMessage(msg: string): boolean {
  return /ERR_TUNNEL|ERR_PROXY_CONNECTION|CONNECT|tunnel|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|could not parse proxy/i.test(
    msg,
  );
}

export function classifyProxyProbeError(message: string | null | undefined): ProxyProbeStatus {
  const msg = String(message || "");
  if (!msg) return "error";
  if (isTimeoutMessage(msg)) return "timeout";
  if (isAuthMessage(msg)) return "auth";
  if (isConnectMessage(msg)) return "connect";
  return "error";
}

export function makeInvalidProbeResult(reason: string): ProxyProbeResult {
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

export function makeErrorProbeResult(message: string, latencyMs = 0): ProxyProbeResult {
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

/**
 * Map executor `checks.proxy` (from POST /health/diagnose → probeProxyConnect)
 * into the UI taxonomy.
 */
export function classifyDiagnoseProxyCheck(
  proxyCheck: {
    ok?: boolean;
    skipped?: boolean;
    elapsedMs?: number;
    egressIp?: string | null;
    error?: string | null;
    parsed?: boolean;
    target?: { status?: number | null; error?: string | null; ok?: boolean; bytes?: number | null };
  } | null | undefined,
  fallbackElapsedMs = 0,
): ProxyProbeResult {
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

  const targetOk = proxyCheck.target?.ok !== false && (targetStatus == null || (targetStatus > 0 && targetStatus < 500));
  if (targetError || !targetOk) {
    const combined = targetError || (targetStatus != null ? `HTTP ${targetStatus}` : "store probe failed");
    let status: ProxyProbeStatus = "store_block";
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

/** Map Browserless/ipify checkProxyExit into the same taxonomy. */
export function classifyBrowserlessHealth(r: {
  ok: boolean;
  latencyMs: number;
  exitIp: string | null;
  error: string | null;
  targetStatus?: number | null;
  targetError?: string | null;
}): ProxyProbeResult {
  if (!r.ok) {
    const status = classifyProxyProbeError(r.error);
    return {
      ok: false,
      status,
      latencyMs: r.latencyMs,
      exitIp: r.exitIp,
      targetStatus: r.targetStatus ?? null,
      error: compactError(r.error),
      label: STATUS_LABELS[status],
    };
  }

  if (r.targetError || (typeof r.targetStatus === "number" && r.targetStatus >= 500)) {
    return {
      ok: false,
      status: "store_block",
      latencyMs: r.latencyMs,
      exitIp: r.exitIp,
      targetStatus: r.targetStatus ?? null,
      error: compactError(r.targetError) || (r.targetStatus != null ? `HTTP ${r.targetStatus}` : "store probe failed"),
      label: STATUS_LABELS.store_block,
    };
  }

  if (typeof r.targetStatus === "number" && r.targetStatus > 0) {
    const blocked = r.targetStatus >= 400;
    return {
      ok: !blocked,
      status: blocked ? "store_block" : "store_ok",
      latencyMs: r.latencyMs,
      exitIp: r.exitIp,
      targetStatus: r.targetStatus,
      error: blocked ? `HTTP ${r.targetStatus}` : null,
      label: blocked ? STATUS_LABELS.store_block : STATUS_LABELS.store_ok,
    };
  }

  return {
    ok: true,
    status: "alive",
    latencyMs: r.latencyMs,
    exitIp: r.exitIp,
    targetStatus: null,
    error: null,
    label: STATUS_LABELS.alive,
  };
}
