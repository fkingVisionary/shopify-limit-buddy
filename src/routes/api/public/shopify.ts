import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function isAllowed(target: URL): boolean {
  if (target.protocol !== "https:") return false;
  // Allow /products.json, /products/:handle, /products/:handle.json,
  // /collections/* and /search/suggest.json on any host.
  const p = target.pathname;
  if (p === "/products.json") return true;
  if (/^\/products\/[a-z0-9-]+(\.json|\.js)?$/i.test(p)) return true;
  if (/^\/collections\/[a-z0-9-]+(\/products\.json)?$/i.test(p)) return true;
  if (/^\/variants\/\d+\.js$/i.test(p)) return true;
  if (p === "/search/suggest.json") return true;
  return false;
}

export const Route = createFileRoute("/api/public/shopify")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const target = url.searchParams.get("url");
        if (!target) {
          return new Response(JSON.stringify({ error: "Missing url param" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...CORS },
          });
        }
        let parsed: URL;
        try {
          parsed = new URL(target);
        } catch {
          return new Response(JSON.stringify({ error: "Invalid url" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...CORS },
          });
        }
        if (!isAllowed(parsed)) {
          return new Response(
            JSON.stringify({ error: "URL not allowed. Only Shopify product/collection endpoints are proxied." }),
            { status: 400, headers: { "Content-Type": "application/json", ...CORS } },
          );
        }

        const fetchOnce = async (u: string) =>
          fetch(u, {
            redirect: "follow",
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              Accept: parsed.pathname.endsWith(".json")
                ? "application/json,text/plain,*/*"
                : "text/html,application/xhtml+xml,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
            },
          });

        try {
          let upstream: Response;
          try {
            upstream = await fetchOnce(parsed.toString());
          } catch {
            upstream = new Response("", { status: 599 });
          }
          // Retry on www. variant if root host was blocked / failed.
          if (!upstream.ok && !parsed.hostname.startsWith("www.")) {
            const alt = new URL(parsed.toString());
            alt.hostname = "www." + parsed.hostname;
            try {
              const retry = await fetchOnce(alt.toString());
              if (retry.ok) upstream = retry;
            } catch { /* ignore */ }
          }

          const body = await upstream.text();
          const ct = upstream.headers.get("content-type") ?? "text/plain";
          if (!upstream.ok) {
            // Return 200 + fallback signal so the client doesn't crash on 5xx.
            return new Response(
              JSON.stringify({
                error: "UPSTREAM_ERROR",
                fallback: true,
                upstreamStatus: upstream.status,
              }),
              { status: 200, headers: { "Content-Type": "application/json", ...CORS } },
            );
          }
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": ct, ...CORS },
          });
        } catch (err: any) {
          return new Response(
            JSON.stringify({ error: err?.message ?? "Upstream fetch failed", fallback: true }),
            { status: 200, headers: { "Content-Type": "application/json", ...CORS } },
          );
        }
      },
    },
  },
});
