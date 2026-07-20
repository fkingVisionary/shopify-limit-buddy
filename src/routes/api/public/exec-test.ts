// Internal smoke-test endpoint for the Fly executor.
// Public path purely so the agent can curl it during setup;
// callers must still know the storeUrl to test.
import { createFileRoute } from "@tanstack/react-router";

type Step = {
  note?: string;
  step?: string;
  ok?: boolean;
  status?: number | null;
  ms?: number;
};

type RunBody = {
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
  /** Force skip card even when KMART_CARD_* secrets exist. */
  noCard?: boolean;
  /** Inject KMART_CARD_* when present (also implied by placeOrder). */
  withCard?: boolean;
  placeOrder?: boolean;
  /** Opt-in executor experiments (forwarded to Fly /run). */
  transport?: string;
  forceTls?: boolean;
  forceUndici?: boolean;
  /** Opt-in chrome_131 handoff for api.* (default off — native TLS 502s on Fly). */
  apiTls?: boolean;
  kmartMode?: string;
  gqlBearer?: boolean;
  /** Skip /category hop (home→PDP). Default on proxy in executor; force here. */
  skipCategory?: boolean;
};

function cartGetOk(steps: Step[] | undefined): boolean {
  const s = (steps || []).find((x) => x?.step === "cart_get");
  if (!s?.ok) return false;
  if (s.status != null && s.status !== 200) return false;
  return !/all_denied|Access Denied|AkamaiGHost/i.test(String(s.note || ""));
}

