/**
 * Bandai desktop drop ops — schedule, readiness, Drop Mode, lane summaries.
 * Pure helpers (no Electron) so unit tests stay offline.
 */

const SYDNEY = "Australia/Sydney";

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Parts of "now" in Australia/Sydney. */
function sydneyNowParts(nowMs = Date.now()) {
  const dtf = new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(nowMs)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Parse fire time. Accepts:
 * - "13:00" / "1:00 PM" (next occurrence AEST/AEDT)
 * - "2026-07-27T13:00" (interpreted as Sydney wall time)
 * - epoch ms number
 */
function parseDropFireAt(input, nowMs = Date.now()) {
  if (input == null || input === "") return { ok: false, error: "fire time required" };
  if (typeof input === "number" && Number.isFinite(input)) {
    if (input <= nowMs) return { ok: false, error: "fire time is in the past" };
    return { ok: true, atMs: input, label: formatSydneyWall(input) };
  }
  const raw = String(input).trim();
  if (/^\d{13}$/.test(raw)) {
    const atMs = Number(raw);
    if (atMs <= nowMs) return { ok: false, error: "fire time is in the past" };
    return { ok: true, atMs, label: formatSydneyWall(atMs) };
  }

  // ISO-ish date + time as Sydney wall clock
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const atMs = sydneyWallToUtcMs({
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6] || 0),
    });
    if (atMs == null) return { ok: false, error: "invalid Sydney datetime" };
    if (atMs <= nowMs) return { ok: false, error: "fire time is in the past" };
    return { ok: true, atMs, label: formatSydneyWall(atMs) };
  }

  // HH:mm or h:mm AM/PM → next Sydney occurrence
  m = raw.match(/^(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?$/);
  if (!m) return { ok: false, error: "use HH:mm AEST or YYYY-MM-DDTHH:mm" };
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[3] ? m[3].toUpperCase() : null;
  if (ampm) {
    if (hour < 1 || hour > 12) return { ok: false, error: "invalid hour" };
    if (ampm === "AM") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  }
  if (hour > 23 || minute > 59) return { ok: false, error: "invalid time" };

  const now = sydneyNowParts(nowMs);
  let candidate = sydneyWallToUtcMs({
    year: now.year,
    month: now.month,
    day: now.day,
    hour,
    minute,
    second: 0,
  });
  if (candidate == null) return { ok: false, error: "invalid Sydney time" };
  if (candidate <= nowMs + 500) {
    // Roll to next calendar day in Sydney
    const tomorrow = new Date(Date.UTC(now.year, now.month - 1, now.day + 1));
    // Use parts of tomorrow by adding 24h to a noon anchor
    const noonToday = sydneyWallToUtcMs({
      year: now.year,
      month: now.month,
      day: now.day,
      hour: 12,
      minute: 0,
      second: 0,
    });
    const nextDayParts = sydneyNowParts((noonToday || nowMs) + 36 * 3600_000);
    candidate = sydneyWallToUtcMs({
      year: nextDayParts.year,
      month: nextDayParts.month,
      day: nextDayParts.day,
      hour,
      minute,
      second: 0,
    });
  }
  if (candidate == null || candidate <= nowMs) {
    return { ok: false, error: "could not schedule future fire time" };
  }
  return { ok: true, atMs: candidate, label: formatSydneyWall(candidate) };
}

/**
 * Convert a Sydney wall-clock tuple to UTC ms via iterative offset probe.
 */
function sydneyWallToUtcMs({ year, month, day, hour, minute, second = 0 }) {
  // Initial guess: treat as UTC, then correct by Sydney offset at that instant.
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i++) {
    const p = sydneyNowParts(guess);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(year, month - 1, day, hour, minute, second);
    const delta = want - asUtc;
    guess += delta;
    if (Math.abs(delta) < 1000) break;
  }
  const check = sydneyNowParts(guess);
  if (
    check.year !== year ||
    check.month !== month ||
    check.day !== day ||
    check.hour !== hour ||
    check.minute !== minute
  ) {
    return null;
  }
  return guess;
}

function formatSydneyWall(atMs) {
  const p = sydneyNowParts(atMs);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)} AEST/AEDT`;
}

function msUntil(atMs, nowMs = Date.now()) {
  return Math.max(0, Number(atMs) - nowMs);
}

function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${pad2(sec)}s`;
  if (m > 0) return `${m}m ${pad2(sec)}s`;
  return `${sec}s`;
}

