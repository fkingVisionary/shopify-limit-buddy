// Spawn the repo's checkout executor locally (same idea as desktop sidecar).
// Used so the monitor can Hyper-bypass Kmart without a separate Fly "release".

const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const http = require("http");
const fs = require("fs");
const os = require("os");

const EXECUTOR_DIR = path.join(__dirname, "..", "..", "executor");

let child = null;
let port = null;
let token = null;

function loadDotEnv(filePath) {
  const out = {};
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key) out[key] = val;
    }
  } catch {
    /* missing is fine */
  }
  return out;
}

/** Pull Hyper key from desktop Settings if operator hasn't set HYPER_API_KEY. */
function hyperFromDesktopSettings() {
  const candidates = [
    path.join(process.env.APPDATA || "", "j1ms-bot-desktop", "j1ms-desktop", "settings.json"),
    path.join(os.homedir(), "AppData", "Roaming", "j1ms-bot-desktop", "j1ms-desktop", "settings.json"),
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const key = String(j.hyperApiKey || "").trim();
      if (key) return key;
    } catch {
      /* try next */
    }
  }
  return "";
}

function resolveHyperApiKey() {
  const fromEnv = String(process.env.HYPER_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const rootEnv = loadDotEnv(path.join(__dirname, "..", "..", ".env"));
  if (rootEnv.HYPER_API_KEY) return String(rootEnv.HYPER_API_KEY).trim();
  const monEnv = loadDotEnv(path.join(__dirname, "..", ".env"));
  if (monEnv.HYPER_API_KEY) return String(monEnv.HYPER_API_KEY).trim();
  return hyperFromDesktopSettings();
}

function desktopDbPath() {
  return path.join(process.env.APPDATA || "", "j1ms-bot-desktop", "j1ms-desktop", "db.json");
}

/** Normalize host:port:user:pass → http://user:pass@host:port */
function toProxyUrl(entry) {
  const s = String(entry || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  const parts = s.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...passParts] = parts;
    const pass = passParts.join(":");
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return s;
}

/**
 * First desktop proxy (usually the same resi that already checkouts).
 * Used as Hyper fallback when ISP exits get Akamai denied.
 */
function proxyFromDesktopDb() {
  try {
    const j = JSON.parse(fs.readFileSync(desktopDbPath(), "utf8"));
    const groups = Array.isArray(j.proxyGroups) ? j.proxyGroups : [];
    for (const g of groups) {
      const entries = Array.isArray(g.entries) ? g.entries : Array.isArray(g.proxies) ? g.proxies : [];
      for (const e of entries) {
        const url = toProxyUrl(typeof e === "string" ? e : e?.raw || e?.url || e?.proxy);
        if (url) return url;
      }
    }
  } catch {
    /* none */
  }
  return "";
}

/** Apply local-friendly env defaults before server starts. */
function applyLocalMonitorDefaults() {
  if (!process.env.MONITOR_FALLBACK_PROXY && !process.env.PROXY_URL_RESI) {
    const desk = proxyFromDesktopDb();
    if (desk) process.env.MONITOR_FALLBACK_PROXY = desk;
  }
  // Local PC: use the same proxies that already succeed at checkout first.
  // ISP-first is for the future Fly 24/7 deploy (`MONITOR_PROXY_MODE=isp`).
  if (!process.env.MONITOR_PROXY_MODE) {
    process.env.MONITOR_PROXY_MODE = process.env.MONITOR_FALLBACK_PROXY ? "desktop" : "isp";
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

function waitHealth(p, timeoutMs = 60_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.request(
        { hostname: "127.0.0.1", port: p, path: "/health", method: "GET", timeout: 2000 },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                return resolve(JSON.parse(body || "{}"));
              } catch {
                return resolve({ ok: true });
              }
            }
            if (Date.now() - start > timeoutMs) return reject(new Error(`health HTTP ${res.statusCode}`));
            setTimeout(tick, 400);
          });
        },
      );
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          return reject(new Error("local executor failed to start — run: cd executor && npm install"));
        }
        setTimeout(tick, 400);
      });
      req.on("timeout", () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error("local executor health timeout"));
        setTimeout(tick, 400);
      });
      req.end();
    };
    tick();
  });
}

