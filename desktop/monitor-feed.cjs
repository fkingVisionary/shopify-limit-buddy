// Global monitor SSE client — one connection shared by Monitor tab + task matcher.

const { EventDedupe } = require("./monitor-events.cjs");

let emit = () => {};
/** @type {((evt: object) => void) | null} */
let onEvent = null;

/** @type {AbortController | null} */
let ac = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
let status = "offline"; // offline | connecting | live | reconnecting
let feedUrl = "";
let apiKey = "";
let eventRateWindow = [];
const dedupe = new EventDedupe(30_000);
/** @type {object[]} */
const recent = [];
const MAX_RECENT = 200;

function setEmitter(fn) {
  emit = typeof fn === "function" ? fn : () => {};
}

function setEventHandler(fn) {
  onEvent = typeof fn === "function" ? fn : null;
}

function getStatus() {
  return {
    status,
    feedUrl,
    recent: recent.slice(0, 80),
    eventsPerMin: eventRateWindow.filter((t) => Date.now() - t < 60_000).length,
  };
}

function pushRecent(evt) {
  recent.unshift(evt);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  eventRateWindow.push(Date.now());
  if (eventRateWindow.length > 500) {
    eventRateWindow = eventRateWindow.filter((t) => Date.now() - t < 60_000);
  }
}

function configure({ monitorFeedUrl, apiKey: key } = {}) {
  feedUrl = String(monitorFeedUrl || "").trim();
  apiKey = String(key || "").trim();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  status = "reconnecting";
  emit({ type: "monitor-feed", phase: "status", status, ...getStatus() });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

async function connect() {
  if (!feedUrl) {
    status = "offline";
    emit({ type: "monitor-feed", phase: "status", status, message: "No feed URL", ...getStatus() });
    return { ok: false, error: "monitorFeedUrl not set" };
  }

  stop(false);

  ac = new AbortController();
  status = status === "reconnecting" ? "reconnecting" : "connecting";
  emit({ type: "monitor-feed", phase: "status", status, ...getStatus() });

  const url = feedUrl.includes("?")
    ? `${feedUrl}&access_token=${encodeURIComponent(apiKey)}`
    : `${feedUrl}?access_token=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/event-stream",
        Authorization: apiKey ? `Bearer ${apiKey}` : "",
      },
      signal: ac.signal,
    });

    if (!res.ok || !res.body) {
      status = "reconnecting";
      emit({
        type: "monitor-feed",
        phase: "status",
        status,
        message: `Feed HTTP ${res.status}`,
        ...getStatus(),
      });
      scheduleReconnect();
      return { ok: false, error: `HTTP ${res.status}` };
    }

    status = "live";
    emit({ type: "monitor-feed", phase: "status", status, ...getStatus() });
    seedDemoEventsIfNeeded();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!ac.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const block of parts) {
        handleSseBlock(block);
      }
    }

    if (!ac.signal.aborted) scheduleReconnect();
    return { ok: true };
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, error: "aborted" };
    status = "reconnecting";
    emit({
      type: "monitor-feed",
      phase: "status",
      status,
      message: e?.message || String(e),
      ...getStatus(),
    });
    scheduleReconnect();
    return { ok: false, error: e?.message || String(e) };
  }
}

function handleSseBlock(block) {
  let eventName = "message";
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;
  const raw = dataLines.join("\n");
  if (eventName === "ping" || raw === "ping") return;

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return;
  }
  if (!evt || typeof evt !== "object") return;
  if (!dedupe.accept(evt)) return;

  pushRecent(evt);
  emit({ type: "monitor-feed", phase: "event", event: evt, ...getStatus() });
  if (onEvent) onEvent(evt);
}

/** Local UI showcase cards when MONITOR_FEED_DEMO=1 and feed has no real events yet. */
function seedDemoEventsIfNeeded() {
  if (process.env.MONITOR_FEED_DEMO !== "1") return;
  if (recent.length) return;
  const now = Date.now();
  const demos = [
    {
      id: "demo-restock-1",
      store: "kmart",
      type: "restock",
      title: "Pokemon TCG Scarlet & Violet Elite Trainer Box",
      url: "https://www.kmart.com.au/product/pokemon-etb-43671588/",
      sku: "43671588",
      inStock: true,
      price: 89.0,
      currency: "AUD",
      sizes: ["ETB", "Scarlet & Violet"],
      detectedAt: new Date(now - 1200).toISOString(),
      source: "sku_poll",
    },
    {
      id: "demo-new-1",
      store: "kmart",
      type: "new",
      title: "Pokemon Trading Card Game Booster Bundle",
      url: "https://www.kmart.com.au/product/pokemon-booster-43552146/",
      sku: "43552146",
      inStock: true,
      price: 49.0,
      currency: "AUD",
      sizes: ["Booster Bundle", "24 packs"],
      detectedAt: new Date(now - 4200).toISOString(),
      source: "discovery",
    },
  ];
  for (const evt of demos) {
    pushRecent(evt);
    emit({ type: "monitor-feed", phase: "event", event: evt, ...getStatus() });
  }
}

function stop(emitOffline = true) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ac) {
    ac.abort();
    ac = null;
  }
  if (emitOffline) {
    status = "offline";
    emit({ type: "monitor-feed", phase: "status", status, ...getStatus() });
  }
}

function start() {
  return connect();
}

module.exports = {
  setEmitter,
  setEventHandler,
  configure,
  connect,
  start,
  stop,
  getStatus,
};
