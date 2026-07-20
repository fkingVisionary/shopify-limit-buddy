// Checkout chain entry point.
//
// Routing: pick a retailer adapter by hostname. Kmart AU goes through the
// Hyper-backed Akamai chain. Anything without a dedicated adapter falls back
// to the legacy generic-Shopify dry-run (homepage → cart/add → /cart →
// checkout page) so existing Shopify recon flows keep working.

import { makeDispatcher, createJar, request } from "./http.js";
import { pickAdapter } from "./adapters/index.js";
import { kmartPlaywrightAdapter } from "./adapters/kmart-playwright.js";
import { markTaskDone, setTaskProgress, stageForStep, stageMeta, stageRank } from "./progress.js";
import { noteLiveMilestone, recordRunMilestone } from "./run-milestones.js";

const now = () => Date.now();

function step(steps, name, ok, status, ms, note) {
  steps.push({ step: name, ok, status, ms, note });
}

function wireProgress(ctx, taskId, meta = {}) {
  let lastRank = -1;
  let lastMilestoneRank = -1;
  ctx.onProgress = (stageOrStep, detail = null) => {
    const known = WORKFLOW_STAGE_IDS.has(stageOrStep) ? stageOrStep : stageForStep(stageOrStep);
    if (!known) return;
    const rank = stageRank(known);
    if (rank < lastRank) return;
    lastRank = rank;
    const stageInfo = stageMeta(known);
    const stepName = typeof stageOrStep === "string" && stageOrStep !== known ? stageOrStep : null;
    setTaskProgress(taskId, {
      stage: known,
      label: stageInfo.label,
      hint: stageInfo.hint,
      detail: detail || null,
      step: stepName,
      running: true,
      done: false,
    });
    // Persist cart+ / 3DS as soon as we hit them — not only when /run returns.
    // Skip cart until a cart_* step actually succeeded (avoid logging GraphQL 403 as a win).
    if (rank >= stageRank("cart") && rank > lastMilestoneRank) {
      if (known === "cart") {
        const lastCart = [...(ctx.steps || [])]
          .reverse()
          .find((s) => /^cart_/.test(String(s?.step || "")));
        if (!lastCart?.ok || (lastCart.status != null && lastCart.status >= 400)) {
          return;
        }
      }
      lastMilestoneRank = rank;
      try {
        noteLiveMilestone(taskId, known, {
          proxy: meta.proxy,
          transport: meta.transport,
          dryRun: meta.dryRun,
          step: stepName,
        });
      } catch {
        /* never break checkout for logging */
      }
    }
  };
  setTaskProgress(taskId, {
    stage: "warm",
    label: stageMeta("warm").label,
    hint: stageMeta("warm").hint,
    running: true,
    done: false,
  });
}

const WORKFLOW_STAGE_IDS = new Set([
  "warm",
  "product",
  "cart",
  "details",
  "tokenize",
  "threeds",
  "order",
  "done",
]);

