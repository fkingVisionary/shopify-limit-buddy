// Checkout chain entry point.
//
// Routing: pick a retailer adapter by hostname. Kmart AU goes through the
// Hyper-backed Akamai chain. Anything without a dedicated adapter falls back
// to the legacy generic-Shopify dry-run (homepage → cart/add → /cart →
// checkout page) so existing Shopify recon flows keep working.

import { makeDispatcher, makeRemoteTlsDispatcher, createJar, request } from "./http.js";
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
  const host = (() => {
    try {
      return new URL(store).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const isKmart = host === "kmart.com.au" || host.endsWith(".kmart.com.au");

  // Transport selection (Hyper docs: browser TLS required for reliable _abck).
  // - forceUndici / transport=undici → undici only (known-good escape hatch)
  // - forceTls / transport=tls → in-process chrome_131 (opt-in experiment; can 502)
  // - Kmart default → child-process chrome_131 (crash-isolated); undici if init fails
  // - Playwright stays opt-in only (kmartMode=playwright)
  const requestedTransport = typeof task.transport === "string" ? task.transport.toLowerCase() : null;
  const forceUndici = task.forceUndici === true || requestedTransport === "undici";
  const forceTls = task.forceTls === true || requestedTransport === "tls";
  const tlsWorkerOff =
    task.tlsWorker === false ||
    process.env.KMART_TLS_WORKER === "0" ||
    process.env.KMART_TLS_WORKER === "false";

  let dispatcher = null;
  let transportSelectNote = null;

  if (forceUndici) {
    dispatcher = makeDispatcher(task.proxy, { forceUndici: true });
    transportSelectNote = "undici (forced)";
  } else if (forceTls) {
    dispatcher = makeDispatcher(task.proxy, { forceTls: true });
    transportSelectNote = "tls in-process chrome_131 (forced — not crash-isolated)";
  } else if (isKmart && !tlsWorkerOff) {
    try {
      dispatcher = await makeRemoteTlsDispatcher(task.proxy);
      transportSelectNote = "tls-worker chrome_131 (Hyper TLS-first; crash-isolated)";
    } catch (e) {
      dispatcher = makeDispatcher(task.proxy, { forceUndici: true });
      // Include stdout/stderr tail from bridge — native .so download failures
      // previously looked like a silent "exited code=1".
      transportSelectNote = `tls-worker init failed → undici fallback: ${e?.message ?? String(e)}`.slice(0, 400);
    }
  } else {
    dispatcher = makeDispatcher(task.proxy, { forceTls: false, forceUndici: false });
    transportSelectNote = `undici (default non-kmart or KMART_TLS_WORKER=0)`;
  }

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
    task.kmartMode === "playwright" && kmartPlaywrightAdapter.matches(host);
  const adapter = wantPlaywright ? kmartPlaywrightAdapter : pickAdapter(store);
  if (adapter) {
    // Expose a shared steps array so the catch path can return partial
    // progress instead of swallowing it.
    ctx.steps = [];
    if (transportSelectNote) {
      ctx.steps.push({
        step: "transport_select",
        ok: !/failed → undici/i.test(transportSelectNote),
        note: transportSelectNote,
      });
    }
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
      const activeTransport = ctx.dispatcher?.transport ?? dispatcher.transport;
      const result = {
        ok: out.ok,
        taskId: task.taskId,
        adapter: adapter.id,
        elapsedMs: now() - t0,
        transport: activeTransport,
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
        proxy: Boolean(ctx.dispatcher?.proxy ?? dispatcher.proxy),
        transport: activeTransport,
      });
      return result;
    } catch (e) {
      markTaskDone(task.taskId, { ok: false, detail: e?.message ?? String(e) });
      const activeTransport = ctx.dispatcher?.transport ?? dispatcher.transport;
      const partial = {
        ok: false,
        taskId: task.taskId,
        adapter: adapter.id,
        error: e?.message ?? String(e),
        failedStep: e?.code ?? "adapter_error",
        elapsedMs: now() - t0,
        transport: activeTransport,
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
        proxy: Boolean(ctx.dispatcher?.proxy ?? dispatcher.proxy),
        transport: activeTransport,
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
