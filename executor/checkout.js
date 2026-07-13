// Checkout chain entry point.
//
// Routing: pick a retailer adapter by hostname. Kmart AU goes through the
// Hyper-backed Akamai chain. Anything without a dedicated adapter falls back
// to the legacy generic-Shopify dry-run (homepage → cart/add → /cart →
// checkout page) so existing Shopify recon flows keep working.

import { makeDispatcher, createJar, request } from "./http.js";
import { pickAdapter } from "./adapters/index.js";
import { kmartPlaywrightAdapter } from "./adapters/kmart-playwright.js";

const now = () => Date.now();

function step(steps, name, ok, status, ms, note) {
  steps.push({ step: name, ok, status, ms, note });
}

export async function runCheckout(task) {
  const t0 = now();
  const jar = createJar();
  const store = task.storeUrl.replace(/\/$/, "");
  // Keep the native TLS client opt-in. It is useful for Akamai experiments, but
  // a native failure can terminate the process and surface as an empty 502.
  const requestedTransport = typeof task.transport === "string" ? task.transport.toLowerCase() : null;
  const forceUndici = task.forceUndici === true || requestedTransport === "undici";
  // Hyper docs: Akamai needs a Chrome-matching TLS client. Dashboard should
  // send transport=tls when a proxy is set, but older Railway builds still
  // arrive as undici. For Kmart + proxy, prefer TLS unless explicitly forced
  // to undici (native TLS crashes → empty 502 are still possible — use
  // forceUndici / transport=undici to roll back).
  const isKmart = /kmart\.com\.au/i.test(store);
  const forceTls =
    task.forceTls === true ||
    requestedTransport === "tls" ||
    (isKmart && Boolean(task.proxy) && requestedTransport !== "undici");
  const dispatcher = makeDispatcher(task.proxy, { forceTls, forceUndici });
  const ctx = { dispatcher, jar };

  const closeDispatcher = async () => {
    try { await dispatcher?.close?.(); } catch { /* ignore */ }
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
    try {
      const out = await adapter.run(task, ctx);
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
      };
    } catch (e) {
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
