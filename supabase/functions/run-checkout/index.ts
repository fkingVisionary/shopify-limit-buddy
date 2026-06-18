// Long-running headless checkout worker.
// Invoked fire-and-forget from `enqueueCheckout` server fn with a job id.
// Pulls the job row, drives Browserless /function (up to ~90s), and
// writes status/stage/result back so the client can poll.
//
// Auth: x-executor-token must match EXECUTOR_TOKEN env (shared with the
// server fn that enqueues). No public callers.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BROWSERLESS_KEY = Deno.env.get("BROWSERLESS_API_KEY") ?? "";
const EXECUTOR_TOKEN = Deno.env.get("EXECUTOR_TOKEN") ?? "";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-executor-token, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

// Self-contained checkout script shipped to Browserless /function.
// Mirrors src/lib/browserless.functions.ts browserlessScript().
function checkoutScriptSource() {
  return `export default async ({ page, context }) => {
    const { input, stageUrl } = context;
    const steps = [];
    let lastStep = "launch";
    const log = (s, ok, note) => { steps.push({ step: s, t: Date.now(), ok, note }); };
    const stage = async (label) => {
      try { await fetch(stageUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: label }) }); } catch {}
    };
    const fail = async (msg) => {
      let shot = null;
      try { shot = await page.screenshot({ encoding: "base64", fullPage: false }); } catch {}
      return { ok: false, failedStep: lastStep, error: msg, steps, screenshotB64: shot };
    };
    try {
      await stage("launch");
      lastStep = "cart_add";
      await page.goto(input.storeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await stage("cart_add");
      const atc = await page.evaluate(async (variantId, qty) => {
        const r = await fetch("/cart/add.js", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ id: variantId, quantity: qty }),
          credentials: "include",
        });
        return { status: r.status, body: await r.text().catch(() => "") };
      }, input.variantId, input.qty);
      if (atc.status >= 400) return await fail("cart/add.js " + atc.status + ": " + atc.body.slice(0, 200));
      log("cart_add", true);

      lastStep = "checkout_load";
      await stage("checkout_load");
      const origin = new URL(input.storeUrl).origin;
      const qs = new URLSearchParams({
        "checkout[email]": input.profile.email,
        "checkout[shipping_address][first_name]": input.profile.first_name,
        "checkout[shipping_address][last_name]": input.profile.last_name,
        "checkout[shipping_address][address1]": input.profile.address1,
        "checkout[shipping_address][address2]": input.profile.address2 ?? "",
        "checkout[shipping_address][city]": input.profile.city,
        "checkout[shipping_address][province]": input.profile.province,
        "checkout[shipping_address][zip]": input.profile.zip,
        "checkout[shipping_address][country]": input.profile.country,
        "checkout[shipping_address][phone]": input.profile.phone,
      });
      await page.goto(origin + "/checkout?" + qs.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
      log("checkout_load", true);

      const clickContinue = async () => {
        const sel = 'button[type="submit"], button#continue_button, button.step__footer__continue-btn';
        await page.waitForSelector(sel, { timeout: 15000 });
        await page.click(sel);
      };

      lastStep = "shipping_continue";
      await stage("shipping_continue");
      await clickContinue();
      log("shipping_continue", true);

      lastStep = "shipping_method";
      await stage("shipping_method");
      try { await page.waitForSelector('input[name="checkout[shipping_rate][id]"]', { timeout: 15000 }); } catch {}
      log("shipping_method", true);

      lastStep = "payment_continue";
      await stage("payment_continue");
      await clickContinue();
      log("payment_continue", true);

      lastStep = "card_fill";
      await stage("card_fill");
      await page.waitForTimeout(2500);
      const frames = page.frames();
      const setIn = async (namePart, value) => {
        for (const f of frames) {
          try {
            const el = await f.$('input[name*="' + namePart + '"]');
            if (el) { await el.type(value, { delay: 25 }); return true; }
          } catch {}
        }
        return false;
      };
      await setIn("number", input.card.number);
      await setIn("name", input.card.name);
      await setIn("expiry", input.card.exp_month.padStart(2, "0") + " / " + input.card.exp_year.slice(-2));
      await setIn("verification_value", input.card.cvv);
      log("card_fill", true);

      if (input.captchaToken) {
        lastStep = "captcha_inject";
        await stage("captcha_inject");
        await page.evaluate((tok) => {
          const set = (name) => {
            let el = document.querySelector('[name="' + name + '"]');
            if (!el) {
              el = document.createElement("textarea");
              el.name = name;
              el.style.display = "none";
              document.body.appendChild(el);
            }
            el.value = tok;
          };
          set("cf-turnstile-response");
          set("g-recaptcha-response");
          set("h-captcha-response");
        }, input.captchaToken);
        log("captcha_inject", true);
      }

      if (input.dryRun) {
        await stage("dry_run_done");
        const shot = await page.screenshot({ encoding: "base64", fullPage: false });
        return { ok: true, orderId: null, finalUrl: page.url(), steps, screenshotB64: shot, dryRun: true };
      }

      lastStep = "submit";
      await stage("submit");
      await clickContinue();
      log("submit", true);

      lastStep = "confirm";
      await stage("confirm");
      await page.waitForFunction(
        () => /\\/thank_you|orders\\/|checkouts\\/.+\\/thank/i.test(location.href),
        { timeout: 25000 },
      );
      const finalUrl = page.url();
      const m = finalUrl.match(/orders\\/(\\d+)|checkouts\\/[^/]+\\/([a-z0-9]+)\\/thank_you/i);
      const orderId = m ? (m[1] ?? m[2] ?? null) : null;
      const shot = await page.screenshot({ encoding: "base64", fullPage: false });
      log("confirm", true, orderId ?? finalUrl);
      return { ok: true, orderId, finalUrl, steps, screenshotB64: shot, dryRun: false };
    } catch (e) {
      return await fail(e?.message ?? String(e));
    }
  };`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const token = req.headers.get("x-executor-token");
  if (!EXECUTOR_TOKEN || token !== EXECUTOR_TOKEN) {
    return new Response("Unauthorized", { status: 401, headers: cors });
  }

  let body: { jobId?: string } = {};
  try { body = await req.json(); } catch {}
  const jobId = body.jobId;
  if (!jobId) return new Response("missing jobId", { status: 400, headers: cors });

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: job, error: jobErr } = await supa
    .from("checkout_jobs").select("*").eq("id", jobId).maybeSingle();
  if (jobErr || !job) {
    return new Response("job not found", { status: 404, headers: cors });
  }
  if (job.status !== "pending") {
    return new Response(JSON.stringify({ ok: true, note: "already " + job.status }), { headers: { ...cors, "content-type": "application/json" } });
  }

  await supa.from("checkout_jobs").update({ status: "running", stage: "launch" }).eq("id", jobId);

  if (!BROWSERLESS_KEY) {
    await supa.from("checkout_jobs").update({
      status: "failed", stage: "transport", error: "BROWSERLESS_API_KEY missing on server",
    }).eq("id", jobId);
    return new Response("no browserless key", { status: 500, headers: cors });
  }

  // Stage callback URL — same edge function, action=stage.
  const selfUrl = new URL(req.url);
  selfUrl.searchParams.set("action", "stage");
  selfUrl.searchParams.set("jobId", jobId);

  // Handle stage callbacks on the same function for simplicity.
  if (req.headers.get("x-stage-callback") === "1") {
    let s: { stage?: string } = {};
    try { s = await req.json(); } catch {}
    if (s.stage) await supa.from("checkout_jobs").update({ stage: s.stage }).eq("id", jobId);
    return new Response("ok", { headers: cors });
  }

  const input = job.input as any;
  const url = new URL("https://production-sfo.browserless.io/function");
  url.searchParams.set("token", BROWSERLESS_KEY);
  if (input.proxy) {
    url.searchParams.set("proxy", "http://" + input.proxy);
    url.searchParams.set("proxySticky", "true");
  }
  url.searchParams.set("timeout", "90000");

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: checkoutScriptSource(),
        context: {
          input,
          stageUrl: selfUrl.toString(),
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await supa.from("checkout_jobs").update({
        status: "failed", stage: "transport", error: "Browserless HTTP " + res.status + ": " + text.slice(0, 400),
      }).eq("id", jobId);
      return new Response("browserless error", { status: 502, headers: cors });
    }
    const result = await res.json().catch(() => null);
    if (!result || typeof result !== "object") {
      await supa.from("checkout_jobs").update({
        status: "failed", stage: "transport", error: "Browserless returned non-JSON",
      }).eq("id", jobId);
      return new Response("bad json", { status: 502, headers: cors });
    }
    await supa.from("checkout_jobs").update({
      status: result.ok ? "succeeded" : "failed",
      stage: result.ok ? (result.dryRun ? "dry_run_done" : "confirm") : (result.failedStep ?? "unknown"),
      result,
      error: result.ok ? null : (result.error ?? "unknown"),
    }).eq("id", jobId);
    return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    await supa.from("checkout_jobs").update({
      status: "failed", stage: "transport", error: "transport: " + (e instanceof Error ? e.message : String(e)),
    }).eq("id", jobId);
    return new Response("transport error", { status: 500, headers: cors });
  }
});