function furthestStage(data: {
  milestone?: { stage?: string | null; reached3ds?: boolean } | null;
  checkoutStage?: string | null;
  orderNumber?: string | null;
  steps?: Step[];
}): string | null {
  if (data.orderNumber) return "ordered";
  if (data.milestone?.stage) return data.milestone.stage;
  if (data.checkoutStage) return data.checkoutStage;
  const steps = data.steps || [];
  if (steps.some((s) => /^paydock_3ds|create_3ds/i.test(String(s?.step || "")))) return "3ds";
  if (steps.some((s) => s?.step === "paydock_tokenize" && s.ok)) return "tokenize";
  if (steps.some((s) => s?.step === "cart_atc" && s.ok)) return "cart_atc";
  if (cartGetOk(steps)) return "cart_get";
  return null;
}

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
        const body = (await request.json().catch(() => ({}))) as RunBody;
        const mode = body.mode ?? "run";
        // Resolve proxy: explicit proxyUrl wins; else proxies[]/proxyEntries[];
        // else an *explicit* supabase group id/name; else Fly resi.proxies via
        // useProxy:true.
        //
        // Do NOT default to "Test Pool" — WealthProxies / IPFist subs are dead.
        // Do NOT force Lovable's PROXY_URL_RESI (shadows the executor pool).
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
          const groupName = body.proxyGroupName;
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const q = supabaseAdmin.from("proxy_groups").select("id,name,proxies").limit(1);
            const { data: groups } = body.proxyGroupId
              ? await q.eq("id", body.proxyGroupId)
              : await q.eq("name", String(groupName));
            const group = groups?.[0];
            const list = (group?.proxies ?? []) as string[];
            if (list.length > 0) {
              const raw = list[Math.floor(Math.random() * list.length)];
              const parts = raw.split(":");
              if (parts.length >= 4) {
                const [host, port, user, ...passParts] = parts;
                const pass = passParts.join(":");
                proxy = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
                proxyUsed = { source: `group:${group?.name}`, host };
              } else {
                proxy = raw;
                proxyUsed = { source: `group:${group?.name}` };
              }
            } else {
              proxyUsed = { source: `group:${groupName || body.proxyGroupId}:empty` };
            }
          } catch (e) {
            proxyUsed = {
              source: "group:error",
              host: e instanceof Error ? e.message : undefined,
            };
          }
        } else if (body.useProxy === true) {
          // Fly loads executor/resi.proxies (static AU ISP pool) or PROXY_RESI_LIST.
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
        // Card only when explicitly requested — auto-inject caused Revolut 3DS
        // pings on every smoke while agents timed out and scored "cart dead."
        const wantCard = body.withCard === true || body.placeOrder === true;
        let card: {
          number: string;
          cvv: string;
          expMonth: string;
          expYear: string;
          holder: string;
        } | null = null;
        if (wantCard) {
          const number = process.env.KMART_CARD_NUMBER;
          const cvv = process.env.KMART_CARD_CVV;
          const expMonth = process.env.KMART_CARD_EXPIRY_MONTH;
          const expYear = process.env.KMART_CARD_EXPIRY_YEAR;
          const holder = process.env.KMART_CARD_HOLDER;
          if (number && cvv && expMonth && expYear && holder) {
            card = { number, cvv, expMonth, expYear, holder };
          }
        }
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
          // Stable id BEFORE fetch — required to recover after CF 524 / abort.
          const taskId = body.taskId ?? `smoke-${Date.now()}`;
          // Stay under Cloudflare's ~100s Worker budget so WE can poll milestones
          // instead of the edge returning an empty 524 while Fly continues to 3DS.
          const RUN_BUDGET_MS = Math.min(
            90_000,
            Math.max(30_000, Number(process.env.EXEC_TEST_RUN_BUDGET_MS || 90_000) || 90_000),
          );
          const payload = {
            taskId,
            storeUrl: body.storeUrl,
            variantId: body.variantId ?? 1,
            qty: 1,
            dryRun: body.dryRun ?? true,
            placeOrder: body.placeOrder === true,
            proxy,
            proxies: proxyList ?? undefined,
            useProxy: forwardUseProxy || undefined,
            card,
            ...(typeof body.transport === "string" ? { transport: body.transport } : {}),
            ...(body.forceTls === true ? { forceTls: true } : {}),
            ...(body.forceUndici === true ? { forceUndici: true } : {}),
            ...(body.apiTls === true ? { apiTls: true } : {}),
            ...(typeof body.kmartMode === "string" ? { kmartMode: body.kmartMode } : {}),
            ...(body.gqlBearer === true ? { gqlBearer: true } : {}),
            ...(body.skipCategory === true ? { skipCategory: true } : {}),
            ...(body.skipCategory === false ? { skipCategory: false } : {}),
          };

          type RunData = {
            steps?: Step[];
            error?: string;
            failedStep?: string;
            ok?: boolean;
            transport?: string | null;
            proxySource?: string | null;
            gitSha?: string | null;
            taskId?: string;
            milestone?: {
              stage?: string;
              reached3ds?: boolean;
              cartGet?: boolean;
              paymentStatus?: string | null;
              orderNumber?: string | null;
            } | null;
            checkoutStage?: string | null;
            paymentStatus?: string | null;
            paymentSummary?: Record<string, unknown> | null;
            orderNumber?: string | null;
            orderId?: string | null;
          };

          const pollMilestones = async () => {
            try {
              const qs = new URLSearchParams({
                limit: "20",
                minStage: "tokenize",
                taskId,
              });
              const mRes = await fetch(`${origin}/milestones?${qs}`, {
                headers: { authorization: `Bearer ${token}` },
              });
              const mData = (await mRes.json().catch(() => ({}))) as {
                milestones?: Array<{
                  stage?: string;
                  reached3ds?: boolean;
                  paymentStatus?: string | null;
                  orderNumber?: string | null;
                  transport?: string | null;
                  gitSha?: string | null;
                  live?: boolean;
                }>;
                gitSha?: string | null;
              };
              const rows = Array.isArray(mData.milestones) ? mData.milestones : [];
              // Prefer furthest stage for this taskId.
              const rank: Record<string, number> = {
                cart_get: 10,
                cart_atc: 20,
                tokenize: 40,
                "3ds": 50,
                place_order: 60,
                ordered: 70,
              };
              let best = rows[0] || null;
              for (const r of rows) {
                if ((rank[String(r?.stage)] || 0) > (rank[String(best?.stage)] || 0)) best = r;
              }
              return { best, gitSha: mData.gitSha ?? best?.gitSha ?? null, rows };
            } catch {
              return { best: null, gitSha: null, rows: [] as unknown[] };
            }
          };

          const pack = (opts: {
            resOk: boolean;
            status: number;
            data: RunData;
            timedOut?: boolean;
            recoveredFromMilestones?: boolean;
          }) => {
            const data = opts.data;
            const compactSteps = Array.isArray(data?.steps)
              ? data.steps.map((s) => ({
                  s: s.step,
                  o: s.ok,
                  c: s.status ?? null,
                  m: s.ms,
                  n:
                    typeof s.note === "string"
                      ? s.note.length > 5000
                        ? s.note.slice(0, 5000) + `…(+${s.note.length - 5000})`
                        : s.note
                      : undefined,
                }))
              : [];
            const stage = furthestStage(data);
            const cartGet = cartGetOk(data.steps);
            const reached3ds = Boolean(
              data.milestone?.reached3ds ||
                stage === "3ds" ||
                stage === "place_order" ||
                stage === "ordered" ||
                (data.steps || []).some((s) => /^paydock_3ds|create_3ds/i.test(String(s?.step || ""))),
            );
            return Response.json({
              ok: opts.resOk,
              status: opts.status,
              elapsedMs: Date.now() - t0,
              timedOut: Boolean(opts.timedOut),
              recoveredFromMilestones: Boolean(opts.recoveredFromMilestones),
              taskId,
              tip: opts.timedOut
                ? "Fly may still be running — poll /api/public/exec-milestones?taskId=… (bank ping > failedStep)"
                : undefined,
              run: {
                ok: data.ok,
                err: data.error,
                fs: data.failedStep,
                stage,
                cartGet,
                reached3ds,
                checkoutStage: data.checkoutStage ?? null,
                paymentStatus: data.paymentStatus ?? data.milestone?.paymentStatus ?? null,
                orderNumber: data.orderNumber ?? data.milestone?.orderNumber ?? null,
                orderId: data.orderId ?? null,
                transport: data.transport ?? null,
                proxySource: data.proxySource ?? null,
                gitSha: data.gitSha ?? null,
                milestone: data.milestone ?? null,
                steps: compactSteps,
              },
              cardSent: Boolean(card),
              proxyUsed,
            });
          };

          try {
            const res = await fetch(`${origin}/run`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(RUN_BUDGET_MS),
            });
            const data = (await res.json().catch(() => ({}))) as RunData;
            return pack({ resOk: res.ok, status: res.status, data });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const timedOut = /TimeoutError|aborted|The operation was aborted/i.test(msg);
            if (!timedOut) {
              return Response.json(
                { ok: false, error: msg, elapsedMs: Date.now() - t0, taskId, cardSent: Boolean(card), proxyUsed },
                { status: 502 },
              );
            }
            // Give Fly a moment to flush live 3DS milestone, then recover.
            await new Promise((r) => setTimeout(r, 2500));
            let polled = await pollMilestones();
            if (!polled.best?.reached3ds && !polled.best?.orderNumber) {
              await new Promise((r) => setTimeout(r, 5000));
              polled = await pollMilestones();
            }
            const best = polled.best;
            return pack({
              resOk: false,
              status: 504,
              timedOut: true,
              recoveredFromMilestones: Boolean(best),
              data: {
                ok: false,
                error: `run budget ${RUN_BUDGET_MS}ms exceeded (Fly may still be in 3DS)`,
                failedStep: "client_timeout",
                transport: best?.transport ?? null,
                gitSha: polled.gitSha,
                milestone: best
                  ? {
                      stage: best.stage,
                      reached3ds: best.reached3ds,
                      paymentStatus: best.paymentStatus ?? null,
                      orderNumber: best.orderNumber ?? null,
                    }
                  : null,
                checkoutStage: best?.stage ?? null,
                paymentStatus: best?.paymentStatus ?? null,
                orderNumber: best?.orderNumber ?? null,
                steps: [],
              },
            });
          }
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
