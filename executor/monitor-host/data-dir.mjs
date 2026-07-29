/**
 * Shared durable data directory for monitor admin state.
 *
 * Admin ISP/DC proxies, keywords, presets, product cache, and bot vault all
 * land here. Prefer an explicit path / Railway volume; otherwise use /data
 * (container layer — survives process restart). /tmp is last resort (ephemeral).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATE_DIRS = ["/data", "/mnt/data", "/var/data"];

function dirWritable(dir, { create = true } = {}) {
  try {
    if (!fs.existsSync(dir)) {
      if (!create) return false;
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    // Prove writes work (some mounts exist but are read-only).
    const probe = path.join(dir, `.vanta-write-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{
 *   dir: string,
 *   source: "env" | "volume" | "container" | "tmp",
 *   durable: "volume" | "container" | "ephemeral",
 * }}
 */
export function resolveDataDir() {
  const envDir = String(process.env.MONITOR_DATA_DIR || "").trim();
  if (envDir) {
    if (dirWritable(envDir)) {
      // Explicit MONITOR_DATA_DIR is treated as operator-managed durable storage.
      const durable = isEphemeralPath(envDir) ? "ephemeral" : "volume";
      return { dir: envDir, source: "env", durable };
    }
  }

  const vol = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  if (vol && dirWritable(vol)) {
    return { dir: vol, source: "volume", durable: "volume" };
  }

  // If MONITOR_STATE_PATH is set, keep siblings next to that file.
  const statePath = String(process.env.MONITOR_STATE_PATH || "").trim();
  if (statePath) {
    const parent = path.dirname(statePath);
    if (dirWritable(parent)) {
      return {
        dir: parent,
        source: "env",
        durable: isEphemeralPath(parent) ? "ephemeral" : "volume",
      };
    }
  }

  for (const dir of CANDIDATE_DIRS) {
    // Auto-create /data only on linux containers — avoid mkdir C:\data on Windows.
    const create = dir === "/data" && process.platform !== "win32";
    if (dirWritable(dir, { create })) {
      return { dir, source: "container", durable: "container" };
    }
  }

  for (const tmp of ["/tmp", os.tmpdir()].filter(Boolean)) {
    if (dirWritable(tmp)) {
      return { dir: tmp, source: "tmp", durable: "ephemeral" };
    }
  }
  // Last gasp — still report ephemeral even if mkdir failed.
  return { dir: os.tmpdir() || "/tmp", source: "tmp", durable: "ephemeral" };
}

export function isEphemeralPath(p) {
  const n = String(p || "").replace(/\\/g, "/").toLowerCase();
  if (n === "/tmp" || n.startsWith("/tmp/")) return true;
  try {
    const tmp = String(os.tmpdir() || "")
      .replace(/\\/g, "/")
      .toLowerCase();
    if (tmp && (n === tmp || n.startsWith(`${tmp}/`))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Resolve a named state file under the data dir.
 * Migrates a leftover /tmp copy when the durable path is empty (soft upgrades).
 */
export function resolveStateFile(fileName, { migrateFromTmp = true } = {}) {
  const info = resolveDataDir();
  const dest = path.join(info.dir, fileName);
  if (migrateFromTmp && info.dir !== "/tmp" && !fs.existsSync(dest)) {
    const legacy = path.join("/tmp", fileName);
    try {
      if (fs.existsSync(legacy)) {
        fs.copyFileSync(legacy, dest);
      }
    } catch {
      /* ignore migrate failures */
    }
  }
  return { ...info, path: dest };
}

export function persistenceMeta(filePath) {
  const info = resolveDataDir();
  const p = filePath || info.dir;
  const durable = isEphemeralPath(p) ? "ephemeral" : info.durable;
  return {
    statePath: filePath || null,
    dataDir: info.dir,
    source: info.source,
    durable,
    ephemeral: durable === "ephemeral",
    survivesRestart: durable !== "ephemeral",
    survivesRedeploy: durable === "volume",
  };
}
