// Desktop → Railway Bandai global monitor SSE subscriber.
// Lifecycle: start with engine, stop with engine.
// Consumer product: inherit admin watchlist from public /health; SSE streams all hits.
// Local Monitor→Global tasks remain advanced checkout-on-hit only.
// Restock Discord is operator-only on Railway — never fan out to user webhooks.
// Feed reads are public on Railway (no MONITOR_TOKEN) — token is optional override.

const { EventEmitter } = require("node:events");
const {
  shouldCheckoutOnMonitorHit,
  taskForMonitorCheckout,
} = require("./bandai-monitor-checkout.cjs");

const DEFAULT_BANDAI_GLOBAL_MONITOR_URL =
  "https://j1ms-bandai-monitor-production.up.railway.app";

const ADMIN_WATCHLIST_REFRESH_MS = 60_000;

function normalizeMonitorBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function resolveMonitorBase(settings = {}) {
  return (
    normalizeMonitorBase(settings.bandaiGlobalMonitorUrl || settings.globalMonitorUrl) ||
    DEFAULT_BANDAI_GLOBAL_MONITOR_URL
  );
}

/** Parse Railway /health → admin watchlist fields for Desktop snapshot. */
function parseAdminWatchlistFromHealth(body = {}) {
  const keywords = Array.isArray(body?.keywords)
    ? body.keywords.map((k) => String(k || "").trim()).filter(Boolean)
    : [];
  return {
    adminKeywords: keywords,
    adminWatchCount: keywords.length,
    adminArea: body?.area != null ? String(body.area) : null,
  };
}

/**
 * Consumer status line — no host URL / admin wording.
 * @param {{ connected?: boolean, running?: boolean, hits?: number, adminWatchCount?: number|null, watchTasks?: number, lastError?: string|null, engineRunning?: boolean }} opts
 */
function formatMonitorFeedStatusLine(opts = {}) {
  const bits = [];
  if (opts.connected) bits.push("connected");
  else if (opts.running) bits.push("reconnecting…");
  else bits.push(opts.engineRunning ? "not connected" : "engine offline");
  // Never surface monitor host / admin internals to the UI.
  bits.push(`${opts.hits ?? 0} hits`);
  if (opts.adminWatchCount != null && Number.isFinite(Number(opts.adminWatchCount))) {
    bits.push(`${Number(opts.adminWatchCount)} watched`);
  }
  const local = Number(opts.watchTasks) || 0;
  if (local > 0) bits.push(`${local} local monitor(s)`);
  if (opts.lastError) bits.push(`err: ${opts.lastError}`);
  return `Monitor — ${bits.join(" · ")}`;
}

function parseWatch(task = {}) {
  const productIds = new Set();
  const keywords = [];
  const sku = String(task.bandaiWatchSku || task.productId || task.input || "").trim();
  if (sku) {
    const m = sku.match(/\b(N\d{7,}[A-Z0-9]*|A\d{7,}[A-Z0-9]*|NAI[A-Z0-9]+)\b/i);
    if (m) productIds.add(m[1].toUpperCase());
    else productIds.add(sku.toUpperCase());
  }
  const pdp = String(task.pdpUrl || task.storeUrl || "");
  const pm = pdp.match(/\/item\/([A-Za-z0-9]+)/i);
  if (pm) productIds.add(pm[1].toUpperCase());
  const kwRaw = task.bandaiWatchKeywords || task.keywords || "";
  for (const part of String(kwRaw).split(/[,|\n]/)) {
    const t = part.trim();
    if (t) keywords.push(t.toLowerCase());
  }
  return { productIds: [...productIds], keywords };
}

function eventMatchesWatch(ev, watch) {
  if (!ev?.inStock && ev?.inStock !== undefined) return false;
  const pid = String(ev?.productId || "").toUpperCase();
  if (watch.productIds?.length && pid && watch.productIds.includes(pid)) return true;
  const blob = `${ev?.title || ""} ${ev?.productId || ""}`.toLowerCase();
  return (watch.keywords || []).some((k) => k && blob.includes(k));
}

/**
 * Advanced: Bandai Monitor→Global tasks that auto-checkout on SSE match.
 * Not required for consumer feed subscription.
 */
