/**
 * Persistable monitor admin state (keywords, proxies, toggles).
 * Survives process restart on /data; attach a Railway volume for redeploy survival.
 */
import fs from "node:fs";
import path from "node:path";
import { persistenceMeta, resolveStateFile } from "./data-dir.mjs";

function defaultStatePath() {
  if (process.env.MONITOR_STATE_PATH) return process.env.MONITOR_STATE_PATH;
  return resolveStateFile("vanta-monitor-state.json").path;
}

/**
 * @returns {{
 *   keywords: string,
 *   mutedSkus: string,
 *   presetCatalog: string,
 *   ispProxies: string,
 *   dcProxies: string,
 *   intervalMs: number,
 *   notifyOos: boolean,
 *   restockWebhook: string,
 *   checkoutFeedWebhook: string,
 *   updatedAt: string|null,
 * }}
 */
export function defaultConfigFromEnv() {
  return {
    keywords:
      process.env.BANDAI_MONITOR_KEYWORDS ||
      process.env.MONITOR_KEYWORDS ||
      "GUNDAM,ONE PIECE,N2890904001",
    /** Global mute — suppressed for all Desktop consumers (SSE + Discord). */
    mutedSkus: String(process.env.BANDAI_MONITOR_MUTED_SKUS || ""),
    /** Action Store SKUs for Desktop (admin-curated). */
    presetCatalog: String(process.env.BANDAI_PRESET_CATALOG || ""),
    ispProxies: String(process.env.BANDAI_MONITOR_ISP_PROXIES || ""),
    dcProxies: String(process.env.BANDAI_MONITOR_DC_PROXIES || ""),
    intervalMs: Number(process.env.BANDAI_MONITOR_INTERVAL_MS) || 5000,
    notifyOos: process.env.BANDAI_MONITOR_NOTIFY_OOS !== "0",
    /** Operator restock Discord — admin-editable; env DISCORD_WEBHOOK_URL is fallback. */
    restockWebhook: String(process.env.DISCORD_WEBHOOK_URL || ""),
    /** Public checkouts feed (no PII) — admin-editable; env DISCORD_CHECKOUT_FEED_WEBHOOK fallback. */
    checkoutFeedWebhook: String(process.env.DISCORD_CHECKOUT_FEED_WEBHOOK || ""),
    /** PKC (Pokémon Centre) poller — shares SSE feed with Bandai. Watches via admin only. */
    pcMonitorEnable: !/^(0|false|no|off)$/i.test(
      String(process.env.PC_MONITOR_ENABLE ?? "1").trim(),
    ),
    pcLocale: String(process.env.PC_MONITOR_LOCALE || "en-au").trim() || "en-au",
    // Bootstrap watchlist — `-binder` etc are negative excludes (not search terms).
    pcKeywords: String(
      process.env.PC_MONITOR_KEYWORDS || "TCG\n-binder\n-playmat\n-deck",
    ),
    pcSkus: String(process.env.PC_MONITOR_SKUS || ""),
    pcIntervalMs: Number(process.env.PC_MONITOR_INTERVAL_MS) || 15000,
    updatedAt: null,
  };
}

export function loadRuntimeConfig(filePath = defaultStatePath()) {
  const base = defaultConfigFromEnv();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(raw);
    const merged = {
      ...base,
      ...(typeof j === "object" && j ? j : {}),
      _path: filePath,
      _fromDisk: true,
    };
    // Disk empty-string for proxies must win over env bootstrap once saved.
    if (typeof j === "object" && j) {
      if (Object.prototype.hasOwnProperty.call(j, "ispProxies")) {
        merged.ispProxies = String(j.ispProxies || "");
      }
      if (Object.prototype.hasOwnProperty.call(j, "dcProxies")) {
        merged.dcProxies = String(j.dcProxies || "");
      }
    }
    return merged;
  } catch {
    return { ...base, _path: filePath, _fromDisk: false };
  }
}

export function saveRuntimeConfig(cfg, filePath = defaultStatePath()) {
  const out = {
    keywords: String(cfg.keywords || ""),
    mutedSkus: String(cfg.mutedSkus || ""),
    presetCatalog: String(cfg.presetCatalog || ""),
    ispProxies: String(cfg.ispProxies || ""),
    dcProxies: String(cfg.dcProxies || ""),
    intervalMs: Number(cfg.intervalMs) || 5000,
    notifyOos: cfg.notifyOos !== false,
    restockWebhook: String(cfg.restockWebhook || ""),
    checkoutFeedWebhook: String(cfg.checkoutFeedWebhook || ""),
    pcMonitorEnable: cfg.pcMonitorEnable !== false,
    pcLocale: String(cfg.pcLocale || "en-us"),
    pcKeywords: String(cfg.pcKeywords || ""),
    pcSkus: String(cfg.pcSkus || ""),
    pcIntervalMs: Number(cfg.pcIntervalMs) || 15000,
    updatedAt: new Date().toISOString(),
  };
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2));
  return { ...out, _path: filePath, _fromDisk: true };
}

export function runtimePersistenceInfo(filePath = defaultStatePath()) {
  return persistenceMeta(filePath);
}

export { defaultStatePath };
