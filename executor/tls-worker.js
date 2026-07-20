// Child-process Chrome TLS worker (node-tls-client).
// Runs in a separate OS process so a native SIGSEGV/abort cannot empty-502
// the Fastify parent (tip #54 in-process Session did). Parent talks IPC only.
//
// Protocol (JSON messages):
//   → { id, op: "init", proxy?: string|null }
//   ← { id, ok, error? }
//   → { id, op: "request", url, method, headers, body? }
//   ← { id, ok, status?, headers?, body?, url?, error? }
//   → { id, op: "close" }
//   ← { id, ok: true } then process exits

import { ensureTlsNativeLib } from "./ensure-tls-native.js";

const CHROME_HEADER_ORDER = [
  "host",
  "connection",
  "cache-control",
  "sec-ch-ua",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-mobile",
  "sec-ch-ua-model",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  "upgrade-insecure-requests",
  "user-agent",
  "accept",
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-user",
  "sec-fetch-dest",
  "referer",
  "accept-encoding",
  "accept-language",
  "priority",
  "cookie",
];

let session = null;
let tlsReady = null;
let tlsMod = null;

function reply(msg) {
  if (typeof process.send === "function") process.send(msg);
}

async function loadTls() {
  if (tlsMod) return tlsMod;
  const seed = ensureTlsNativeLib();
  if (!seed.ok) {
    // Still attempt import — local/dev may download successfully.
    console.error(`[tls-worker] ${seed.note}`);
  } else if (seed.seeded) {
    console.error(`[tls-worker] ${seed.note}`);
  }
  tlsMod = await import("node-tls-client");
  return tlsMod;
}

async function ensureSession(proxy) {
  const { Session, ClientIdentifier, initTLS } = await loadTls();
  if (!tlsReady) tlsReady = initTLS();
  await tlsReady;
  if (session) {
    try {
      await session.close();
    } catch {
      /* ignore */
    }
    session = null;
  }
  session = new Session({
    clientIdentifier: ClientIdentifier.chrome_131,
    timeout: 30_000,
    headerOrder: CHROME_HEADER_ORDER,
    ...(proxy ? { proxy } : {}),
  });
}

async function doRequest(msg) {
  if (!session) throw new Error("tls-worker not initialized");
  const method = String(msg.method || "GET").toUpperCase();
  const reqOpts = {
    headers: msg.headers || {},
    followRedirects: false,
    ...(msg.body !== undefined && msg.body !== null ? { body: msg.body } : {}),
  };
  let res;
  switch (method) {
    case "GET":
      res = await session.get(msg.url, reqOpts);
      break;
    case "POST":
      res = await session.post(msg.url, reqOpts);
      break;
    case "PUT":
      res = await session.put(msg.url, reqOpts);
      break;
    case "DELETE":
      res = await session.delete(msg.url, reqOpts);
      break;
    case "PATCH":
      res = await session.patch(msg.url, reqOpts);
      break;
    case "HEAD":
      res = await session.head(msg.url, reqOpts);
      break;
    default:
      throw new Error(`unsupported method: ${method}`);
  }
  const rawHeaders = res.headers ?? {};
  // Normalize header bag for IPC (plain object, set-cookie as string[]).
  const headers = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    const key = String(k).toLowerCase();
    if (key === "set-cookie") {
      headers[key] = Array.isArray(v) ? v.map(String) : [String(v)];
    } else {
      headers[key] = Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  let body = "";
  try {
    body = res.body ?? (await res.text());
  } catch {
    body = "";
  }
  return {
    status: res.status,
    // Do NOT call this `ok` — parent uses msg.ok for IPC success, and a 403
    // would overwrite { ok: true } when the reply spreads this object.
    httpOk: Boolean(res.ok ?? (res.status >= 200 && res.status < 300)),
    url: res.url ?? msg.url,
    headers,
    body: typeof body === "string" ? body : String(body ?? ""),
  };
}

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  const id = msg.id;
  try {
    if (msg.op === "init") {
      await ensureSession(msg.proxy || null);
      reply({ id, ok: true });
      return;
    }
    if (msg.op === "request") {
      const out = await doRequest(msg);
      reply({ id, ok: true, ...out });
      return;
    }
    if (msg.op === "close") {
      try {
        await session?.close?.();
      } catch {
        /* ignore */
      }
      session = null;
      reply({ id, ok: true });
      setTimeout(() => process.exit(0), 10);
      return;
    }
    reply({ id, ok: false, error: `unknown op ${msg.op}` });
  } catch (e) {
    reply({ id, ok: false, error: e?.message ?? String(e) });
  }
});

process.on("uncaughtException", (e) => {
  reply({ id: null, ok: false, error: `uncaught: ${e?.message ?? e}` });
  process.exit(1);
});

process.on("unhandledRejection", (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  reply({ id: null, ok: false, error: `unhandledRejection: ${msg}` });
});