function listGlobalWatchTasks(tasks = []) {
  return (Array.isArray(tasks) ? tasks : []).filter((t) => {
    if (!t || t.enabled === false) return false;
    if (String(t.store || "") !== "bandai") return false;
    if (String(t.bandaiMode || "").toLowerCase() !== "monitor") return false;
    const mode = String(t.bandaiMonitorMode || "global").toLowerCase();
    if (mode !== "global") return false;
    const watch = parseWatch(t);
    return watch.productIds.length > 0 || watch.keywords.length > 0;
  });
}

const FEED_MAX = 120;

function feedDedupeKey(hit) {
  const pid = String(hit?.productId || hit?.sku || "").toUpperCase();
  const at = String(hit?.at || hit?.receivedAt || "");
  const reason = String(hit?.reason || "");
  return `${pid}|${at}|${reason}`;
}

function normalizeFeedRow(hit) {
  if (!hit || !(hit.productId || hit.sku)) return null;
  const receivedAt =
    Number(hit.receivedAt) ||
    (hit.at ? Date.parse(hit.at) || Date.now() : Date.now());
  return {
    ...hit,
    productId: hit.productId || hit.sku,
    at: hit.at || new Date(receivedAt).toISOString(),
    receivedAt,
    store: hit.store || "bandai",
  };
}

