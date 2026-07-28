// Desktop → Railway Bandai global monitor SSE subscriber.
// Lifecycle: start with engine, stop with engine. Matches local watch tasks.
// Restock Discord is operator-only on Railway — never fan out to user webhooks.

const { EventEmitter } = require("node:events");
const {
  shouldCheckoutOnMonitorHit,
  taskForMonitorCheckout,
} = require("./bandai-monitor-checkout.cjs");

function normalizeMonitorBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
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
 * Bandai monitor tasks that should listen to the shared Railway feed.
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

function createBandaiGlobalMonitorClient({
  emitLog,
  getSettings,
  getTasks,
  onCheckoutTask,
  onFeedHit,
  fetchImpl,
  feedMax = FEED_MAX,
} = {}) {
  const bus = new EventEmitter();
  const fetchFn = fetchImpl || globalThis.fetch?.bind(globalThis);
  let running = false;
  let abort = null;
  let reconnectTimer = null;
  let lastError = null;
  let connected = false;
  let hits = 0;
  let startedAt = null;
  /** @type {object[]} newest-first ring buffer for Monitor Feed UI */
  let feed = [];

  function settings() {
    return getSettings?.() || {};
  }

  function clearReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function pushFeed(hit) {
    const row = {
      ...hit,
      at: hit?.at || new Date().toISOString(),
      receivedAt: Date.now(),
      store: hit?.store || "bandai",
    };
    feed = [row, ...feed].slice(0, Math.max(20, feedMax));
    bus.emit("feed", row);
    try {
      onFeedHit?.(row);
    } catch {
      /* UI bridge must not break checkout path */
    }
    return row;
  }

  async function handleHit(hit) {
    if (!hit?.productId) return;
    hits += 1;
    const row = pushFeed(hit);
    bus.emit("hit", row);
    emitLog?.(`Global monitor hit ${row.productId} (${row.reason || "restock"})`);

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
      const base = normalizeMonitorBase(s.bandaiGlobalMonitorUrl || s.globalMonitorUrl);
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
          emitLog?.(`Global monitor SSE ${res.status} — retrying`);
          await sleep(4000);
          continue;
        }
        connected = true;
        lastError = null;
        emitLog?.(`Global monitor subscribed (${base})`);
        await readSseStream(res);
        connected = false;
        if (running) emitLog?.("Global monitor SSE ended — reconnecting");
      } catch (e) {
        connected = false;
        if (abort?.signal?.aborted) break;
        lastError = e?.message || String(e);
        emitLog?.(`Global monitor SSE error: ${lastError}`);
        await sleep(4000);
      }
    }
    connected = false;
  }

  function start() {
    const s = settings();
    if (s.bandaiGlobalMonitorEnabled === false) {
      return { ok: false, skipped: true, reason: "disabled" };
    }
    const base = normalizeMonitorBase(s.bandaiGlobalMonitorUrl || s.globalMonitorUrl);
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
      url: normalizeMonitorBase(s.bandaiGlobalMonitorUrl || s.globalMonitorUrl) || null,
      watchTasks: listGlobalWatchTasks(getTasks?.() || []).length,
      feed: feed.slice(0, 80),
    };
  }

  function getFeed() {
    return feed.slice();
  }

  function clearFeed() {
    feed = [];
    return getFeed();
  }

  /** Test helper */
  async function _injectHit(hit) {
    await handleHit(hit);
  }

  return {
    start,
    stop,
    snapshot,
    getFeed,
    clearFeed,
    on: bus.on.bind(bus),
    off: bus.off.bind(bus),
    listGlobalWatchTasks,
    parseWatch,
    eventMatchesWatch,
    _injectHit,
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
};