/**
 * Stagger offsets for N lanes (default ≤150ms spread).
 */
function staggerOffsets(laneCount, { maxSpreadMs = 150, gapMs = 50 } = {}) {
  const n = Math.max(0, Math.min(50, Number(laneCount) || 0));
  if (n <= 1) return [0];
  const gap = Math.max(0, Math.min(150, Number(gapMs) || 50));
  const max = Math.max(0, Math.min(500, Number(maxSpreadMs) || 150));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.min(max, i * gap));
  }
  return out;
}

/**
 * Enabled Bandai Autocheckout / chance lanes (not monitor/agen).
 */
function listBandaiDropTasks(tasks = []) {
  return (tasks || []).filter((t) => {
    if (!t || t.enabled === false) return false;
    if (String(t.store || "") !== "bandai") return false;
    const mode = String(t.bandaiMode || "checkout").toLowerCase();
    return mode === "checkout" || mode === "chance";
  });
}

function countDropLanes(tasks = []) {
  return listBandaiDropTasks(tasks).reduce(
    (sum, t) => sum + Math.max(1, Math.min(50, Number(t.quantity) || 1)),
    0,
  );
}

function accountLooksLoginOk(account) {
  if (!account) return false;
  const st = String(account.status || "").toLowerCase();
  if (!["ready", "active"].includes(st)) return false;
  if (!account.email || !account.password) return false;
  // Optional same-day proof stamp
  const provenAt = Number(account.loginProvenAt) || 0;
  return { ok: true, provenAt, sameDay: isSydneySameDay(provenAt) };
}

