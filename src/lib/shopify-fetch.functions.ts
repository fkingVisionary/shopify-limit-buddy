// Server-side Shopify fetch that can tunnel through a raw `user:pass@host:port`
// proxy. Workerd `fetch` has no HTTP proxy support, so raw proxies are
// fulfilled via Browserless's `/function` endpoint with `--proxy-server` +
// `page.authenticate`. URL-template proxies (`https://x?url={url}`) should be
// called directly from the client; this fn is only for raw proxies.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWorkspaceDevice } from "@/integrations/workspace/middleware";
import { classifyProxy, parseProxyParts } from "@/lib/proxy-format";

const Schema = z.object({
  targetUrl: z.string().url().max(2000),
  proxyUrl: z.string().min(1).max(2000),
});

export type ShopifyFetchResult = {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  error: string | null;
  exitIp: string | null;
};

export const shopifyFetchViaProxy = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .inputValidator((d: unknown) => Schema.parse(d))
  .handler(async ({ data }): Promise<ShopifyFetchResult> => {
    const classification = classifyProxy(data.proxyUrl);
    if (classification.kind !== "raw" || !classification.url) {
      return { ok: false, status: 0, body: "", contentType: "", error: "proxy must be a raw host:port[:user:pass] entry", exitIp: null };
    }
    const parts = parseProxyParts(classification.url);
    if (!parts) {
      return { ok: false, status: 0, body: "", contentType: "", error: "could not parse proxy URL", exitIp: null };
    }
    const apiKey = process.env.BROWSERLESS_API_KEY;
    if (!apiKey) {
      return { ok: false, status: 0, body: "", contentType: "", error: "BROWSERLESS_API_KEY missing on server", exitIp: null };
    }

    const proxyServer = `${parts.scheme}://${parts.host}:${parts.port}`;
    const url = new URL("https://production-sfo.browserless.io/function");
    url.searchParams.set("token", apiKey);
    url.searchParams.set("timeout", "25000");
    url.searchParams.set("launch", JSON.stringify({ args: [`--proxy-server=${proxyServer}`] }));

    const code = `export default async ({ page, context }) => {
      try {
        if (context && context.username) {
          await page.authenticate({ username: context.username, password: context.password || "" });
        }
        const res = await page.goto(context.targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        const status = res ? res.status() : 0;
        const headers = res ? res.headers() : {};
        const contentType = headers["content-type"] || "text/plain";
        const body = await page.evaluate(() => {
          const pre = document.querySelector("pre");
          if (pre && pre.innerText) return pre.innerText;
          return document.documentElement ? document.documentElement.innerText : "";
        });
        return { ok: true, status, contentType, body };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }`;

    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          context: {
            username: parts.username ?? "",
            password: parts.password ?? "",
            targetUrl: data.targetUrl,
          },
        }),
        signal: AbortSignal.timeout(35000),
      });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, status: 0, body: "", contentType: "", error: `Browserless HTTP ${res.status}: ${text.slice(0, 200)}`, exitIp: null };
      }
      const outer = JSON.parse(text) as { ok?: boolean; status?: number; body?: string; contentType?: string; error?: string };
      if (outer.ok === false || outer.error) {
        return { ok: false, status: 0, body: "", contentType: "", error: outer.error ?? "proxy fetch failed", exitIp: null };
      }
      return {
        ok: (outer.status ?? 0) > 0 && (outer.status ?? 0) < 400,
        status: outer.status ?? 0,
        body: outer.body ?? "",
        contentType: outer.contentType ?? "text/plain",
        error: null,
        exitIp: null,
      };
    } catch (e) {
      return { ok: false, status: 0, body: "", contentType: "", error: e instanceof Error ? e.message : "transport error", exitIp: null };
    }
  });
