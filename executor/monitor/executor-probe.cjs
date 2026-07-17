// Call the checkout executor's Hyper-backed Kmart stock probe.
// Same warm → sensor → PDP path as successful checkouts; never ATC/order.

const http = require("http");
const https = require("https");
const { URL } = require("url");

function executorConfig() {
  const base = String(process.env.MONITOR_EXECUTOR_URL || process.env.EXECUTOR_URL || "").replace(/\/$/, "");
  const token = String(process.env.MONITOR_EXECUTOR_TOKEN || process.env.EXECUTOR_TOKEN || "").trim();
  return { base, token, configured: Boolean(base && token) };
}

/**
 * @param {{ url: string; proxyUrl?: string | null; timeoutMs?: number }} opts
 * @returns {Promise<{
 *   ok: boolean;
 *   inStock: boolean | null;
 *   title: string | null;
 *   sku: string | null;
 *   url: string;
 *   price: number | null;
 *   imageUrl?: string | null;
 *   blocked?: boolean;
 *   error?: string;
 *   status?: number;
 *   via?: string;
 * }>}
 */
function probeViaExecutor(opts) {
  const { base, token, configured } = executorConfig();
  if (!configured) {
    return Promise.resolve({
      ok: false,
      inStock: null,
      title: null,
      sku: null,
      url: opts.url,
      price: null,
      blocked: false,
      error: "MONITOR_EXECUTOR_URL + MONITOR_EXECUTOR_TOKEN (or EXECUTOR_*) required for Hyper stock probe",
      via: "executor",
    });
  }

  const timeoutMs = Math.max(8_000, Number(opts.timeoutMs) || 90_000);
  const body = JSON.stringify({
    url: opts.url,
    proxy: opts.proxyUrl || null,
    taskId: `mon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let u;
    try {
      u = new URL(`${base}/kmart/stock-probe`);
    } catch (e) {
      return finish({
        ok: false,
        inStock: null,
        title: null,
        sku: null,
        url: opts.url,
        price: null,
        error: `bad EXECUTOR_URL: ${e?.message || e}`,
        via: "executor",
      });
    }

    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
          if (raw.length > 2_000_000) raw = raw.slice(0, 2_000_000);
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw || "{}");
          } catch {
            return finish({
              ok: false,
              inStock: null,
              title: null,
              sku: null,
              url: opts.url,
              price: null,
              error: `executor non-JSON HTTP ${res.statusCode}`,
              status: res.statusCode,
              via: "executor",
            });
          }
          const stepNote = Array.isArray(parsed.steps)
            ? [...parsed.steps].reverse().find((s) => s && s.ok === false && s.note)?.note
            : null;
          finish({
            ok: parsed.ok === true,
            inStock: parsed.inStock ?? null,
            title: parsed.title ?? null,
            sku: parsed.sku ?? null,
            url: parsed.url || opts.url,
            price: parsed.price ?? null,
            imageUrl: parsed.imageUrl ?? null,
            blocked: parsed.blocked === true,
            error:
              parsed.error ||
              stepNote ||
              (parsed.ok ? null : `probe failed (HTTP ${res.statusCode})`),
            status: parsed.pdpStatus ?? res.statusCode,
            via: "executor",
            elapsedMs: parsed.elapsedMs ?? null,
            steps: parsed.steps || null,
          });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      finish({
        ok: false,
        inStock: null,
        title: null,
        sku: null,
        url: opts.url,
        price: null,
        error: `executor probe timeout ${timeoutMs}ms`,
        via: "executor",
      });
    });
    req.on("error", (e) => {
      finish({
        ok: false,
        inStock: null,
        title: null,
        sku: null,
        url: opts.url,
        price: null,
        error: e?.message || String(e),
        via: "executor",
      });
    });
    req.write(body);
    req.end();
  });
}

module.exports = { executorConfig, probeViaExecutor };
