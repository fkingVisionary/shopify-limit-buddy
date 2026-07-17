// Always spawn system Node — Electron's process.execPath is not Node.
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const http = require("http");
const fs = require("fs");

const EXECUTOR_DIR = path.join(__dirname, "..", "executor");

// Kmart AU Paydock widget public key (client-side; safe to embed). Override via
// Settings or PAYDOCK_PUBLIC_KEY. Filled once we have a known-good value.
let KMART_PAYDOCK_PUBLIC_KEY_DEFAULT = "";
try {
  // Optional committed default — public widget key only.
  const def = require(path.join(EXECUTOR_DIR, "paydock-defaults.cjs"));
  if (def?.PAYDOCK_PUBLIC_KEY) KMART_PAYDOCK_PUBLIC_KEY_DEFAULT = String(def.PAYDOCK_PUBLIC_KEY).trim();
} catch {
  /* optional */
}

let child = null;
let token = null;
let port = null;
let hyperKeyInUse = null;
let paydockKeyInUse = null;

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
    /* missing .env is fine */
  }
  return out;
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

function waitHealth(p, timeoutMs = 45_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: p,
          path: "/health",
          method: "GET",
          timeout: 2000,
        },
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
        if (Date.now() - start > timeoutMs) return reject(new Error("executor sidecar failed to start — run: cd executor && npm install"));
        setTimeout(tick, 400);
      });
      req.on("timeout", () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error("executor sidecar health timeout"));
        setTimeout(tick, 400);
      });
      req.end();
    };
    tick();
  });
}

async function startSidecar({ hyperApiKey, paydockPublicKey, maxConcurrent = 5 } = {}) {
  const nextPaydock =
    String(paydockPublicKey || "").trim() ||
    String(process.env.PAYDOCK_PUBLIC_KEY || "").trim() ||
    KMART_PAYDOCK_PUBLIC_KEY_DEFAULT;
  if (child && !child.killed) {
    const hyperChanged = hyperApiKey && hyperApiKey !== hyperKeyInUse;
    const paydockChanged = nextPaydock && nextPaydock !== paydockKeyInUse;
    if (hyperChanged || paydockChanged) {
      await stopSidecar();
    } else {
      return { ok: true, ...status() };
    }
  }

  port = await freePort();
  token = crypto.randomBytes(24).toString("hex");
  hyperKeyInUse = hyperApiKey || null;

  // Load repo-root .env into sidecar without overriding explicit settings.
  const envFromFile = loadDotEnv(path.join(__dirname, "..", ".env"));

  const env = {
    ...process.env,
    ...envFromFile,
    PORT: String(port),
    HOST: "127.0.0.1",
    EXECUTOR_TOKEN: token,
    MAX_CONCURRENT: String(Math.max(1, Math.min(50, Number(maxConcurrent) || 5))),
    PROXY_URL_RESI: "",
    // Desktop defaults to per-task forceTls; keep env from forcing undici here.
  };
  if (hyperApiKey) env.HYPER_API_KEY = hyperApiKey;
  else delete env.HYPER_API_KEY;

  const paydockPk =
    String(paydockPublicKey || "").trim() ||
    String(env.PAYDOCK_PUBLIC_KEY || envFromFile.PAYDOCK_PUBLIC_KEY || "").trim() ||
    KMART_PAYDOCK_PUBLIC_KEY_DEFAULT;
  paydockKeyInUse = paydockPk || null;
  if (paydockPk) env.PAYDOCK_PUBLIC_KEY = paydockPk;
  else delete env.PAYDOCK_PUBLIC_KEY;

  let stderr = "";
  child = spawn("node", ["server.js"], {
    cwd: EXECUTOR_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (d) => {
    const line = String(d).trim();
    if (line) console.log("[executor]", line.slice(0, 300));
  });
  child.stderr.on("data", (d) => {
    stderr += String(d);
    console.error("[executor:err]", String(d).trim().slice(0, 300));
  });
  child.on("exit", (code) => {
    console.log("[executor] exited", code);
    if (child) child = null;
  });

  try {
    const health = await waitHealth(port);
    return { ok: true, ...status(), health };
  } catch (e) {
    await stopSidecar();
    return { ok: false, error: e.message || String(e), stderr: stderr.slice(-800) };
  }
}

async function stopSidecar() {
  if (!child) {
    port = null;
    token = null;
    hyperKeyInUse = null;
    return;
  }
  const c = child;
  child = null;
  try {
    c.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 400));
  try {
    if (!c.killed) c.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  port = null;
  token = null;
  hyperKeyInUse = null;
}

function status() {
  return {
    running: Boolean(child && !child.killed),
    port,
    hasToken: Boolean(token),
    hyperConfigured: Boolean(hyperKeyInUse),
  };
}

function requestJson(method, urlPath, body, timeoutMs = 250_000) {
  if (!port || !token) return Promise.reject(new Error("executor sidecar not running — click Start engine"));
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { ok: false, error: data.slice(0, 300) };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("local executor request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTask(task) {
  const { status: httpStatus, json } = await requestJson("POST", "/run", task);
  if (httpStatus === 429) {
    return { ok: false, error: json?.error || "local executor at capacity", atCapacity: true };
  }
  return json || { ok: false, error: `HTTP ${httpStatus}` };
}

async function progress(taskId) {
  const { json } = await requestJson("GET", `/progress/${encodeURIComponent(taskId)}`, null, 10_000);
  return json;
}

module.exports = {
  startSidecar,
  stopSidecar,
  status,
  runTask,
  progress,
};