function isSydneySameDay(ts, nowMs = Date.now()) {
  if (!ts) return false;
  const a = sydneyNowParts(ts);
  const b = sydneyNowParts(nowMs);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * Drop readiness checklist for the Tasks strip.
 */
function assessDropReady({
  engineRunning = false,
  harvest = null,
  tasks = [],
  accounts = [],
  proxyGroups = [],
  nowMs = Date.now(),
} = {}) {
  const dropTasks = listBandaiDropTasks(tasks);
  const lanes = countDropLanes(tasks);
  const harvestReady = Number(harvest?.ready) || 0;
  const harvestDesired = Number(harvest?.config?.desired);
  const harvestArmed = Boolean(harvest?.running) || harvestReady > 0;
  const harvestProxyGroupId = harvest?.config?.proxyGroupId || null;

  const checks = [];

  checks.push({
    id: "engine",
    ok: Boolean(engineRunning),
    label: engineRunning ? "Engine on" : "Engine offline",
  });

  checks.push({
    id: "lanes",
    ok: lanes > 0,
    label: lanes > 0 ? `${lanes} Bandai lane(s)` : "No enabled Bandai Autocheckout tasks",
  });

  const harvestOk = harvestReady >= Math.max(1, lanes) || (lanes === 0 && harvestReady >= 0);
  checks.push({
    id: "harvest",
    ok: lanes === 0 ? true : harvestReady >= lanes,
    label:
      lanes === 0
        ? `Harvest ${harvestReady}/${Number.isFinite(harvestDesired) ? harvestDesired : "–"}`
        : harvestReady >= lanes
          ? `Harvest ${harvestReady}/${lanes} ready`
          : `Harvest ${harvestReady}/${lanes} — start more warm sessions`,
  });

  // Accounts: each drop task should resolve to a login-ok vault row when possible.
  let accountOk = 0;
  let accountNeed = 0;
  const accountIssues = [];
  for (const t of dropTasks) {
    accountNeed += 1;
    const assign = String(t.accountAssign || "auto").toLowerCase();
    let acc = null;
    if (assign === "manual" && t.accountId) {
      acc = (accounts || []).find((a) => a.id === t.accountId);
    } else {
      // Soft: any bandai ready/active with password counts toward pool.
      acc = (accounts || []).find(
        (a) =>
          String(a.storeId || "") === "bandai" &&
          ["ready", "active"].includes(String(a.status || "").toLowerCase()) &&
          a.email &&
          a.password,
      );
    }
    const look = accountLooksLoginOk(acc);
    if (look && look.ok) {
      accountOk += 1;
      if (!look.sameDay) {
        accountIssues.push(`${acc.email}: not login-proven today`);
      }
    } else {
      accountIssues.push(t.label || t.id || "task: no vault account");
    }
  }
  const accountsPass = accountNeed === 0 || accountOk >= accountNeed;
  checks.push({
    id: "accounts",
    ok: accountsPass,
    warn: accountsPass && accountIssues.some((x) => /not login-proven/.test(x)),
    label:
      accountNeed === 0
        ? "Accounts —"
        : accountsPass
          ? `Accounts ${accountOk}/${accountNeed}${
              accountIssues.some((x) => /not login-proven/.test(x)) ? " (prove today)" : " ok"
            }`
          : `Accounts ${accountOk}/${accountNeed} — fix vault`,
  });

  // Sticky checkout proxy group on harvest or tasks
  let proxyOk = false;
  if (harvestProxyGroupId) {
    const g = (proxyGroups || []).find((x) => x.id === harvestProxyGroupId);
    proxyOk = Boolean(g?.entries?.length);
  }
  if (!proxyOk) {
    proxyOk = dropTasks.every((t) => {
      const g = (proxyGroups || []).find((x) => x.id === t.proxyGroupId);
      return Boolean(g?.entries?.length);
    });
  }
  checks.push({
    id: "proxies",
    ok: lanes === 0 ? true : proxyOk,
    label: proxyOk ? "Proxies set" : "Set sticky checkout proxy group",
  });

  const blocking = checks.filter((c) => !c.ok);
  const ready = blocking.length === 0 && lanes > 0;
  return {
    ready,
    lanes,
    harvestReady,
    harvestArmed,
    harvestDesired: Number.isFinite(harvestDesired) ? harvestDesired : null,
    checks,
    accountIssues,
    text: checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label}`).join(" · "),
    at: nowMs,
  };
}

/**
 * Drop Mode: desired harvest bank = lane count; prefer existing harvest proxy group.
 */
function planDropMode({ tasks = [], harvest = null } = {}) {
  const dropTasks = listBandaiDropTasks(tasks);
  const lanes = countDropLanes(tasks);
  if (!lanes) {
    return { ok: false, error: "Enable at least one Bandai Autocheckout task", lanes: 0 };
  }
  const proxyGroupId =
    harvest?.config?.proxyGroupId ||
    dropTasks.find((t) => t.proxyGroupId)?.proxyGroupId ||
    null;
  if (!proxyGroupId) {
    return {
      ok: false,
      error: "Set sticky proxy group on Harvest → Bandai (or on each task)",
      lanes,
    };
  }
  return {
    ok: true,
    lanes,
    desired: Math.min(6, Math.max(1, lanes)),
    proxyGroupId,
    area: dropTasks[0]?.bandaiArea || harvest?.config?.area || "au",
    taskIds: dropTasks.map((t) => t.id),
  };
}

/**
 * Compact after-action line for a finished Bandai lane.
 */
function formatLaneAfterAction(result = {}) {
  const stage = result.checkoutStage || result.consumerCode || null;
  const fail = result.failedStep || null;
  const area = result.areaItemNo || null;
  const cart = result.cartSn || result.heldCart?.cartSn || null;
  const tx =
    result.transactionId ||
    result.geTransactionId ||
    (String(result.note || "").match(/tx=(\d+)/i) || [])[1] ||
    null;
  const wall =
    result.atcWallMs != null
      ? `${Math.round(result.atcWallMs)}ms ATC`
      : result.elapsedMs != null
        ? `${Math.round(result.elapsedMs)}ms`
        : null;

  const bits = [];
  if (result.ok && result.orderNumber) bits.push(`order ${result.orderNumber}`);
  else if (stage) bits.push(String(stage));
  if (fail && !result.ok) bits.push(`fail:${fail}`);
  if (area) bits.push(String(area));
  if (cart) bits.push(`cart ${cart}`);
  if (tx) bits.push(`tx=${tx}`);
  if (wall) bits.push(wall);
  if (result.heldPayRetry || result.consumerCode === "held_pay_retry") bits.push("Retry pay");
  if (!bits.length) {
    bits.push(result.consumerLabel || result.error || (result.ok ? "ok" : "failed"));
  }
  return bits.join(" · ").slice(0, 180);
}

module.exports = {
  SYDNEY,
  sydneyNowParts,
  parseDropFireAt,
  sydneyWallToUtcMs,
  formatSydneyWall,
  msUntil,
  formatCountdown,
  staggerOffsets,
  listBandaiDropTasks,
  countDropLanes,
  accountLooksLoginOk,
  isSydneySameDay,
  assessDropReady,
  planDropMode,
  formatLaneAfterAction,
};
