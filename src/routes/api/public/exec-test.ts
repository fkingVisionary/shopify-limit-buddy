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
          dryRun?: boolean;
        };
        const mode = body.mode ?? "run";
        // Default to direct (Fly egress IP) to conserve residential proxy data
        // during testing. `proxyUrl` lets the caller override per-request; else
        // `useProxy:true` falls back to PROXY_URL_RESI.
        const proxy = body.proxyUrl ?? (body.useProxy ? process.env.PROXY_URL_RESI ?? null : null);
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
            return Response.json({ ok: res.ok, status: res.status, elapsedMs: Date.now() - t0, result: data, usedProxy: Boolean(proxy) });
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
          return Response.json({ ok: res.ok, status: res.status, elapsedMs: Date.now() - t0, result: data, cardSent: Boolean(card) });
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
