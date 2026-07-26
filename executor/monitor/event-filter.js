// Match stock_changed / catalog cards to a task watch filter.
// Task keywords NEVER expand the global poll — they only filter captured events.

/**
 * @param {object} task
 * @returns {{ productIds: string[], keywords: string[] }}
 */
export function parseTaskWatch(task = {}) {
  const productIds = new Set();
  const keywords = [];

  const skuRaw = String(
    task.productId ||
      task.productCode ||
      task.sku ||
      task.watchSku ||
      task.bandaiWatchSku ||
      task.disneyWatchSku ||
      "",
  ).trim();
  if (skuRaw) {
    for (const part of skuRaw.split(/[\s,|]+/)) {
      const p = part.trim();
      if (p) productIds.add(p.toUpperCase());
    }
  }

  // PDP URL → product code segment when it looks like /item/CODE (Bandai)
  const url = String(task.pdpUrl || task.input || "").trim();
  const m = url.match(/\/item\/([A-Za-z0-9_-]+)/i);
  if (m?.[1]) productIds.add(m[1].toUpperCase());

  // Disney Store AU PDP → trailing pid before .html
  const disneyPid = url.match(/-(\d{6,})\.html(?:[?#]|$)/i);
  if (disneyPid?.[1]) productIds.add(disneyPid[1].toUpperCase());

  // Bare product code in input (Bandai N… / A… style or Disney numeric pid)
  if (url && !/^https?:\/\//i.test(url) && /^[A-Za-z0-9_-]+$/.test(url)) {
    productIds.add(url.toUpperCase());
  }

  const kwRaw = String(
    task.keywords ||
      task.watchKeywords ||
      task.bandaiWatchKeywords ||
      task.disneyWatchKeywords ||
      task.keyword ||
      "",
  ).trim();
  if (kwRaw) {
    for (const part of kwRaw.split(/[,|]/)) {
      const k = part.trim().toLowerCase();
      if (k) keywords.push(k);
    }
  }

  return { productIds: [...productIds], keywords };
}

/**
 * @param {object} ev — stock_changed payload or catalog row
 * @param {{ productIds?: string[], keywords?: string[] }} watch
 */
export function eventMatchesWatch(ev, watch) {
  if (!ev || !watch) return false;
  const productId = String(ev.productId || ev.productCode || "").trim();
  const title = String(ev.title || ev.productName || ev.name || "").trim();
  const hay = `${productId} ${title}`.toLowerCase();

  const ids = watch.productIds || [];
  if (ids.length) {
    const up = productId.toUpperCase();
    if (ids.some((id) => id === up || up.startsWith(id) || id.startsWith(up))) {
      return true;
    }
  }

  const kws = watch.keywords || [];
  if (kws.length) {
    if (kws.some((k) => k && hay.includes(k))) return true;
  }

  // Empty watch matches nothing (must opt in with sku or keywords).
  return false;
}

/**
 * True if this task should use the global hub vs local polling.
 * Store-agnostic: Bandai + Disney (and generic monitorMode).
 * @param {object} task
 */
export function resolveMonitorMode(task = {}) {
  const raw = String(
    task.disneyMonitorMode ||
      task.bandaiMonitorMode ||
      task.monitorMode ||
      task.monitorSource ||
      "",
  )
    .toLowerCase()
    .trim();
  if (raw === "global" || raw === "shared") return "global";
  if (raw === "local" || raw === "task" || raw === "sidecar") return "local";
  if (raw === "off" || raw === "none" || raw === "disabled") return "off";

  // Legacy: *Mode=monitor without explicit source → local (own proxies).
  const mode = String(task.disneyMode || task.bandaiMode || task.mode || "").toLowerCase();
  if (mode === "monitor") return "local";
  return "off";
}

/** @deprecated use resolveMonitorMode — kept for Bandai call sites / tests */
export function resolveBandaiMonitorMode(task = {}) {
  return resolveMonitorMode(task);
}

/** Alias for Disney call sites */
export function resolveDisneyMonitorMode(task = {}) {
  return resolveMonitorMode(task);
}
