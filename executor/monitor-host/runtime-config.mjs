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
 *   presetCatalog: string,
 *   ispProxies: string,
 *   dcProxies: string,
 *   intervalMs: number,
 *   notifyOos: boolean,
 *   updatedAt: string|null,
 * }}
 */
export function defaultConfigFromEnv() {
  return {
    keywords:
      process.env.BANDAI_MONITOR_KEYWORDS ||
      process.env.MONITOR_KEYWORDS ||
      "GUNDAM,ONE PIECE,N2890904001",
    /** Action Store SKUs for Desktop (admin-curated). */
    presetCatalog: String(process.env.BANDAI_PRESET_CATALOG || ""),
    ispProxies: String(process.env.BANDAI_MONITOR_ISP_PROXIES || ""),
    dcProxies: String(process.env.BANDAI_MONITOR_DC_PROXIES || ""),
    intervalMs: Number(process.env.BANDAI_MONITOR_INTERVAL_MS) || 5000,
    notifyOos: process.env.BANDAI_MONITOR_NOTIFY_OOS !== "0",
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
    presetCatalog: String(cfg.presetCatalog || ""),
    ispProxies: String(cfg.ispProxies || ""),
    dcProxies: String(cfg.dcProxies || ""),
    intervalMs: Number(cfg.intervalMs) || 5000,
    notifyOos: cfg.notifyOos !== false,
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