function createBandaiGlobalMonitorClient({
  emitLog,
  getSettings,
  getTasks,
  onCheckoutTask,
  onFeedHit,
  onFeedChanged,
  fetchImpl,
  feedMax = FEED_MAX,
  initialFeed = [],
  adminWatchlistRefreshMs = ADMIN_WATCHLIST_REFRESH_MS,
} = {}) {
  const bus = new EventEmitter();
  const fetchFn = fetchImpl || globalThis.fetch?.bind(globalThis);
  let running = false;
  let abort = null;
  let reconnectTimer = null;
  let healthTimer = null;
  let lastError = null;
  let connected = false;
  let hits = 0;
  let startedAt = null;
  /** @type {string[]} */
  let adminKeywords = [];
  /** @type {number|null} */
  let adminWatchCount = null;
  /** @type {string|null} */
  let adminArea = null;
  /** @type {object[]} newest-first ring buffer for Monitor Feed UI */
  let feed = (Array.isArray(initialFeed) ? initialFeed : [])
    .map(normalizeFeedRow)
    .filter(Boolean)
    .slice(0, Math.max(20, feedMax));
  hits = feed.length;

  function settings() {
    return getSettings?.() || {};
  }

  function clearReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function clearHealthTimer() {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
  }

  function applyAdminWatchlist(parsed) {
    if (!parsed) return;
    adminKeywords = Array.isArray(parsed.adminKeywords) ? parsed.adminKeywords : [];
    adminWatchCount =
      parsed.adminWatchCount != null ? Number(parsed.adminWatchCount) : adminKeywords.length;
    adminArea = parsed.adminArea != null ? String(parsed.adminArea) : null;
  }

  async function refreshAdminWatchlist(base) {
    if (!fetchFn || !base) return false;
    try {
      const res = await fetchFn(`${base}/health`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return false;
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== "object") return false;
      applyAdminWatchlist(parseAdminWatchlistFromHealth(body));
      bus.emit("adminWatchlist", snapshot());
      return true;
    } catch {
      return false;
    }
  }

  function startHealthRefresh(base) {
    clearHealthTimer();
    void refreshAdminWatchlist(base);
    const ms = Math.max(15_000, Number(adminWatchlistRefreshMs) || ADMIN_WATCHLIST_REFRESH_MS);
    healthTimer = setInterval(() => {
      if (!running || !connected) return;
      void refreshAdminWatchlist(base);
    }, ms);
    if (typeof healthTimer.unref === "function") healthTimer.unref();
  }

  function notifyFeedChanged() {
    try {
      onFeedChanged?.(feed.slice());
    } catch {
      /* persist bridge must not break feed path */
    }
  }

  function pushFeed(hit, { live = true } = {}) {
    const row = normalizeFeedRow({
      ...hit,
      receivedAt: live ? Date.now() : hit?.receivedAt || Date.now(),
    });
    if (!row) return null;
    const key = feedDedupeKey(row);
    feed = [row, ...feed.filter((h) => feedDedupeKey(h) !== key)].slice(
      0,
      Math.max(20, feedMax),
    );
    bus.emit("feed", row);
    notifyFeedChanged();
    if (live) {
      try {
        onFeedHit?.(row);
      } catch {
        /* UI bridge must not break checkout path */
      }
    }
    return row;
  }

  /**
   * Merge Railway /hits history into the local feed for display only.
   * Does not fire Smart Actions / watchdog / checkout (those already ran or were missed).
   */
  function mergeRemoteHits(remoteHits) {
    const list = Array.isArray(remoteHits) ? remoteHits : [];
    if (!list.length) return { merged: 0, feed: getFeed() };
    const seen = new Set(feed.map(feedDedupeKey));
    let merged = 0;
    const incoming = [];
    for (const raw of list) {
      const row = normalizeFeedRow(raw);
      if (!row) continue;
      const key = feedDedupeKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      incoming.push(row);
      merged += 1;
    }
    if (!merged) return { merged: 0, feed: getFeed() };
    feed = [...incoming, ...feed]
      .sort((a, b) => Number(b.receivedAt || 0) - Number(a.receivedAt || 0))
      .slice(0, Math.max(20, feedMax));
    hits = Math.max(hits, feed.length);
    notifyFeedChanged();
    bus.emit("feedSync", feed.slice());
    return { merged, feed: getFeed() };
  }

  async function catchUpFromHits(base, token) {
    if (!fetchFn || !base) return { merged: 0 };
    try {
      const res = await fetchFn(`${base}/hits?limit=${Math.min(80, feedMax)}`, {
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) return { merged: 0 };
      const body = await res.json().catch(() => null);
      const remote = Array.isArray(body?.hits) ? body.hits : [];
      return mergeRemoteHits(remote);
    } catch {
      return { merged: 0 };
    }
  }

  async function handleHit(hit) {
    if (!hit?.productId) return;
    hits += 1;
    const row = pushFeed(hit, { live: true });
    if (!row) return;
    bus.emit("hit", row);
    emitLog?.(`Restock · ${row.productId}${row.reason ? ` (${row.reason})` : ""}`);

    // Advanced local Monitor→Global checkout-on-hit (optional).
    const tasks = listGlobalWatchTasks(getTasks?.() || []);
    for (const task of tasks) {
      const watch = parseWatch(task);
      if (!eventMatchesWatch(row, watch)) continue;
      emitLog?.(`Watch match → ${task.label || task.id} (${row.productId})`);
      if (!shouldCheckoutOnMonitorHit(task, task.placeOrder !== false)) continue;
      const switched = taskForMonitorCheckout(task, row, task.bandaiArea || "au");
      if (!switched.ok) {
        emitLog?.(`Checkout handoff failed: ${switched.error}`);
        continue;
      }
      try {
        await onCheckoutTask?.(switched.task, row);
      } catch (e) {
        emitLog?.(`Checkout enqueue failed: ${e?.message || e}`);
      }
    }
  }

  async function readSseStream(res) {
    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = await res.text();
      for (const block of String(text).split("\n\n")) {
        parseSseBlock(block);
      }
      return;
    }
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        parseSseBlock(block);
      }
    }
  }

  function parseSseBlock(block) {
    const lines = String(block || "").split(/\r?\n/);
    let event = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (event === "stock_changed" || data.productId) {
      const hit = {
        ...data,
        inStock: data.inStock !== false,
        productId: data.productId,
      };
      void handleHit(hit);
    }
  }

  async function loop() {
    while (running) {
      const s = settings();
      const base = resolveMonitorBase(s);
      const token = String(s.bandaiGlobalMonitorToken || s.monitorToken || "").trim();
      if (!base) {
        lastError = "missing_monitor_url";
        connected = false;
        await sleep(5000);
        continue;
      }
      if (!fetchFn) {
        lastError = "fetch_unavailable";
        await sleep(5000);
        continue;
      }
      abort = new AbortController();
      try {
        const res = await fetchFn(`${base}/events`, {
          headers: {
            accept: "text/event-stream",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          signal: abort.signal,
        });
        if (!res.ok) {
          lastError = `http_${res.status}`;
          connected = false;
          clearHealthTimer();
          emitLog?.(`Monitor reconnecting (${res.status})`);
          await sleep(4000);
          continue;
        }
        connected = true;
        lastError = null;
        emitLog?.("Monitor connected");
        startHealthRefresh(base);
        // Pull buffered Railway hits so a restart mid-restock still fills the feed.
        try {
          const catchUp = await catchUpFromHits(base, token);
          if (catchUp.merged > 0) {
            emitLog?.(`Monitor catch-up · ${catchUp.merged} recent hit(s)`);
            bus.emit("feedSync", catchUp.feed);
          }
        } catch {
          /* catch-up is best-effort */
        }
        await readSseStream(res);
        connected = false;
        clearHealthTimer();
        if (running) emitLog?.("Monitor reconnecting");
      } catch (e) {
        connected = false;
        clearHealthTimer();
        if (abort?.signal?.aborted) break;
        lastError = e?.message || String(e);
        // Never surface host URLs in consumer logs.
        const safe =
          /https?:\/\/\S+/i.test(lastError) || /railway\.app/i.test(lastError)
            ? "connection error"
            : lastError;
        emitLog?.(`Monitor error: ${safe}`);
        await sleep(4000);
      }
    }
    connected = false;
    clearHealthTimer();
  }

  function start() {
    const s = settings();
    if (s.bandaiGlobalMonitorEnabled === false) {
      return { ok: false, skipped: true, reason: "disabled" };
    }
    const base = resolveMonitorBase(s);
    if (!base) return { ok: false, skipped: true, reason: "missing_url" };
    if (running) return { ok: true, already: true };
    running = true;
    startedAt = Date.now();
    void loop();
    return { ok: true, url: base };
  }

  function stop() {
    running = false;
    clearReconnect();
    clearHealthTimer();
    try {
      abort?.abort();
    } catch {
      /* ignore */
    }
    abort = null;
    connected = false;
    return snapshot();
  }

  function snapshot() {
    const s = settings();
    return {
      running,
      connected,
      hits,
      lastError,
      startedAt,
      url: resolveMonitorBase(s) || null,
      adminKeywords: adminKeywords.slice(),
      adminWatchCount,
      adminArea,
      /** Advanced local Monitor→Global count (not consumer readiness). */
      watchTasks: listGlobalWatchTasks(getTasks?.() || []).length,
      feed: feed.slice(0, 80),
    };
  }

  function getFeed() {
    return feed.slice();
  }

  function clearFeed() {
    feed = [];
    hits = 0;
    notifyFeedChanged();
    return getFeed();
  }

  function hydrateFeed(rows) {
    feed = (Array.isArray(rows) ? rows : [])
      .map(normalizeFeedRow)
      .filter(Boolean)
      .slice(0, Math.max(20, feedMax));
    hits = Math.max(hits, feed.length);
    return getFeed();
  }

  /** Test helper */
  async function _injectHit(hit) {
    await handleHit(hit);
  }

  /** Test helper — apply /health JSON without network */
  function _setAdminWatchlistFromHealth(body) {
    applyAdminWatchlist(parseAdminWatchlistFromHealth(body));
  }

  return {
    start,
    stop,
    snapshot,
    getFeed,
    clearFeed,
    hydrateFeed,
    mergeRemoteHits,
    catchUpFromHits: () => {
      const s = settings();
      return catchUpFromHits(
        resolveMonitorBase(s),
        String(s.bandaiGlobalMonitorToken || s.monitorToken || "").trim(),
      );
    },
    refreshAdminWatchlist: () => refreshAdminWatchlist(resolveMonitorBase(settings())),
    on: bus.on.bind(bus),
    off: bus.off.bind(bus),
    listGlobalWatchTasks,
    parseWatch,
    eventMatchesWatch,
    _injectHit,
    _setAdminWatchlistFromHealth,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  createBandaiGlobalMonitorClient,
  listGlobalWatchTasks,
  parseWatch,
  eventMatchesWatch,
  normalizeMonitorBase,
  resolveMonitorBase,
  parseAdminWatchlistFromHealth,
  formatMonitorFeedStatusLine,
  DEFAULT_BANDAI_GLOBAL_MONITOR_URL,
  ADMIN_WATCHLIST_REFRESH_MS,
};
