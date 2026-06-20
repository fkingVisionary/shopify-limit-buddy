// Internal smoke-test endpoint for the Fly executor.
// Public path purely so the agent can curl it during setup;
// callers must still know the storeUrl to test.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/exec-test")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = process.env.EXECUTOR_URL;
        const token = process.env.EXECUTOR_TOKEN;
        if (!url || !token) {
          return Response.json(
            { ok: false, error: "EXECUTOR_URL / EXECUTOR_TOKEN missing on server" },
            { status: 500 },
          );
        }
        const body = (await request.json().catch(() => ({}))) as {
          storeUrl?: string;
          variantId?: number;
          taskId?: string;
          mode?: "run" | "recon";
          reconUrl?: string;
          useProxy?: boolean;
          proxyUrl?: string;
          proxyGroupId?: string;
          proxyGroupName?: string;
          dryRun?: boolean;
        };
        const mode = body.mode ?? "run";
        // Resolve proxy: explicit proxyUrl wins; else random from named/id'd
        // group in `proxy_groups`; else (only when useProxy:true) fall back to
        // Fly's PROXY_URL_RESI; else direct (null).
        let proxy: string | null = null;
        let proxyUsed: { source: string; host?: string; session?: string } = { source: "none" };
        if (body.proxyUrl) {
          proxy = body.proxyUrl;
          proxyUsed = { source: "explicit" };
        } else if (body.proxyGroupId || body.proxyGroupName || body.useProxy) {
          const groupName = body.proxyGroupName ?? "Test Pool";
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const q = supabaseAdmin.from("proxy_groups").select("id,name,proxies").limit(1);
            const { data: groups } = body.proxyGroupId
              ? await q.eq("id", body.proxyGroupId)
              : await q.eq("name", groupName);
            const group = groups?.[0];
            const list = (group?.proxies ?? []) as string[];
            if (list.length > 0) {
              const raw = list[Math.floor(Math.random() * list.length)];
              const parts = raw.split(":");
              if (parts.length >= 4) {
                const [host, port, user, ...passParts] = parts;
                const pass = passParts.join(":");
                proxy = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
                const sessionMatch = pass.match(/-S([a-f0-9]+)/i);
                proxyUsed = { source: `group:${group?.name}`, host, session: sessionMatch?.[1] };
              } else {
                proxy = raw;
                proxyUsed = { source: `group:${group?.name}` };
              }
            } else if (body.useProxy) {
              proxy = process.env.PROXY_URL_RESI ?? null;
              proxyUsed = { source: proxy ? "env:PROXY_URL_RESI" : "none" };
            }
          } catch (e) {
            if (body.useProxy) {
              proxy = process.env.PROXY_URL_RESI ?? null;
              proxyUsed = { source: proxy ? "env:PROXY_URL_RESI(fallback)" : "none", host: e instanceof Error ? e.message : undefined };
            }
          }
        }
        // Defensive: strip any path the user accidentally pasted (e.g. /health)
        // so EXECUTOR_URL always resolves to the origin.
        let origin = url.trim();
        try {
          origin = new URL(origin).origin;
        } catch {
          origin = origin.replace(/\/+$/, "");
        }
        // Card injected from Lovable Cloud secrets so executor can tokenize.
        // null if any field missing — adapter then skips paydock_tokenize.
        const number = process.env.KMART_CARD_NUMBER;
        const cvv = process.env.KMART_CARD_CVV;
        const expMonth = process.env.KMART_CARD_EXPIRY_MONTH;
        const expYear = process.env.KMART_CARD_EXPIRY_YEAR;
        const holder = process.env.KMART_CARD_HOLDER;
        const card =
          number && cvv && expMonth && expYear && holder
            ? { number, cvv, expMonth, expYear, holder }
            : null;
        const t0 = Date.now();
        try {
          if (mode === "recon") {
            const target = body.reconUrl ?? body.storeUrl;
            if (!target) return Response.json({ ok: false, error: "reconUrl or storeUrl required" }, { status: 400 });
            const res = await fetch(`${origin}/recon`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ url: target, proxy }),
            });
            const data = await res.json().catch(() => ({}));
            return Response.json({ ok: res.ok, status: res.status, elapsedMs: Date.now() - t0, result: data, usedProxy: Boolean(proxy), proxyUsed });
          }
          if (!body.storeUrl) {
            return Response.json({ ok: false, error: "storeUrl required" }, { status: 400 });
          }
          const payload = {
            taskId: body.taskId ?? `smoke-${Date.now()}`,
            storeUrl: body.storeUrl,
            variantId: body.variantId ?? 1,
            qty: 1,
            dryRun: body.dryRun ?? true,
            proxy,
            card,
          };
          const res = await fetch(`${origin}/run`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          return Response.json({ ok: res.ok, status: res.status, elapsedMs: Date.now() - t0, result: data, cardSent: Boolean(card), proxyUsed });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e), elapsedMs: Date.now() - t0 },
            { status: 502 },
          );
        }
      },
    },
  },
});
