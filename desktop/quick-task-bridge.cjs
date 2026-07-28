// Tiny localhost HTTP bridge so Discord LINK buttons can fire Quick Task
// while J1m's Bot Electron is open on this machine.

const http = require("node:http");
const { BRIDGE_PORT, BRIDGE_HOST, parseQuickTaskDeepLink } = require("./deep-link.cjs");

/**
 * @param {{
 *   onQuickTask: (payload: object) => Promise<object>|object,
 *   onOpenSetup?: () => void|Promise<void>,
 *   port?: number,
 *   log?: (msg: string) => void,
 * }} opts
 */
function createQuickTaskBridge(opts = {}) {
  let server = null;
  let port = Number(opts.port) || BRIDGE_PORT;
  const log = opts.log || (() => {});

  function htmlPage({ ok, title, detail }) {
    const color = ok ? "#3ecf8e" : "#f07178";
    return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
  body{font:14px/1.45 system-ui,sans-serif;background:#0e1012;color:#e8eaed;
    display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{max-width:420px;padding:24px;border:1px solid #2a323c;border-radius:12px;background:#161a1f}
  h1{font-size:18px;margin:0 0 8px;color:${color}}
  p{margin:0;color:#8b949e}
  code{color:#3dd6c6}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
<p style="margin-top:12px;font-size:12px">You can close this tab.</p>
</div></body></html>`;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function handle(req, res) {
    const host = req.headers.host || `${BRIDGE_HOST}:${port}`;
    let url;
    try {
      url = new URL(req.url || "/", `http://${host}`);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request");
      return;
    }

    if (url.pathname === "/health" || url.pathname === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "j1ms-quicktask-bridge", port }));
      return;
    }

    if (url.pathname === "/setup" || url.pathname === "/qt-setup") {
      try {
        await opts.onOpenSetup?.();
      } catch (e) {
        log(`setup bridge error: ${e?.message || e}`);
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        htmlPage({
          ok: true,
          title: "Quick Task presets",
          detail: "Opened Settings → Quick Task preset",
        }),
      );
      return;
    }

    if (url.pathname !== "/quicktask") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const parsed = parseQuickTaskDeepLink(url.toString());
    if (!parsed.ok) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(
        htmlPage({
          ok: false,
          title: "Quick Task failed",
          detail: parsed.error || "Invalid link",
        }),
      );
      return;
    }

    try {
      const result = await opts.onQuickTask?.(parsed.payload);
      if (!result?.ok) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          htmlPage({
            ok: false,
            title: "Quick Task failed",
            detail: result?.error || "Could not start the task (engine/preset?)",
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        htmlPage({
          ok: true,
          title: result.started ? "Quick Task started" : "Quick Task created",
          detail: result.task?.label || result.task?.id || parsed.payload.sku || "OK",
        }),
      );
    } catch (e) {
      log(`bridge error: ${e?.message || e}`);
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(
        htmlPage({
          ok: false,
          title: "Quick Task error",
          detail: e?.message || String(e),
        }),
      );
    }
  }

  function start() {
    if (server) return { ok: true, already: true, port };
    server = http.createServer((req, res) => {
      void handle(req, res);
    });
    return new Promise((resolve) => {
      server.once("error", (err) => {
        log(`Quick Task bridge failed: ${err?.message || err}`);
        server = null;
        resolve({ ok: false, error: err?.message || String(err), port });
      });
      server.listen(port, BRIDGE_HOST, () => {
        log(`Quick Task bridge on http://${BRIDGE_HOST}:${port}/quicktask`);
        resolve({ ok: true, port });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      const s = server;
      server = null;
      s.close(() => resolve());
    });
  }

  function snapshot() {
    return {
      running: Boolean(server),
      port,
      url: `http://${BRIDGE_HOST}:${port}/quicktask`,
    };
  }

  return { start, stop, snapshot, port: () => port };
}

module.exports = { createQuickTaskBridge, BRIDGE_PORT, BRIDGE_HOST };
