// Server-side proxy health check. Calls api.ipify.org through the proxy
// template and reports latency + exit IP. Works for `{url}`-template proxies
// that the server can reach (most public HTTP proxy gateways).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWorkspaceDevice } from "@/integrations/workspace/middleware";

const Schema = z.object({ proxyUrl: z.string().min(1).max(2000) });

export type ProxyHealth = {
  ok: boolean;
  latencyMs: number;
  exitIp: string | null;
  error: string | null;
};

export const checkProxyExit = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .inputValidator((d: unknown) => Schema.parse(d))
  .handler(async ({ data }): Promise<ProxyHealth> => {
    const target = "https://api.ipify.org?format=json";
    if (!data.proxyUrl.includes("{url}")) {
      return { ok: false, latencyMs: 0, exitIp: null, error: "missing {url} placeholder" };
    }
    const url = data.proxyUrl.replace("{url}", encodeURIComponent(target));
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return { ok: false, latencyMs, exitIp: null, error: `HTTP ${res.status}` };
      }
      const json = (await res.json()) as { ip?: string };
      return { ok: true, latencyMs, exitIp: json.ip ?? null, error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "network error";
      return { ok: false, latencyMs: Date.now() - started, exitIp: null, error: msg };
    }
  });
