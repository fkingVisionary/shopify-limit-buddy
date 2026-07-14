// Always spawn system Node — Electron's process.execPath is not Node.
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const http = require("http");

const EXECUTOR_DIR = path.join(__dirname, "..", "executor");

let child = null;
let token = null;
let port = null;
let hyperKeyInUse = null;

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

async function startSidecar({ hyperApiKey, maxConcurrent = 5 } = {}) {
  if (child && !child.killed) {
    if (hyperApiKey && hyperApiKey !== hyperKeyInUse) {
      await stopSidecar();
    } else {
      return { ok: true, ...status() };
    }
  }

  port = await freePort();
  token = crypto.randomBytes(24).toString("hex");
  hyperKeyInUse = hyperApiKey || null;

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    EXECUTOR_TOKEN: token,
    MAX_CONCURRENT: String(Math.max(1, Math.min(50, Number(maxConcurrent) || 5))),
    PROXY_URL_RESI: "",
  };
  if (hyperApiKey) env.HYPER_API_KEY = hyperApiKey;
  else delete env.HYPER_API_KEY;

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
