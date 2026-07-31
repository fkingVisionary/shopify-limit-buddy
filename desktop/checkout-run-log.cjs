// Rolling JSONL of finished checkout runs — local troubleshooting only.
// Never write cards, passwords, full proxy URLs, API keys, or webhook secrets.

const fs = require("fs");
const path = require("path");
const { looksLike3ds } = require("./discord-webhook.cjs");

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_TAIL_BYTES = 512 * 1024;

function resolveLogPath(dataDir) {
  const dir = path.join(String(dataDir || ""), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "checkout-runs.jsonl");
}

function rotateIfNeeded(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (st.size <= MAX_BYTES) return;
    const fd = fs.openSync(filePath, "r");
    try {
      const start = Math.max(0, st.size - KEEP_TAIL_BYTES);
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      const cut = text.indexOf("\n");
      const tail = cut >= 0 ? text.slice(cut + 1) : text;
      fs.writeFileSync(`${filePath}.tmp`, tail, "utf8");
      fs.renameSync(`${filePath}.tmp`, filePath);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best-effort */
  }
}

/** Host:port only — strip credentials from proxy URLs. */
function proxyHostOnly(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const withScheme = /^[a-z]+:\/\//i.test(s) ? s : `http://${s}`;
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return s
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/^[^@]+@/, "")
      .split("/")[0]
      .slice(0, 120) || null;
  }
}

/** Strip secrets / long noise from debug strings before disk. */
function redactDebugHint(raw, maxLen = 280) {
  let s = String(raw || "");
  if (!s) return null;
  s = s
    .replace(/https?:\/\/[^\s"'\\]+/gi, "[url]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|password|secret|cvv|cvc)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[card]")
    .replace(/[^\s:@/]+:[^\s:@/]+@/g, "[creds]@");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function extractSku(task, result) {
  const candidates = [
    result?.productCode,
    result?.heldCart?.productCode,
    task?.bandaiWatchSku,
    task?.input,
    task?.pdpUrl,
    task?.sku,
  ];
  for (const c of candidates) {
    const m = String(c || "").match(/\b(N\d{7,}[A-Za-z0-9]*|A\d{7,}[A-Za-z0-9]*|NAI[A-Za-z0-9]+)\b/i);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/**
 * Did this run reach Global-e / tokenize / 3DS / issuer (bank ping possible)?
 * Opposite of died at login / ATC / OOS / cart before pay.
 */
function didReachPay(result = {}) {
  if (result.ok && result.orderNumber) return true;
  if (result.reached3ds === true) return true;
  if (result.paymentStatus) return true;
  if (looksLike3ds(result)) return true;
  const stage = String(result.checkoutStage || "").toLowerCase();
  if (/tokenize|threeds|3ds|declined|order|place_order|payment/.test(stage)) return true;
  const step = String(result.failedStep || "").toLowerCase();
  if (/tokenize|threeds|3ds|ge_payment|place_order|charge|payment/.test(step)) return true;
  // Held cart after a pay attempt (retry pay) — issuer path was entered.
  if (
    result.heldPayRetry === true &&
    (result.cartSn || result.heldCart?.cartSn) &&
    /declined|auth_failed|tokenize|threeds|fraud/i.test(
      `${result.paymentStatus || ""} ${result.checkoutStage || ""} ${result.consumerCode || ""}`,
    )
  ) {
    return true;
  }
  if (result.consumerCode === "declined" || result.consumerCode === "held_pay_retry") {
    return true;
  }
  return false;
}

/**
 * Normalize a finished job into a safe disk row.
 * @param {object} result finishResult / setFinishedHandler payload
 * @param {object} [task] optional task row for store/sku/label
 */
function buildCheckoutRunRow(result = {}, task = null) {
  const ok = Boolean(result.ok);
  let outcome = String(result.consumerCode || (ok ? "complete" : "error"));
  if (!ok && looksLike3ds(result) && !/oos|declined|checkout_address|proxy|akamai/i.test(outcome)) {
    outcome = "threeds";
  }
  const reachedPay = didReachPay({ ...result, consumerCode: outcome });
  // Coarse lane for scanning: pre_pay (never bank) vs pay (issuer path).
  let lane = "pre_pay";
  if (ok && result.orderNumber) lane = "ordered";
  else if (reachedPay) lane = "pay";
  else if (outcome === "oos" || result.stockStatus === "oos") lane = "oos";
  else if (outcome === "cart_held") lane = "cart";
  return {
    at: result.at || Date.now(),
    runId: result.runId || null,
    taskId: result.taskId || task?.id || null,
    store: task?.store || result.raw?.adapter || null,
    label: task?.label || task?.title || null,
    sku: extractSku(task, result),
    ok,
    outcome,
    lane,
    reachedPay,
    consumerLabel: result.consumerLabel || result.error || null,
    stockStatus: result.stockStatus || null,
    failedStep: result.failedStep || null,
    checkoutStage: result.checkoutStage || null,
    paymentStatus: result.paymentStatus || null,
    orderNumber: result.orderNumber || null,
    elapsedMs: result.elapsedMs ?? null,
    proxyHost: proxyHostOnly(result.proxy || result.raw?.proxy),
    proxyRotated: Boolean(result.proxyRotated),
    debugHint: redactDebugHint(result.debugError),
    accountGen: Boolean(result.accountGen),
    loginCheck: Boolean(result.loginCheck),
  };
}

function appendCheckoutRun(dataDir, result, task = null) {
  if (!dataDir || !result) return false;
  // Skip pure account-gen / login-check noise unless they failed hard — still log them briefly.
  try {
    const filePath = resolveLogPath(dataDir);
    const row = buildCheckoutRunRow(result, task);
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
    rotateIfNeeded(filePath);
    return true;
  } catch {
    return false;
  }
}

function readCheckoutRuns(dataDir, { limit = 100 } = {}) {
  const filePath = resolveLogPath(dataDir);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const slice = lines.slice(-Math.max(1, Math.min(2000, Number(limit) || 100)));
    return slice
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  appendCheckoutRun,
  readCheckoutRuns,
  buildCheckoutRunRow,
  didReachPay,
  redactDebugHint,
  proxyHostOnly,
  resolveLogPath,
};
