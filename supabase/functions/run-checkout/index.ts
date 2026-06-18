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

      const setCheckoutValue = async (selectors, value) => {
        if (value == null || value === "") return false;
        for (const sel of selectors) {
          try {
            const el = await page.$(sel);
            if (!el) continue;
            await el.evaluate((node, val) => {
              const tag = (node.tagName || "").toLowerCase();
              const wanted = String(val);
              node.focus();
              if (tag === "select") {
                const lower = wanted.toLowerCase();
                const options = Array.from(node.options || []);
                const match = options.find((o) => String(o.value || "").toLowerCase() === lower || String(o.textContent || "").toLowerCase().includes(lower));
                if (match) node.value = match.value;
              } else {
                const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, "value");
                if (desc && desc.set) desc.set.call(node, wanted);
                else node.value = wanted;
              }
              node.dispatchEvent(new Event("input", { bubbles: true }));
              node.dispatchEvent(new Event("change", { bubbles: true }));
              node.blur();
            }, value);
            return true;
          } catch {}
        }
        return false;
      };

      const visibleCheckoutError = async () => {
        try {
          // Only look inside Shopify's actual error containers, not body text —
          // labels like "Use shipping address as billing address" caused false positives.
          return await page.evaluate(() => {
            const sels = ['[data-error-message]', '.field__message--error', '.error-message', '[role="alert"]', '.notice--error', '.banner--error'];
            for (const s of sels) {
              const el = document.querySelector(s);
              const t = ((el && el.textContent) || "").trim();
              if (/order.?s being processed|processing/i.test(t)) continue;
              if (t) return t.slice(0, 200);
            }
            return null;
          });
        } catch { return null; }
      };

      lastStep = "address_fill";
      await stage("address_fill");
      await setCheckoutValue(['input[type="email"]', 'input[name="checkout[email]"]', 'input[name="email"]', 'input[autocomplete="email"]', '#email'], input.profile.email);
      await setCheckoutValue(['input[name="checkout[shipping_address][first_name]"]', 'input[autocomplete="given-name"]', 'input[name="firstName"]', 'input[name*="first" i]'], input.profile.first_name);
      await setCheckoutValue(['input[name="checkout[shipping_address][last_name]"]', 'input[autocomplete="family-name"]', 'input[name="lastName"]', 'input[name*="last" i]'], input.profile.last_name);
      await setCheckoutValue(['input[name="checkout[shipping_address][address1]"]', 'input[autocomplete="address-line1"]', 'input[name="address1"]', 'input[name*="address" i]'], input.profile.address1);
      await setCheckoutValue(['input[name="checkout[shipping_address][address2]"]', 'input[autocomplete="address-line2"]', 'input[name="address2"]'], input.profile.address2 ?? "");
      await setCheckoutValue(['input[name="checkout[shipping_address][city]"]', 'input[autocomplete="address-level2"]', 'input[name="city"]'], input.profile.city);
      await setCheckoutValue(['select[name="checkout[shipping_address][province]"], input[name="checkout[shipping_address][province]"]', 'select[autocomplete="address-level1"], input[autocomplete="address-level1"]', 'select[name="province"], input[name="province"]'], input.profile.province);
      await setCheckoutValue(['input[name="checkout[shipping_address][zip]"]', 'input[autocomplete="postal-code"]', 'input[name="postalCode"]', 'input[name="zip"]'], input.profile.zip);
      await setCheckoutValue(['input[name="checkout[shipping_address][phone]"]', 'input[type="tel"]', 'input[autocomplete="tel"]', 'input[name="phone"]'], input.profile.phone);
      log("address_fill", true);

      const isPaymentStep = async () => {
        try {
          const main = await page.evaluate(() => {
            const text = document.body?.innerText ?? "";
            const hasPayButton = Array.from(document.querySelectorAll('button, input[type="submit"]')).some((el) => {
              const label = ((el.tagName === "INPUT" ? el.value : el.textContent) ?? "").trim();
              return /pay now|complete order|place order/i.test(label);
            });
            return /payment/i.test(text) && hasPayButton;
          });
          if (main) return true;
          for (const f of page.frames()) {
            const card = await f.$('input[name*="number"], input[autocomplete="cc-number"], input[placeholder*="Card number" i]');
            if (card) return true;
          }
        } catch {}
        return false;
      };

      const clickContinue = async (allowPaymentSubmit = false) => {
        await page.waitForFunction(() => {
          const els = Array.from(document.querySelectorAll('button, input[type="submit"]'));
          return els.some((el) => {
            const text = ((el.tagName === "INPUT" ? el.value : el.textContent) ?? "").trim();
            const id = el.id ?? "";
            const cls = el.className?.toString?.() ?? "";
            return !/apply/i.test(text) && (/continue|pay now|complete order|place order|submit/i.test(text) || /continue_button|step__footer__continue/i.test(id + " " + cls));
          });
        }, { timeout: 15000 });
        const clicked = await page.evaluate((allowSubmit) => {
          const els = Array.from(document.querySelectorAll('button, input[type="submit"]'));
          const target = els.find((el) => {
            const text = ((el.tagName === "INPUT" ? el.value : el.textContent) ?? "").trim();
            const id = el.id ?? "";
            const cls = el.className?.toString?.() ?? "";
            if (/apply/i.test(text)) return false;
            const isSubmit = /pay now|complete order|place order|submit/i.test(text);
            if (isSubmit && !allowSubmit) return false;
            return /continue/i.test(text) || isSubmit || /continue_button|step__footer__continue/i.test(id + " " + cls);
          });
          target?.click();
          return Boolean(target);
        }, allowPaymentSubmit);
        if (!clicked) throw new Error("Could not find checkout continue button");
      };

      lastStep = "shipping_continue";
      await stage("shipping_continue");
      await clickContinue();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const contactError = await visibleCheckoutError();
      if (contactError) return await fail("Checkout validation: " + contactError);
      log("shipping_continue", true);

      lastStep = "shipping_method";
      await stage("shipping_method");
      try { await page.waitForSelector('input[name="checkout[shipping_rate][id]"], button#continue_button, button.step__footer__continue-btn', { timeout: 2000 }); } catch {}
      log("shipping_method", true);

      lastStep = "payment_continue";
      await stage("payment_continue");
      if (!(await isPaymentStep())) await clickContinue(false);
      await page.waitForFunction(() => /payment/i.test(document.body?.innerText ?? ""), { timeout: 15000 }).catch(() => null);
      log("payment_continue", true);

      lastStep = "card_fill";
      await stage("card_fill");
      await new Promise((resolve) => setTimeout(resolve, 2500));

      // Ensure "Use shipping address as billing address" is selected. On some
      // themes (Adidas AU) the default is "different billing address" with
      // empty fields, which blocks submit. Click the same-as-shipping radio
      // and tick any matching checkbox.
      try {
        await page.evaluate(() => {
          const fire = (el) => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("click", { bubbles: true }));
          };
          // Radio: Shopify uses billing_address_same / different_billing_address
          const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
          for (const r of radios) {
            const v = (r.value || "").toLowerCase();
            const name = (r.name || "").toLowerCase();
            const label = (r.closest("label")?.textContent || document.querySelector('label[for="' + r.id + '"]')?.textContent || "").toLowerCase();
            if ((name.includes("billing") || name.includes("different_billing_address")) && (v === "false" || v.includes("same") || label.includes("same as shipping") || label.includes("use shipping"))) {
              r.checked = true; fire(r);
            }
          }
          // Checkbox variant: "Use shipping address as billing address"
          const checks = Array.from(document.querySelectorAll('input[type="checkbox"]'));
          for (const c of checks) {
            const label = (c.closest("label")?.textContent || document.querySelector('label[for="' + c.id + '"]')?.textContent || "").toLowerCase();
            if (label.includes("shipping address as billing") || label.includes("billing address is the same") || label.includes("same as shipping")) {
              if (!c.checked) { c.checked = true; fire(c); }
            }
          }
        });
        await new Promise((r) => setTimeout(r, 600));
      } catch {}

      const setIn = async (namePart, value, selectors = []) => {
        const frameList = page.frames();
        for (const f of frameList) {
          try {
            const query = ['input[name*="' + namePart + '"]', ...selectors].join(', ');
            const el = await f.$(query);
            if (el) {
              await el.click({ clickCount: 3 }).catch(() => null);
              await el.type(value, { delay: 25 });
              return true;
            }
          } catch {}
        }
        return false;
      };
      const cardNumberOk = await setIn("number", input.card.number, ['input[autocomplete="cc-number"]', 'input[placeholder*="Card number" i]', 'input[id*="number" i]']);
      await setIn("name", input.card.name, ['input[autocomplete="cc-name"]', 'input[placeholder*="Name on card" i]', 'input[id*="name" i]']);
      const cardExpiryOk = await setIn("expiry", input.card.exp_month.padStart(2, "0") + " / " + input.card.exp_year.slice(-2), ['input[autocomplete="cc-exp"]', 'input[placeholder*="Expiration" i]', 'input[placeholder*="MM" i]', 'input[id*="expiry" i]']);
      const cardCvvOk = await setIn("verification_value", input.card.cvv, ['input[name*="cvv" i]', 'input[name*="cvc" i]', 'input[autocomplete="cc-csc"]', 'input[placeholder*="Security" i]', 'input[id*="verification" i]']);
      if (!cardNumberOk || !cardExpiryOk || !cardCvvOk) return await fail("Card form was not available; checkout is likely still waiting on contact or shipping details");
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
      await clickContinue(true);
      log("submit", true);

      lastStep = "payment_result";
      await stage("payment_result");
      await page.waitForFunction(
        () => {
          if (/\\/thank_you|orders\\/|checkouts\\/.+\\/thank/i.test(location.href)) return true;
          const text = document.body?.innerText ?? "";
          return /declined|payment.*failed|card.*invalid|unable to process|try another card|security code|expired/i.test(text);
        },
        { timeout: 35000 },
      );
      const finalUrl = page.url();
      const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (!/\\/thank_you|orders\\/|checkouts\\/.+\\/thank/i.test(finalUrl)) {
        const paymentMsg = (bodyText.match(/[^\\n]*(?:declined|payment[^\\n]*failed|card[^\\n]*invalid|unable to process|try another card|security code|expired)[^\\n]*/i)?.[0] ?? "Payment was not accepted").trim();
        return await fail(paymentMsg.slice(0, 240));
      }
      const m = finalUrl.match(/orders\\/(\\d+)|checkouts\\/[^/]+\\/([a-z0-9]+)\\/thank_you/i);
      const orderId = m ? (m[1] ?? m[2] ?? null) : null;
      const shot = await page.screenshot({ encoding: "base64", fullPage: false });
      log("payment_result", true, orderId ?? finalUrl);
      return { ok: true, orderId, finalUrl, steps, screenshotB64: shot, dryRun: false };
    } catch (e) {
      return await fail(e?.message ?? String(e));
    }
  };`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const reqUrl = new URL(req.url);
  const action = reqUrl.searchParams.get("action");
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Stage callback path — called from the headless browser running inside
  // Browserless to update the current step label. Auth is the unguessable
  // jobId UUID; no executor token (the headless page can't attach headers).
  if (action === "stage") {
    const jobId = reqUrl.searchParams.get("jobId");
    if (!jobId) return new Response("missing jobId", { status: 400, headers: cors });
    let s: { stage?: string } = {};
    try { s = await req.json(); } catch {}
    if (s.stage) await supa.from("checkout_jobs").update({ stage: s.stage }).eq("id", jobId);
    return new Response("ok", { headers: cors });
  }

  // Main worker path — requires the shared executor token.
  const token = req.headers.get("x-executor-token");
  if (!EXECUTOR_TOKEN || token !== EXECUTOR_TOKEN) {
    return new Response("Unauthorized", { status: 401, headers: cors });
  }

  let body: { jobId?: string } = {};
  try { body = await req.json(); } catch {}
  const jobId = body.jobId;
  if (!jobId) return new Response("missing jobId", { status: 400, headers: cors });

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

  // Stage callback URL — same edge function, ?action=stage.
  const selfUrl = new URL(req.url);
  selfUrl.search = "";
  selfUrl.searchParams.set("action", "stage");
  selfUrl.searchParams.set("jobId", jobId);

  const input = job.input as any;
  const url = new URL("https://production-sfo.browserless.io/function");
  url.searchParams.set("token", BROWSERLESS_KEY);
  if (input.proxy) {
    url.searchParams.set("proxy", "http://" + input.proxy);
    url.searchParams.set("proxySticky", "true");
  }
  // Browserless rejects values above the current plan cap. Keep the request
  // inside the 60s cap so failures happen inside the checkout script instead
  // of at the transport layer before Chrome even launches.
  url.searchParams.set("timeout", "60000");

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
