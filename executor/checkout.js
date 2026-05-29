// Checkout chain — runs on Node (not Cloudflare Workers) so we can attach
// a real residential proxy to every outbound request via undici's ProxyAgent.
//
// This is the dry-run validator: it exercises the proxy path end-to-end
// (homepage warm → cart/add → /cart → checkout page) and reports a full
// per-step timeline so the control plane can diagnose where things break.
// The full GraphQL SubmitForCompletion + 2Captcha logic from
// src/lib/checkout-one-graphql.functions.ts should be ported in once this
// is validated against a real store.

import { makeDispatcher, createJar, request } from "./http.js";

const now = () => Date.now();

function step(steps, name, ok, status, ms, note) {
  const r = { step: name, ok, status, ms, note };
  steps.push(r);
  return r;
}

export async function runCheckout(task) {
  const t0 = now();
  const steps = [];
  const jar = createJar();
  const dispatcher = makeDispatcher(task.proxy);
  const ctx = { dispatcher, jar };
  const store = task.storeUrl.replace(/\/$/, "");
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
    // 1. Warm cookies
    await tryStep("warm_home", async () => {
      const res = await request(store + "/", { method: "GET" }, ctx);
      const body = await res.text();
      return { status: res.status, note: `${body.length}b body, jar=${Object.keys(jar.dump()).length} cookies` };
    });

    // 2. cart/add.js
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

    // 3. POST /cart → 302 to /checkouts/cn/{token}
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

    // 4. GET checkout page — this is where Cloudflare/Akamai usually slam the door
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

    if (task.dryRun) {
      return {
        ok: true,
        taskId: task.taskId,
        elapsedMs: now() - t0,
        steps,
        finalUrl: lastUrl,
        dryRun: true,
        cookies: jar.dump(),
      };
    }

    // Real submission would continue here: card vault POST + GraphQL
    // SubmitForCompletion + PollForReceipt. Not yet ported.
    return {
      ok: false,
      taskId: task.taskId,
      failedStep: "submit_for_completion",
      error: "Real submission not yet ported to executor; use dryRun:true",
      elapsedMs: now() - t0,
      steps,
    };
  } catch (e) {
    return {
      ok: false,
      taskId: task.taskId,
      error: e?.message ?? String(e),
      failedStep: steps[steps.length - 1]?.step ?? "unknown",
      elapsedMs: now() - t0,
      steps,
    };
  }
}
