// Authenticated SSE feed for MonitorEvent stream.

const { EventDedupe } = require("./events.cjs");

class FeedHub {
  constructor() {
    /** @type {Set<import('http').ServerResponse>} */
    this.clients = new Set();
    this.dedupe = new EventDedupe(30_000);
    /** @type {object[]} */
    this.recent = [];
    this.maxRecent = 100;
  }

  authOk(req) {
    const mode = String(process.env.MONITOR_AUTH_MODE || "allowlist").toLowerCase();
    if (mode === "open") return true;

    const keys = String(process.env.MONITOR_API_KEYS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!keys.length && mode === "allowlist") {
      // Dev convenience: if no keys configured, accept any non-empty bearer.
      const token = extractToken(req);
      return Boolean(token);
    }

    const token = extractToken(req);
    return Boolean(token && keys.includes(token));
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   */
  subscribe(req, res) {
    if (!this.authOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, clients: this.clients.size + 1 })}\n\n`);

    for (const evt of this.recent.slice(0, 20).reverse()) {
      res.write(`event: monitor\ndata: ${JSON.stringify(evt)}\n\n`);
    }

    this.clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch {
        clearInterval(ping);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  /** @param {object} evt */
  publish(evt) {
    if (!this.dedupe.accept(evt)) return false;
    this.recent.unshift(evt);
    if (this.recent.length > this.maxRecent) this.recent.length = this.maxRecent;

    const payload = `event: monitor\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
    return true;
  }

  stats() {
    return { clients: this.clients.size, recent: this.recent.length };
  }
}

function extractToken(req) {
  const auth = String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  try {
    const u = new URL(req.url || "/", "http://localhost");
    return (u.searchParams.get("access_token") || u.searchParams.get("apiKey") || "").trim();
  } catch {
    return "";
  }
}

module.exports = { FeedHub, extractToken };
