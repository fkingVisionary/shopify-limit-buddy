// Parent-side bridge to executor/tls-worker.js (child_process.fork).
// Isolates native node-tls-client crashes from the Fastify process.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER_PATH = fileURLToPath(new URL("./tls-worker.js", import.meta.url));
const DEFAULT_TIMEOUT_MS = 45_000;
const INIT_TIMEOUT_MS = 60_000;

function wrapBridgeResponse(payload, requestedUrl) {
  const rawHeaders = payload.headers ?? {};
  const status = payload.status;
  return {
    status,
    ok: Boolean(payload.httpOk ?? (status >= 200 && status < 300)),
    url: payload.url || requestedUrl,
    headers: {
      get(name) {
        const v = rawHeaders[String(name).toLowerCase()];
        if (v == null) return null;
        return Array.isArray(v) ? v.join(", ") : String(v);
      },
      getSetCookie() {
        const v = rawHeaders["set-cookie"];
        if (!v) return [];
        return Array.isArray(v) ? v.map(String) : [String(v)];
      },
      raw: rawHeaders,
    },
    async text() {
      return payload.body ?? "";
    },
    async json() {
      return JSON.parse(payload.body ?? "");
    },
  };
}

export function createTlsBridge(proxyUrl = null, opts = {}) {
  const child = fork(WORKER_PATH, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
    // Don't inherit parent execArgv (e.g. --input-type=module from ad-hoc
    // node -e); the worker is a real .js file and that flag breaks it.
    execArgv: [],
  });
  let seq = 0;
  const pending = new Map();
  let dead = false;
  let deadReason = "tls-worker exited";
  const stderrChunks = [];

  if (child.stderr) {
    child.stderr.on("data", (buf) => {
      const s = String(buf);
      if (stderrChunks.length < 20) stderrChunks.push(s.slice(0, 400));
    });
  }

  const failAll = (reason) => {
    dead = true;
    deadReason = reason;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
  };

  child.on("message", (msg) => {
    if (!msg || msg.id == null) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || "tls-worker request failed"));
  });

  child.on("exit", (code, signal) => {
    const tail = stderrChunks.join("").slice(-300);
    failAll(
      `tls-worker exited code=${code} signal=${signal || "-"}${tail ? ` stderr=${tail.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
    );
  });

  child.on("error", (err) => {
    failAll(`tls-worker error: ${err?.message ?? err}`);
  });

  const call = (payload, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (dead) {
        reject(new Error(deadReason));
        return;
      }
      if (typeof child.send !== "function") {
        reject(new Error("tls-worker IPC unavailable"));
        return;
      }
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`tls-worker timeout after ${timeoutMs}ms op=${payload.op}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        child.send({ ...payload, id });
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });

  return {
    transport: "tls-worker",
    proxy: proxyUrl || null,
    async init() {
      await call({ op: "init", proxy: proxyUrl || null }, opts.initTimeoutMs ?? INIT_TIMEOUT_MS);
    },
    async request(url, reqOpts = {}) {
      const msg = await call(
        {
          op: "request",
          url,
          method: reqOpts.method || "GET",
          headers: reqOpts.headers || {},
          body: reqOpts.body,
        },
        opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      return wrapBridgeResponse(msg, url);
    },
    async close() {
      if (dead) return;
      try {
        await call({ op: "close" }, 5_000);
      } catch {
        /* ignore */
      }
      try {
        if (!child.killed) child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      dead = true;
    },
  };
}

/**
 * Dispatcher-shaped object: request() routes through the child TLS worker
 * (not in-process Session). `proxyUrl` must already be a normalized
 * http://user:pass@host:port string (caller runs parseProxy).
 */
export async function makeRemoteTlsDispatcher(proxyUrl = null, opts = {}) {
  const bridge = createTlsBridge(proxyUrl, opts);
  await bridge.init();
  return {
    proxy: proxyUrl || null,
    useTls: false,
    remoteTls: bridge,
    transport: "tls-worker",
    sticky: false,
    undiciDispatcher() {
      return undefined;
    },
    async tlsSession() {
      throw new Error("remote tls-worker dispatcher has no in-process Session");
    },
    async resetUndici() {
      /* no-op */
    },
    async close() {
      await bridge.close();
    },
  };
}