export async function runCheckout(task) {
  const t0 = now();
  const jar = createJar();
  const store = task.storeUrl.replace(/\/$/, "");
  // Keep the native TLS client opt-in. It is useful for Akamai experiments, but
  // a native failure can terminate the process and surface as an empty 502.
  const requestedTransport = typeof task.transport === "string" ? task.transport.toLowerCase() : null;
  const forceUndici = task.forceUndici === true || requestedTransport === "undici";
  // TLS is opt-in only. Auto-forcing TLS for Kmart+proxy caused empty HTTP 502s
  // (node-tls-client native crash) whenever the UI sent transport=tls with a
  // proxy. Undici is what cleared WWW Akamai through cart_create on recent runs.
  const forceTls = task.forceTls === true || requestedTransport === "tls";
  const dispatcher = makeDispatcher(task.proxy, { forceTls, forceUndici });
  const ctx = { dispatcher, jar };

  if (dispatcher.proxyParseFailed) {
    markTaskDone(task.taskId, { ok: false, detail: "proxy_parse" });
    return {
      ok: false,
      taskId: task.taskId,
      adapter: "kmart",
      error: `proxy string not recognized (len=${dispatcher.rawProxyLen}). Use http://user:pass@host:port or user:pass:host:port or host:port:user:pass`,
      failedStep: "proxy_parse",
      elapsedMs: now() - t0,
      transport: dispatcher.transport,
      steps: [{ step: "proxy_parse", ok: false, note: `rawLen=${dispatcher.rawProxyLen}` }],
      checkoutStage: "pre_cart",
    };
  }

  const closeDispatcher = async () => {
    // Adapter may swap ctx.dispatcher (tls→undici fallback); close the active one.
    try { await ctx.dispatcher?.close?.(); } catch { /* ignore */ }
  };

  // Playwright fallback lane: opt-in per-task via kmartMode="playwright".
  // Overrides hostname-based adapter picking. Runs real Chromium + Hyper's
  // Playwright handlers instead of the raw-HTTP kmart adapter.
  const wantPlaywright =
    task.kmartMode === "playwright" && kmartPlaywrightAdapter.matches(new URL(store).hostname.toLowerCase());
  const adapter = wantPlaywright ? kmartPlaywrightAdapter : pickAdapter(store);
  if (adapter) {
    // Expose a shared steps array so the catch path can return partial
    // progress instead of swallowing it.
    ctx.steps = [];
    wireProgress(ctx, task.taskId, {
      proxy: Boolean(dispatcher.proxy),
      transport: dispatcher.transport,
      dryRun: task.placeOrder !== true,
    });
    try {
      const out = await adapter.run(task, ctx);
      markTaskDone(task.taskId, {
        ok: Boolean(out.ok),
        orderNumber: out.orderNumber ?? null,
        detail: out.checkoutStage ?? null,
      });
      const result = {
        ok: out.ok,
        taskId: task.taskId,
        adapter: adapter.id,
        elapsedMs: now() - t0,
        transport: dispatcher.transport,
        steps: out.steps ?? ctx.steps,
        trace: out.trace,
        finalUrl: out.finalUrl,
        cookies: out.cookies,
        dryRun: Boolean(out.dryRun ?? task.dryRun),
        // Pass through payment/order fields — previously dropped here, which
        // made successful Revolut charges look like empty UI failures.
        checkoutStage: out.checkoutStage ?? null,
        paymentSummary: out.paymentSummary ?? null,
        paymentTail: out.paymentTail ?? null,
        lastSteps: out.lastSteps ?? null,
        failedStep: out.failedStep ?? null,
        orderNumber: out.orderNumber ?? null,
        orderId: out.orderId ?? null,
        paymentStatus: out.paymentStatus ?? null,
      };
      // Persist milestones (cart_get+ / 3DS / order) so timed-out clients still
      // leave a trail on the machine + in Fly logs.
      result.milestone = recordRunMilestone(task.taskId, result, {
        proxy: Boolean(dispatcher.proxy),
        transport: dispatcher.transport,
      });
      return result;
    } catch (e) {
      markTaskDone(task.taskId, { ok: false, detail: e?.message ?? String(e) });
      const partial = {
        ok: false,
        taskId: task.taskId,
        adapter: adapter.id,
        error: e?.message ?? String(e),
        failedStep: e?.code ?? "adapter_error",
        elapsedMs: now() - t0,
        transport: dispatcher.transport,
        steps: ctx.steps,
        trace: ctx.requestTrace,
        cookies: ctx.jar?.dump?.() ?? {},
        checkoutStage: e?.checkoutStage ?? null,
        paymentSummary: e?.paymentSummary ?? null,
        paymentStatus: e?.paymentStatus ?? null,
        orderNumber: e?.orderNumber ?? null,
      };
      // Still record if we cleared cart_get / 3DS before the throw.
      partial.milestone = recordRunMilestone(task.taskId, partial, {
        proxy: Boolean(dispatcher.proxy),
        transport: dispatcher.transport,
      });
      return partial;
    } finally {
      await closeDispatcher();
    }
  }

  // ── Legacy generic-Shopify fallback (unchanged behaviour) ──────────
  const steps = [];
  let lastUrl = store;

  const tryStep = async (name, fn) => {
    const s0 = now();
    try {
      const out = await fn();
      step(steps, name, out.ok !== false, out.status ?? null, now() - s0, out.note);
      return out;
    } catch (e) {
      step(steps, name, false, null, now() - s0, e?.message ?? String(e));
      throw e;
    }
  };

  try {
    await tryStep("warm_home", async () => {
      const res = await request(store + "/", { method: "GET" }, ctx);
      const body = await res.text();
      return { status: res.status, note: `${body.length}b body, jar=${Object.keys(jar.dump()).length} cookies` };
    });

    await tryStep("cart_add", async () => {
      const res = await request(
        store + "/cart/add.js",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            referer: store + "/",
            origin: store,
          },
          body: new URLSearchParams({ id: String(task.variantId), quantity: String(task.qty) }).toString(),
        },
        ctx,
      );
      const body = await res.text();
      if (res.status >= 400) return { ok: false, status: res.status, note: body.slice(0, 200) };
      return { status: res.status };
    });

    let checkoutUrl = null;
    await tryStep("cart_redirect", async () => {
      const res = await request(
        store + "/cart",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            referer: store + "/cart",
            origin: store,
          },
          body: new URLSearchParams({ checkout: "" }).toString(),
        },
        ctx,
      );
      const loc = res.headers.get("location");
      if (loc) {
        checkoutUrl = loc.startsWith("http") ? loc : store + loc;
        lastUrl = checkoutUrl;
      }
      return { status: res.status, note: checkoutUrl ?? "(no Location header)" };
    });

    if (checkoutUrl) {
      await tryStep("checkout_page", async () => {
        const res = await request(checkoutUrl, { method: "GET", headers: { referer: store + "/cart" } }, ctx);
        const body = await res.text();
        const isCf = /cloudflare|cf-ray|__cf_chl_/i.test(body);
        const isAk = /_abck|bm_sz|akam/i.test(body);
        return {
          ok: res.status < 400,
          status: res.status,
          note: `${body.length}b${isCf ? " cloudflare" : ""}${isAk ? " akamai" : ""}`,
        };
      });
    }

    return {
      ok: true,
      taskId: task.taskId,
      adapter: "shopify-generic-fallback",
      elapsedMs: now() - t0,
      transport: dispatcher.transport,
      steps,
      finalUrl: lastUrl,
      dryRun: true,
      cookies: jar.dump(),
    };
  } catch (e) {
    return {
      ok: false,
      taskId: task.taskId,
      adapter: "shopify-generic-fallback",
      error: e?.message ?? String(e),
      failedStep: steps[steps.length - 1]?.step ?? "unknown",
      elapsedMs: now() - t0,
      transport: dispatcher.transport,
      steps,
    };
  } finally {
    await closeDispatcher();
  }
}
