// Shared MonitorEvent helpers (desktop + monitor service).
const crypto = require("crypto");

/**
 * @typedef {{
 *   id: string;
 *   store: "kmart";
 *   type: "new" | "restock";
 *   title: string;
 *   url: string;
 *   sku: string;
 *   inStock: boolean;
 *   price?: number;
 *   currency?: "AUD";
 *   sizes?: string[];
 *   imageUrl?: string;
 *   detectedAt: string;
 *   source: "sku_poll" | "discovery";
 * }} MonitorEvent
 */

/**
 * @param {Partial<MonitorEvent> & { title: string; url: string; sku: string }} partial
 * @returns {MonitorEvent}
 */
function makeMonitorEvent(partial) {
  const type = partial.type === "new" ? "new" : "restock";
  const sku = String(partial.sku || "").trim();
  const detectedAt = partial.detectedAt || new Date().toISOString();
  const id =
    partial.id ||
    `${type}:${sku || "unknown"}:${detectedAt.slice(0, 19)}:${crypto.randomBytes(3).toString("hex")}`;

  /** @type {MonitorEvent} */
  const evt = {
    id,
    store: "kmart",
    type,
    title: String(partial.title || "").trim(),
    url: String(partial.url || "").trim(),
    sku,
    inStock: partial.inStock !== false,
    detectedAt,
    source: partial.source === "discovery" ? "discovery" : "sku_poll",
  };
  if (partial.price != null && Number.isFinite(Number(partial.price))) {
    evt.price = Number(partial.price);
    evt.currency = "AUD";
  }
  if (Array.isArray(partial.sizes) && partial.sizes.length) {
    evt.sizes = partial.sizes.map(String);
  }
  if (partial.imageUrl) evt.imageUrl = String(partial.imageUrl);
  return evt;
}

/**
 * Short-window dedupe key for client/server.
 * @param {MonitorEvent} evt
 * @param {number} [windowMs]
 */
function eventDedupeKey(evt, windowMs = 30_000) {
  const t = Date.parse(evt.detectedAt || "") || Date.now();
  const bucket = Math.floor(t / windowMs);
  return `${evt.sku || evt.url}|${evt.type}|${bucket}`;
}

class EventDedupe {
  constructor(windowMs = 30_000, maxSize = 5000) {
    this.windowMs = windowMs;
    this.maxSize = maxSize;
    /** @type {Map<string, number>} */
    this.seen = new Map();
  }

  /** @param {MonitorEvent} evt */
  accept(evt) {
    const key = evt.id || eventDedupeKey(evt, this.windowMs);
    const now = Date.now();
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    if (this.seen.size > this.maxSize) {
      const cutoff = now - this.windowMs * 2;
      for (const [k, ts] of this.seen) {
        if (ts < cutoff) this.seen.delete(k);
      }
    }
    return true;
  }
}

module.exports = {
  makeMonitorEvent,
  eventDedupeKey,
  EventDedupe,
};
