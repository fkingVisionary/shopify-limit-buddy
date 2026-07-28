/**
 * Persistable monitor admin state (keywords, proxies, toggles).
 * Survives process lifetime; on Railway without a volume, survives until redeploy.
 */
import fs from "node:fs";
import path from "node:path";

function defaultStatePath() {
  if (process.env.MONITOR_STATE_PATH) return process.env.MONITOR_STATE_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "vanta-monitor-state.json");
  }
  return "/tmp/vanta-monitor-state.json";
}

/**
 * @returns {{
 *   keywords: string,
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
    return {
      ...base,
      ...(typeof j === "object" && j ? j : {}),
      _path: filePath,
      _fromDisk: true,
    };
  } catch {
    return { ...base, _path: filePath, _fromDisk: false };
  }
}

export function saveRuntimeConfig(cfg, filePath = defaultStatePath()) {
  const out = {
    keywords: String(cfg.keywords || ""),
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

export { defaultStatePath };
