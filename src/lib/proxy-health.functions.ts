// Server-side proxy health check.
//
//  • `{url}`-template proxies — fetched directly from the edge through the
//    template, then we read the JSON IP body.
//  • Raw `host:port[:user:pass]` proxies — Workerd `fetch` has no HTTP proxy
//    support, so we tunnel through Browserless's `/function` endpoint with
//    `externalProxyServer` set, then have the headless browser fetch ipify
//    and return the IP. This is the same path the real checkout uses, so a
//    green tick here means the proxy will work for checkout too.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWorkspaceDevice } from "@/integrations/workspace/middleware";
import { classifyProxy, parseProxyParts } from "@/lib/proxy-format";

const Schema = z.object({
  proxyUrl: z.string().min(1).max(2000),
  targetUrl: z.string().url().max(2000).optional(),
});

export type ProxyHealth = {
  ok: boolean;
  latencyMs: number;
  exitIp: string | null;
  error: string | null;
  kind?: "template" | "raw";
  targetStatus?: number | null;
  targetError?: string | null;
};

function cleanProxyError(message: string): string {
  const compact = message.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  if (/Proxy authentication failed|ERR_PROXY_AUTH|HTTP\/1\.[01] 407|\b407\b/i.test(compact)) {
    return "Proxy authentication failed: check the username/password order and credentials.";
  }
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES/i.test(compact)) {
    return "Proxy tunnel failed: Browserless could not connect through this proxy. Check host, port, allowlisted IPs, and HTTPS support.";
  }
  return compact.slice(0, 240) || "proxy test failed";
}


export const checkProxyExit = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .inputValidator((d: unknown) => Schema.parse(d))
  .handler(async ({ data }): Promise<ProxyHealth> => {
    const classification = classifyProxy(data.proxyUrl);
    if (classification.kind === "invalid") {
      return { ok: false, latencyMs: 0, exitIp: null, error: classification.reason ?? "invalid proxy" };
    }

    const target = "https://api.ipify.org?format=json";

    // ── Template path ─────────────────────────────────────────────────────
    if (classification.kind === "template") {
      const url = data.proxyUrl.replace("{url}", encodeURIComponent(target));
      const started = Date.now();
      try {
        const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(8000) });
        const latencyMs = Date.now() - started;
        if (!res.ok) return { ok: false, latencyMs, exitIp: null, error: `HTTP ${res.status}`, kind: "template" };
        const json = (await res.json()) as { ip?: string };
        let targetStatus: number | null = null;
        let targetError: string | null = null;
        if (data.targetUrl) {
          try {
            const turl = data.proxyUrl.replace("{url}", encodeURIComponent(data.targetUrl));
            const tres = await fetch(turl, { method: "GET", signal: AbortSignal.timeout(15000) });
            targetStatus = tres.status;
            if (!tres.ok) targetError = `HTTP ${tres.status}`;
          } catch (e) {
            targetError = e instanceof Error ? e.message : "target fetch failed";
          }
        }
        return { ok: true, latencyMs, exitIp: json.ip ?? null, error: null, kind: "template", targetStatus, targetError };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "network error";
        return { ok: false, latencyMs: Date.now() - started, exitIp: null, error: msg, kind: "template" };
      }
    }


    // ── Raw proxy → Browserless tunnel ────────────────────────────────────
    const apiKey = process.env.BROWSERLESS_API_KEY;
    if (!apiKey) {
      return { ok: false, latencyMs: 0, exitIp: null, error: "BROWSERLESS_API_KEY missing on server", kind: "raw" };
    }
    const proxyUrl = classification.url!;
    const parts = parseProxyParts(proxyUrl);
    if (!parts) {
      return { ok: false, latencyMs: 0, exitIp: null, error: "could not parse proxy URL", kind: "raw" };
    }
    const proxyServer = `${parts.scheme}://${parts.host}:${parts.port}`;
    const url = new URL("https://production-sfo.browserless.io/function");
    url.searchParams.set("token", apiKey);
    url.searchParams.set("timeout", "20000");
    // Pass proxy via Chrome launch arg. Chromium does NOT parse user:pass from
    // --proxy-server, so credentials are forwarded separately via context and
    // applied with page.authenticate() before navigation.
    url.searchParams.set(
      "launch",
      JSON.stringify({ args: [`--proxy-server=${proxyServer}`] }),
    );

    const code = `export default async ({ page, context }) => {
      try {
        if (context && context.username) {
          await page.authenticate({ username: context.username, password: context.password || "" });
        }
        const res = await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 15000 });
        const status = res ? res.status() : 0;
        const body = await page.evaluate(() => document.body && document.body.innerText);
        return { ok: true, status, body };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }`;

    const started = Date.now();
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          context: { username: parts.username ?? "", password: parts.password ?? "" },
        }),
        signal: AbortSignal.timeout(30000),
      });

      const latencyMs = Date.now() - started;
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        return { ok: false, latencyMs, exitIp: null, error: `Browserless HTTP ${res.status}: ${cleanProxyError(text)}`, kind: "raw" };
      }
      let exitIp: string | null = null;
      try {
        const outer = JSON.parse(text) as { ok?: boolean; body?: string; status?: number; error?: string };
        if (outer.ok === false || outer.error) {
          return { ok: false, latencyMs, exitIp: null, error: cleanProxyError(outer.error ?? "proxy navigation failed"), kind: "raw" };
        }
        if (outer.status && outer.status >= 400) {
          return { ok: false, latencyMs, exitIp: null, error: `proxy returned HTTP ${outer.status}`, kind: "raw" };
        }
        if (outer.body) {
          const inner = JSON.parse(outer.body) as { ip?: string };
          exitIp = inner.ip ?? null;
        }
      } catch {
        return { ok: false, latencyMs, exitIp: null, error: "could not parse proxy response", kind: "raw" };
      }
      return { ok: !!exitIp, latencyMs, exitIp, error: exitIp ? null : "no IP in response", kind: "raw" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "transport error";
      return { ok: false, latencyMs: Date.now() - started, exitIp: null, error: msg, kind: "raw" };
    }
  });