/**
 * Start local executor if needed. Sets MONITOR_EXECUTOR_URL + TOKEN on process.env.
 * @returns {Promise<{ ok: boolean; mode: string; error?: string; url?: string; hyperConfigured?: boolean }>}
 */
async function ensureExecutorForMonitor() {
  const existingUrl = String(process.env.MONITOR_EXECUTOR_URL || process.env.EXECUTOR_URL || "").trim();
  const existingToken = String(process.env.MONITOR_EXECUTOR_TOKEN || process.env.EXECUTOR_TOKEN || "").trim();

  // Explicit remote (e.g. Fly j1ms-bot-executor) — do not spawn.
  if (existingUrl && existingToken) {
    process.env.MONITOR_EXECUTOR_URL = existingUrl.replace(/\/$/, "");
    process.env.MONITOR_EXECUTOR_TOKEN = existingToken;
    return { ok: true, mode: "remote", url: process.env.MONITOR_EXECUTOR_URL };
  }

  // Default: use the live Fly executor if only the token is provided.
  if (existingToken && !existingUrl) {
    process.env.MONITOR_EXECUTOR_URL = "https://j1ms-bot-executor.fly.dev";
    process.env.MONITOR_EXECUTOR_TOKEN = existingToken;
    return { ok: true, mode: "fly", url: process.env.MONITOR_EXECUTOR_URL };
  }

  const hyper = resolveHyperApiKey();
  if (!hyper) {
    return {
      ok: false,
      mode: "none",
      error:
        "Need Hyper to probe Kmart. Easiest: open desktop Settings and save your Hyper API key, OR put HYPER_API_KEY=... in monitor/.env, OR put EXECUTOR_TOKEN=... (same as Fly) in monitor/.env to use https://j1ms-bot-executor.fly.dev",
    };
  }

  if (!fs.existsSync(path.join(EXECUTOR_DIR, "server.js"))) {
    return { ok: false, mode: "none", error: `executor folder missing at ${EXECUTOR_DIR}` };
  }

  port = await freePort();
  token = crypto.randomBytes(24).toString("hex");
  const rootEnv = loadDotEnv(path.join(__dirname, "..", "..", ".env"));

  child = spawn("node", ["server.js"], {
    cwd: EXECUTOR_DIR,
    env: {
      ...process.env,
      ...rootEnv,
      PORT: String(port),
      HOST: "127.0.0.1",
      EXECUTOR_TOKEN: token,
      HYPER_API_KEY: hyper,
      MAX_CONCURRENT: String(process.env.MONITOR_EXECUTOR_CONCURRENCY || 3),
      PROXY_URL_RESI: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (d) => {
    const line = String(d).trim();
    if (line) console.log("[executor]", line.slice(0, 240));
  });
  child.stderr.on("data", (d) => {
    console.error("[executor:err]", String(d).trim().slice(0, 240));
  });
  child.on("exit", (code) => {
    console.log("[executor] exited", code);
    child = null;
  });

  try {
    const health = await waitHealth(port);
    process.env.MONITOR_EXECUTOR_URL = `http://127.0.0.1:${port}`;
    process.env.MONITOR_EXECUTOR_TOKEN = token;
    return {
      ok: true,
      mode: "local-sidecar",
      url: process.env.MONITOR_EXECUTOR_URL,
      hyperConfigured: health.hyperApiKey === true || Boolean(hyper),
    };
  } catch (e) {
    await stopLocalExecutor();
    return { ok: false, mode: "local-sidecar", error: e.message || String(e) };
  }
}

async function stopLocalExecutor() {
  if (!child) return;
  const c = child;
  child = null;
  try {
    c.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 300));
  try {
    if (!c.killed) c.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  port = null;
  token = null;
}

module.exports = {
  ensureExecutorForMonitor,
  stopLocalExecutor,
  resolveHyperApiKey,
  loadDotEnv,
  applyLocalMonitorDefaults,
  proxyFromDesktopDb,
  toProxyUrl,
};
