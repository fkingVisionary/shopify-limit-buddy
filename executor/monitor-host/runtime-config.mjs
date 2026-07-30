/**
 * Persistable monitor admin state (keywords, proxies, toggles, Discord webhooks).
 * Survives process restart on /data; attach a Railway volume for redeploy survival.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { persistenceMeta, resolveStateFile } from "./data-dir.mjs";

function defaultStatePath() {
  if (process.env.MONITOR_STATE_PATH) return process.env.MONITOR_STATE_PATH;
  return resolveStateFile("vanta-monitor-state.json").path;
}

const DISCORD_WEBHOOK_RE =
  /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+\/?$/i;

export function isDiscordWebhookUrl(url) {
  return DISCORD_WEBHOOK_RE.test(String(url || "").trim());
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, url: string, label: string, addedAt: string|null }[]}
 */
export function normalizeDiscordWebhooks(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/\r?\n/).map((u) => ({ url: u }))
      : [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    const url = String(row?.url || row || "").trim().replace(/\/+$/, "");
    if (!isDiscordWebhookUrl(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: String(row?.id || `wh_${crypto.createHash("sha1").update(key).digest("hex").slice(0, 10)}`),
      url,
      label: String(row?.label || "").trim().slice(0, 80),
      addedAt: row?.addedAt || null,
    });
  }
  return out.slice(0, 20);
}

/** Env bootstrap webhook (single) — used when disk list is empty / first boot. */
export function envDiscordWebhookBootstrap() {
  const url = String(process.env.DISCORD_WEBHOOK_URL || "").trim().replace(/\/+$/, "");
  if (!isDiscordWebhookUrl(url)) return [];
  return normalizeDiscordWebhooks([
    { url, label: "env", addedAt: null, id: "wh_env" },
  ]);
}

/**
 * @returns {{
 *   keywords: string,
 *   presetCatalog: string,
 *   ispProxies: string,
 *   dcProxies: string,
 *   intervalMs: number,
 *   notifyOos: boolean,
 *   discordWebhooks: ReturnType<typeof normalizeDiscordWebhooks>,
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
    discordWebhooks: envDiscordWebhookBootstrap(),
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
      if (Object.prototype.hasOwnProperty.call(j, "discordWebhooks")) {
        merged.discordWebhooks = normalizeDiscordWebhooks(j.discordWebhooks);
      } else {
        // Soft upgrade: keep env bootstrap until admin saves a webhook list.
        merged.discordWebhooks = normalizeDiscordWebhooks([
          ...envDiscordWebhookBootstrap(),
          ...(Array.isArray(j.discordWebhooks) ? j.discordWebhooks : []),
        ]);
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
    discordWebhooks: normalizeDiscordWebhooks(cfg.discordWebhooks),
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
