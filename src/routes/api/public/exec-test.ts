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
          proxies?: string[];
          proxyEntries?: string[];
          proxyGroupId?: string;
          proxyGroupName?: string;
          dryRun?: boolean;
          /** Real place-order + 3DS. Implies card injection from Lovable secrets. */
          placeOrder?: boolean;
          /** Inject KMART_CARD_* without placeOrder (still runs Paydock/3DS — Revolut will ping). */
          withCard?: boolean;
          /** Opt-in executor experiments (forwarded to Fly /run). */
          transport?: string;
          forceTls?: boolean;
          forceUndici?: boolean;
          /** Opt-in chrome_131 handoff for api.* (default off — native TLS 502s on Fly). */
          apiTls?: boolean;
          kmartMode?: string;
          gqlBearer?: boolean;
        };
        const mode = body.mode ?? "run";
        // Resolve proxy: explicit proxyUrl wins; else proxies[]/proxyEntries[];
        // else named supabase group; else let Fly pick from resi.proxies via
        // useProxy:true (do NOT force Lovable's PROXY_URL_RESI — that shadows
        // the executor pool and often fails proxy_parse).
        let proxy: string | null = null;
        let proxyList: string[] | null = null;
        let forwardUseProxy = false;
        let proxyUsed: { source: string; host?: string; session?: string } = { source: "none" };
        if (body.proxyUrl) {
          proxy = body.proxyUrl;
          proxyUsed = { source: "explicit" };
        } else if (Array.isArray(body.proxies) && body.proxies.length) {
          proxyList = body.proxies.map((e) => String(e || "").trim()).filter(Boolean);
          proxyUsed = { source: `request.proxies:${proxyList.length}` };
        } else if (Array.isArray(body.proxyEntries) && body.proxyEntries.length) {
          proxyList = body.proxyEntries.map((e) => String(e || "").trim()).filter(Boolean);
          proxyUsed = { source: `request.proxyEntries:${proxyList.length}` };
        } else if (body.proxyGroupId || body.proxyGroupName) {
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
            }
          } catch (e) {
            proxyUsed = {
              source: "group:error",
              host: e instanceof Error ? e.message : undefined,
            };
          }
        } else if (body.useProxy === true) {
          // Fly loads executor/resi.proxies (or PROXY_RESI_LIST).
          forwardUseProxy = true;
          proxyUsed = { source: "fly:useProxy" };
        }
        // Defensive: strip any path the user accidentally pasted (e.g. /health)
        // so EXECUTOR_URL always resolves to the origin.
        let origin = url.trim();
        try {
          origin = new URL(origin).origin;
        } catch {
          origin = origin.replace(/\/+$/, "");
        }
        // Card ONLY when explicitly requested. Default cart smokes must not
        // attach KMART_CARD_* — adapter still runs Paydock/3DS whenever a card
        // is present (even dryRun), which hits Revolut approve/reject. Agents
        // timed out at 120s and missed those timelines (pulse-d / Jul 20).
        const number = process.env.KMART_CARD_NUMBER;
        const cvv = process.env.KMART_CARD_CVV;
        const expMonth = process.env.KMART_CARD_EXPIRY_MONTH;
        const expYear = process.env.KMART_CARD_EXPIRY_YEAR;
        const holder = process.env.KMART_CARD_HOLDER;
        const wantCard = body.placeOrder === true || body.withCard === true;
        const card =
          wantCard && number && cvv && expMonth && expYear && holder
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
              body: JSON.stringify({
                url: target,
                proxy,
                proxies: proxyList ?? undefined,
                useProxy: forwardUseProxy || undefined,
              }),
            });
            const data = await res.json().catch(() => ({}));
            return Response.json({
              ok: res.ok,
              status: res.status,
              elapsedMs: Date.now() - t0,
              result: data,
              usedProxy: Boolean(proxy || proxyList || forwardUseProxy),
              proxyUsed,
            });
          }
          if (!body.storeUrl) {
            return Response.json({ ok: false, error: "storeUrl required" }, { status: 400 });
          }
          const placeOrder = body.placeOrder === true;
          const payload = {
            taskId: body.taskId ?? `smoke-${Date.now()}`,
            storeUrl: body.storeUrl,
            variantId: body.variantId ?? 1,
            qty: 1,
            dryRun: placeOrder ? false : (body.dryRun ?? true),
            placeOrder,
            proxy,
            proxies: proxyList ?? undefined,
            useProxy: forwardUseProxy || undefined,
            ...(card ? { card } : {}),
            ...(typeof body.transport === "string" ? { transport: body.transport } : {}),
            ...(body.forceTls === true ? { forceTls: true } : {}),
            ...(body.forceUndici === true ? { forceUndici: true } : {}),
            ...(body.apiTls === true ? { apiTls: true } : {}),
            ...(typeof body.kmartMode === "string" ? { kmartMode: body.kmartMode } : {}),
            ...(body.gqlBearer === true ? { gqlBearer: true } : {}),
          };
          const res = await fetch(`${origin}/run`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = (await res.json().catch(() => ({}))) as {
            steps?: Array<{ note?: string; step?: string; ok?: boolean; status?: number | null; ms?: number }>;
            error?: string;
            failedStep?: string;
            ok?: boolean;
            checkoutStage?: string;
            orderNumber?: string | null;
            paymentStatus?: string | null;
            paymentSummary?: unknown;
            dryRun?: boolean;
          };
          // Hard-trim step notes and only return tiny shape so steps survive tool truncation.
          const compactSteps = Array.isArray(data?.steps)
            ? data.steps.map((s) => ({ s: s.step, o: s.ok, c: s.status ?? null, m: s.ms, n: typeof s.note === "string" ? (s.note.length > 5000 ? s.note.slice(0, 5000) + `…(+${s.note.length - 5000})` : s.note) : undefined }))
            : [];
          const stepNames = compactSteps.map((s) => s.s).filter(Boolean) as string[];
          const reached3ds = stepNames.some((n) => /create_3ds|paydock_3ds|chargeAuth/i.test(n));
          const cartGet = compactSteps.find((s) => s.s === "cart_get");
          return Response.json({
            ok: res.ok,
            status: res.status,
            elapsedMs: Date.now() - t0,
            run: {
              ok: data.ok,
              err: data.error,
              fs: data.failedStep,
              stage: data.checkoutStage ?? null,
              order: data.orderNumber ?? null,
              payment: data.paymentStatus ?? null,
              pay: data.paymentSummary ?? null,
              dryRun: data.dryRun ?? !placeOrder,
              cartGet: cartGet ? { ok: cartGet.o, status: cartGet.c, n: cartGet.n } : null,
              reached3ds,
              steps: compactSteps,
            },
            cardSent: Boolean(card),
            proxyUsed,
          });
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
