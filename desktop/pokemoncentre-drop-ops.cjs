/**
 * Pokémon Centre AU desktop drop ops — schedule, readiness, Drop Mode, lane summaries.
 * Adapted from Bandai drop-ops (no vault login / cart-hold). Pure helpers for offline tests.
 */

const SYDNEY = "Australia/Sydney";

function pad2(n) {
  return String(n).padStart(2, "0");
}

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

function sydneyWallToUtcMs({ year, month, day, hour, minute, second = 0 }) {
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

function isPcStore(store) {
  const s = String(store || "").toLowerCase();
  return s === "pokemoncentre" || s === "pokemon" || s === "pokemoncenter";
}

function listPcDropTasks(tasks = []) {
  return (tasks || []).filter((t) => {
    if (!t || t.enabled === false) return false;
    if (!isPcStore(t.store)) return false;
    const mode = String(t.pcMode || t.pokemoncentreMode || "checkout").toLowerCase();
    return mode === "checkout" || mode === "autocheckout" || mode === "pay";
  });
}

function countDropLanes(tasks = []) {
  return listPcDropTasks(tasks).reduce(
    (sum, t) => sum + Math.max(1, Math.min(50, Number(t.quantity) || 1)),
    0,
  );
}

/**
 * Drop readiness checklist for the Tasks strip (PC — no vault accounts).
 */
function assessDropReady({
  engineRunning = false,
  harvest = null,
  tasks = [],
  proxyGroups = [],
  nowMs = Date.now(),
} = {}) {
  const dropTasks = listPcDropTasks(tasks);
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
    label: lanes > 0 ? `${lanes} PC lane(s)` : "No enabled PC Autocheckout tasks",
  });

  checks.push({
    id: "harvest",
    ok: lanes === 0 ? true : harvestReady >= lanes,
    label:
      lanes === 0
        ? `Harvest ${harvestReady}/${Number.isFinite(harvestDesired) ? harvestDesired : "–"}`
        : harvestReady >= lanes
          ? `Harvest ${harvestReady}/${lanes} ready`
          : `Harvest ${harvestReady}/${lanes} — arm Reese+DD bank`,
  });

  let proxyOk = false;
  if (harvestProxyGroupId) {
    const g = (proxyGroups || []).find((x) => x.id === harvestProxyGroupId);
    proxyOk = Boolean(g?.entries?.length);
  }
  if (!proxyOk) {
    proxyOk =
      dropTasks.length === 0 ||
      dropTasks.every((t) => {
        const g = (proxyGroups || []).find((x) => x.id === t.proxyGroupId);
        return Boolean(g?.entries?.length);
      });
  }
  checks.push({
    id: "proxies",
    ok: lanes === 0 ? true : proxyOk,
    label: proxyOk ? "Proxies sticky" : "Set sticky AU ISP proxy group",
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
    text: checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label}`).join(" · "),
    at: nowMs,
  };
}

function planDropMode({ tasks = [], harvest = null } = {}) {
  const dropTasks = listPcDropTasks(tasks);
  const lanes = countDropLanes(tasks);
  if (!lanes) {
    return { ok: false, error: "Enable at least one Pokémon Centre Autocheckout task", lanes: 0 };
  }
  const proxyGroupId =
    harvest?.config?.proxyGroupId ||
    dropTasks.find((t) => t.proxyGroupId)?.proxyGroupId ||
    null;
  if (!proxyGroupId) {
    return {
      ok: false,
      error: "Set sticky proxy group on Harvest → Pokémon Centre (or on each task)",
      lanes,
    };
  }
  return {
    ok: true,
    lanes,
    desired: Math.min(12, Math.max(1, lanes)),
    proxyGroupId,
    locale: dropTasks[0]?.pcLocale || harvest?.config?.locale || "en-au",
    solveCaptcha: harvest?.config?.solveCaptcha === true,
    taskIds: dropTasks.map((t) => t.id),
  };
}

function formatLaneAfterAction(result = {}) {
  const stage = result.checkoutStage || result.consumerCode || null;
  const fail = result.failedStep || null;
  const tx =
    result.transactionId ||
    result.geTransactionId ||
    (String(result.note || "").match(/tx[=:]?\s*(\d+)/i) || [])[1] ||
    null;
  const wall =
    result.elapsedMs != null ? `${Math.round(result.elapsedMs)}ms` : null;
  const bits = [];
  if (result.ok && result.orderNumber) bits.push(`order ${result.orderNumber}`);
  else if (stage) bits.push(String(stage));
  if (fail && !result.ok) bits.push(`fail:${fail}`);
  if (result.harvestUsed) bits.push("harvest");
  if (result.stickyRotates) bits.push(`rotate×${result.stickyRotates}`);
  if (tx) bits.push(`tx=${tx}`);
  if (wall) bits.push(wall);
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
  isPcStore,
  listPcDropTasks,
  countDropLanes,
  assessDropReady,
  planDropMode,
  formatLaneAfterAction,
};
