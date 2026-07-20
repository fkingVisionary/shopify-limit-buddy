// Checkout chain entry point.
//
// Routing: pick a retailer adapter by hostname. Kmart AU goes through the
// Hyper-backed Akamai chain. Anything without a dedicated adapter falls back
// to the legacy generic-Shopify dry-run (homepage → cart/add → /cart →
// checkout page) so existing Shopify recon flows keep working.
//
// Playwright (`kmartMode: "playwright"`) is research/testing only — never wire
// it as an automatic production fallback. The bot utility path is HTTP/undici.

import { makeDispatcher, createJar, request, ensureStickyProxySession } from "./http.js";
import { pickAdapter } from "./adapters/index.js";
import { kmartPlaywrightAdapter } from "./adapters/kmart-playwright.js";
import { markTaskDone, setTaskProgress, stageForStep, stageMeta, stageRank } from "./progress.js";

const now = () => Date.now();

function step(steps, name, ok, status, ms, note) {
  steps.push({ step: name, ok, status, ms, note });
}

function wireProgress(ctx, taskId) {
  let lastRank = -1;
  ctx.onProgress = (stageOrStep, detail = null) => {
    const known = WORKFLOW_STAGE_IDS.has(stageOrStep) ? stageOrStep : stageForStep(stageOrStep);
    if (!known) return;
    const rank = stageRank(known);
    if (rank < lastRank) return;
    lastRank = rank;
    const meta = stageMeta(known);
    setTaskProgress(taskId, {
      stage: known,
      label: meta.label,
      hint: meta.hint,
      detail: detail || null,
      step: typeof stageOrStep === "string" && stageOrStep !== known ? stageOrStep : null,
      running: true,
      done: false,
    });
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
  // Rotating gateway resi (e.g. IP Fist without -sid-) must be pinned per task
  // or the exit IP changes after WWW solve and api GraphQL 403s.
  const stickyPin = ensureStickyProxySession(task.proxy);
  const proxyForTask = stickyPin.proxy;
  const dispatcher = makeDispatcher(proxyForTask, { forceTls, forceUndici });
  const ctx = { dispatcher, jar };
  // Adapter logs + sticky detection see the pinned URL.
  task = { ...task, proxy: proxyForTask, proxyStickyPin: stickyPin };

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
    // Adapter may swap ctx.dispatcher (WWW undici → api chrome_131 handoff).
    try { await ctx.dispatcher?.close?.(); } catch { /* ignore */ }
    try { await ctx._wwwDispatcher?.close?.(); } catch { /* ignore */ }
  };

  // Playwright is opt-in research only (`kmartMode: "playwright"`). Never auto-
  // escalate production HTTP failures into Chromium — not viable at scale.
  const wantPlaywright =
    task.kmartMode === "playwright" && kmartPlaywrightAdapter.matches(new URL(store).hostname.toLowerCase());
  const adapter = wantPlaywright ? kmartPlaywrightAdapter : pickAdapter(store);
  if (adapter) {
    // Expose a shared steps array so the catch path can return partial
    // progress instead of swallowing it.
    ctx.steps = [];
    wireProgress(ctx, task.taskId);
    try {
      const out = await adapter.run(task, ctx);
      markTaskDone(task.taskId, {
        ok: Boolean(out.ok),
        orderNumber: out.orderNumber ?? null,
        detail: out.checkoutStage ?? null,
      });
      return {
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
    } catch (e) {
      markTaskDone(task.taskId, { ok: false, detail: e?.message ?? String(e) });
      return {
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
      };
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
      const addUrl = `${store}/cart/add.js`;
      const res = await request(
        addUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ items: [{ id: Number(task.variantId), quantity: task.qty || 1 }] }),
        },
        ctx,
      );
      const text = await res.text();
      lastUrl = addUrl;
      return { status: res.status, note: text.slice(0, 200), ok: res.status < 400 };
    });

    await tryStep("cart_get", async () => {
      const res = await request(`${store}/cart.js`, { method: "GET", headers: { accept: "application/json" } }, ctx);
      const text = await res.text();
      lastUrl = `${store}/cart.js`;
      return { status: res.status, note: text.slice(0, 200) };
    });

    await tryStep("checkout_page", async () => {
      const res = await request(`${store}/checkout`, { method: "GET" }, ctx);
      const body = await res.text();
      lastUrl = res.url || `${store}/checkout`;
      return { status: res.status, note: `${body.length}b, final=${lastUrl}` };
    });

    markTaskDone(task.taskId, { ok: true });
    return {
      ok: true,
      taskId: task.taskId,
      adapter: "generic-shopify",
      elapsedMs: now() - t0,
      transport: dispatcher.transport,
      steps,
      finalUrl: lastUrl,
      cookies: jar.dump(),
      dryRun: true,
    };
  } catch (e) {
    markTaskDone(task.taskId, { ok: false, detail: e?.message ?? String(e) });
    return {
      ok: false,
      taskId: task.taskId,
      adapter: "generic-shopify",
      error: e?.message ?? String(e),
      elapsedMs: now() - t0,
      transport: dispatcher.transport,
      steps,
      finalUrl: lastUrl,
      cookies: jar.dump(),
    };
  } finally {
    await closeDispatcher();
  }
}
