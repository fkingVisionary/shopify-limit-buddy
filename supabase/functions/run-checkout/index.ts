// Long-running headless checkout worker.
// Invoked fire-and-forget from `enqueueCheckout` server fn with a job id.
// Pulls the job row, drives one Browserless /function session (up to 5 min), and
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
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

// ─── Discord webhook ─────────────────────────────────────────────────
// Fired here (server-side) so the user always gets a notification, even if
// they closed the tab. Idempotency is enforced via a conditional UPDATE on
// checkout_jobs.webhook_fired_at — only the first writer fires.

const BOT_NAME = "J1m's Bot";
const BOT_VERSION = "v1.0";
const BRAND_GOLD = 0xEAD24A;

type NotifyEvent = "in_stock" | "checkout_ready" | "confirmed" | "failed";

const EVENT_META: Record<NotifyEvent, { title: string; subtitle: string; color: number }> = {
  in_stock:       { title: "Stock Detected",       subtitle: "Variant came in stock.",          color: 0x3B82F6 },
  checkout_ready: { title: "Checkout Ready",       subtitle: "Cart prepared, awaiting submit.", color: 0xF59E0B },
  confirmed:      { title: "Successful Checkout!", subtitle: "Your Webhook works!",             color: BRAND_GOLD },
  failed:         { title: "Checkout Failed",      subtitle: "Task could not complete.",        color: 0xEF4444 },
};

function v(value: unknown): string {
  const s = String(value ?? "").trim();
  return s.length > 0 ? s : "—";
}

function buildEmbed(event: NotifyEvent, base: any, dyn: { orderId?: string | null; elapsedMs?: number | null; message?: string | null }) {
  const meta = EVENT_META[event];
  const storeLink = base?.storeUrl
    ? (String(base.storeUrl).startsWith("http") ? base.storeUrl : `https://${base.storeUrl}`)
    : undefined;
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Store",   value: v(base?.storeName || base?.storeUrl) },
    { name: "Product", value: v(base?.productTitle ?? base?.input) },
  ];
  if (base?.price)   fields.push({ name: "Price",   value: v(base.price) });
  if (dyn.orderId)   fields.push({ name: "Order #", value: v(dyn.orderId) });
  if (dyn.elapsedMs) fields.push({ name: "Checkout Time", value: `${(dyn.elapsedMs / 1000).toFixed(1)} seconds` });
  fields.push({ name: "QTY", value: v(base?.qty) });
  if (base?.variantTitle || base?.variantId) fields.push({ name: "Variant", value: v(base.variantTitle ?? base.variantId) });
  fields.push({ name: "Profile / Email", value: v(`${base?.profileMasked ?? "—"} / ${base?.emailMasked ?? "—"}`) });
  if (base?.paymentMethod) fields.push({ name: "Payment Method", value: v(base.paymentMethod) });
  if (base?.mode)          fields.push({ name: "Mode",           value: v(base.mode) });
  fields.push({ name: "Proxy", value: v(base?.proxyGroupName || "Localhost") });
  if (dyn.message && event === "failed") fields.push({ name: "Reason", value: v(String(dyn.message).slice(0, 300)) });

  return {
    title: meta.title,
    url: storeLink,
    description: meta.subtitle,
    color: meta.color,
    fields,
    footer: { text: `${BOT_NAME} — ${BOT_VERSION}${base?.groupName ? ` • ${base.groupName}` : ""}`, icon_url: base?.logoUrl || undefined },
    timestamp: new Date().toISOString(),
  };
}

async function postDiscord(webhookUrl: string, embed: ReturnType<typeof buildEmbed>, logoUrl?: string) {
  const body = JSON.stringify({ username: BOT_NAME, avatar_url: logoUrl || undefined, embeds: [embed] });
  const send = () => fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
  try {
    let res = await send();
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      let waitMs = 1000;
      try {
        const j: any = await res.clone().json();
        if (j?.retry_after) waitMs = Math.min(5000, Math.max(500, Math.floor(Number(j.retry_after) * 1000)));
      } catch {}
      await new Promise((r) => setTimeout(r, waitMs));
      res = await send();
    }
    return res.ok;
  } catch { return false; }
}

async function writeStage(supa: any, jobId: string, stage: string) {
  try {
    await supa
      .from("checkout_jobs")
      .update({ stage })
      .eq("id", jobId)
      .in("status", ["pending", "running"]);
  } catch (e) {
    console.log("[run-checkout] writeStage failed", jobId, stage, String(e));
  }
}

async function fireTerminalWebhook(
  supa: any,
  jobId: string,
  outStatus: "succeeded" | "failed",
  job: any,
  dyn: { orderId?: string | null; elapsedMs?: number | null; message?: string | null },
) {
  const webhookUrl: string | null = job?.notify_webhook ?? null;
  const notify: any = job?.notify_events ?? null;
  const event: NotifyEvent = outStatus === "succeeded" ? "confirmed" : "failed";
  if (!webhookUrl) {
    console.log("[webhook] skip: no webhook url", jobId, event);
    return;
  }
  // Default-on: if the row has a webhook URL but the enabled flag for this
  // event is missing (older saved config / shape drift), still fire.
  // Only an explicit `false` opts out.
  const enabledMap = notify?.enabled ?? {};
  if (enabledMap[event] === false) {
    console.log("[webhook] skip: event disabled", jobId, event);
    return;
  }
  const { data: claimed, error: claimErr } = await supa
    .from("checkout_jobs")
    .update({ webhook_fired_at: new Date().toISOString() })
    .eq("id", jobId)
    .is("webhook_fired_at", null)
    .select("id")
    .maybeSingle();
  if (claimErr) {
    console.log("[webhook] claim error", jobId, event, claimErr.message);
    return;
  }
  if (!claimed) {
    console.log("[webhook] skip: already fired", jobId, event);
    return;
  }
  const embed = buildEmbed(event, notify?.base ?? {}, dyn);
  const ok = await postDiscord(webhookUrl, embed, notify?.base?.logoUrl);
  console.log("[webhook] posted", jobId, event, "ok=" + ok);
}
// ─────────────────────────────────────────────────────────────────────

// Self-contained checkout script shipped to Browserless /function.
// Mirrors src/lib/browserless.functions.ts browserlessScript().
function checkoutScriptSource() {
  return `export default async ({ page, context }) => {
    const { input, stageUrl, twoCaptchaKey } = context;
    const steps = [];
    let lastStep = "checkout_start";
    const log = (s, ok, note) => { steps.push({ step: s, t: Date.now(), ok, note }); };
    const stage = async (label) => {
      // Best-effort live progress. Send from the Browserless function context
      // first, then fire a no-CORS page beacon as a fallback. Never let this
      // slow or block checkout; final result remains the source of truth.
      lastStep = label;
      const stageEndpoint = stageUrl + "&stage=" + encodeURIComponent(label);
      const payload = JSON.stringify({ stage: label });
      const sendFromFunction = async () => {
        try {
          if (typeof fetch !== "function") return false;
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 700);
          try {
            await fetch(stageEndpoint, { method: "POST", headers: { "content-type": "text/plain" }, body: payload, signal: ctrl.signal });
            return true;
          } finally {
            clearTimeout(to);
          }
        } catch { return false; }
      };
      const sendFromPage = async () => {
        try {
          await page.evaluate((url, body) => {
            try {
              if (navigator.sendBeacon) {
                const ok = navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
                if (ok) return;
              }
            } catch {}
            try { fetch(url, { method: "POST", body, mode: "no-cors", keepalive: true }).catch(() => {}); } catch {}
            try { const img = new Image(); img.src = url + "&_=" + Date.now(); } catch {}
          }, stageEndpoint, payload);
        } catch {}
      };
      await Promise.race([sendFromFunction(), new Promise((r) => setTimeout(() => r(false), 800))]);
      void sendFromPage();
    };

    const fail = async (msg) => {
      let shot = null;
      try { shot = await page.screenshot({ encoding: "base64", fullPage: false }); } catch {}
      return { ok: false, failedStep: lastStep, error: msg, steps, screenshotB64: shot };
    };
      const paymentRejected = async (msg) => {
        lastStep = "payment_declined";
        await stage("payment_declined");
        const shot = await page.screenshot({ encoding: "base64", fullPage: false }).catch(() => null);
        log("payment_result", true, msg);
        return { ok: true, orderId: null, finalUrl: page.url(), steps, screenshotB64: shot, dryRun: false, paymentRejected: true, paymentMessage: msg };
      };
    try {
      await stage("checkout_start");

      // Authenticate against an upstream proxy (host:port set via launch args).
      try {
        if (input && input.__proxyUser) {
          await page.authenticate({ username: input.__proxyUser, password: input.__proxyPass || "" });
        }
      } catch {}



      // Aggressive resource blocking — biggest single speedup. Block images,
      // fonts, media, non-essential stylesheets, and known trackers/wallets.
      // Keep documents, XHR/fetch, scripts, and Shopify card-field iframes.
      try {
        await page.setRequestInterception(true);
        const denyHostRe = /(google-analytics|googletagmanager|google\\.com\\/(?:pagead|recaptcha)|doubleclick|facebook\\.(?:net|com)\\/tr|connect\\.facebook|hotjar|clarity\\.ms|segment\\.(?:io|com)|tiktok|pinterest|klaviyo|bing\\.com|bat\\.bing|snap(?:chat)?|twitter\\.com\\/i\\/adsct|criteo|taboola|outbrain|fullstory|datadoghq|sentry\\.io|newrelic|cdn\\.shopify\\.com\\/shopifycloud\\/(?:perf-kit|consent-tracking)|monorail-edge\\.shopifysvc|shop\\.app|pay\\.google|applepay|paypal\\.com|klarna|afterpay|clearpay|bitpay)/i;
        const keepHostRe = /(shopifycs\\.com|deposit\\.shopifycs|pay\\.shopify\\.com\\/card|checkout\\.shopify)/i;
        page.on("request", (req) => {
          try {
            const url = req.url();
            const type = req.resourceType();
            // Never block top-level document navigations — Shopify checkouts
            // commonly redirect the main frame to shop.app / pay.shopify.com,
            // and aborting that causes net::ERR_FAILED on checkout_load.
            const isMainDoc = type === "document" && req.frame() === page.mainFrame();
            if (isMainDoc) return req.continue();
            if (keepHostRe.test(url)) return req.continue();
            // Never block stylesheets. Blocking even one CSS for the card
            // iframe causes Shopify to render its unstyled <noscript> fallback
            // (the "Issue date / Issue number / duplicate Name on card" form
            // seen in the screenshots), which then steals focus from the real
            // card inputs. The CSS savings are not worth that failure mode.
            if (type === "image" || type === "media" || type === "font") return req.abort();
            if (denyHostRe.test(url)) return req.abort();
            return req.continue();
          } catch { try { req.continue(); } catch {} }
        });

      } catch {}

      lastStep = "cart_add";
      const origin = new URL(input.storeUrl).origin;
      // Skip the product page entirely — navigate straight to /cart. It serves
      // a minimal HTML doc on every Shopify store, establishes the storefront
      // cookie jar, and is the same origin /cart/add.js expects. Saves a full
      // document load vs going to the product page first.
      await page.goto(origin + "/cart", { waitUntil: "domcontentloaded", timeout: 15000 });
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
      // Direct navigation to /checkout. Adding a /cart preload or a custom
      // referer triggered Cloudflare bot-blocking (net::ERR_FAILED) on some
      // Shopify stores; the simple goto is what works.
      let checkoutLoaded = false;
      let lastNavErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.goto(origin + "/checkout", { waitUntil: "domcontentloaded", timeout: 45000 });
          checkoutLoaded = true;
          break;
        } catch (e) {
          lastNavErr = e;
          try { await new Promise((r) => setTimeout(r, 600)); } catch {}
        }
      }
      if (!checkoutLoaded) {
        return await fail(String((lastNavErr && lastNavErr.message) || lastNavErr || "checkout navigation failed"));
      }
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
              for (const el of Array.from(document.querySelectorAll(s))) {
                const t = ((el && el.textContent) || "").trim();
                if (/order.?s being processed|processing/i.test(t)) continue;
                if (t) return t.slice(0, 200);
              }
            }
            return null;
          });
        } catch { return null; }
      };

      const visiblePaymentError = async () => {
        try {
          return await page.evaluate(() => {
            const visible = (el) => {
              if (!el) return false;
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
            };
            const sels = ['[data-error-message]', '.field__message--error', '.error-message', '[role="alert"]', '.notice--error', '.banner--error', '[id*="error" i]'];
            const paymentTerms = /declined|payment\\s*(?:failed|could(?:n\u2019|')?t|cannot|can\\s*not)|card\\s*(?:invalid|declined|not accepted)|unable to process|try another card|expired|security\\s*code|cvv|cvc/i;
            for (const s of sels) {
              for (const el of Array.from(document.querySelectorAll(s))) {
                if (!visible(el)) continue;
                const t = ((el && el.textContent) || "").trim();
                if (t && paymentTerms.test(t)) return t.slice(0, 240);
              }
            }
            const body = document.body?.innerText ?? "";
            // Do not match the generic "Security code" label in body text; only
            // body-scan terminal gateway errors like decline/failed/invalid.
            const m = body.match(/[^\\n]*(?:declined|payment[^\\n]*(?:failed|could(?:n\u2019|')?t|cannot|can\\s*not)|card[^\\n]*(?:invalid|declined|not accepted)|unable to process|try another card|expired)[^\\n]*/i);
            return m?.[0]?.trim().slice(0, 240) || null;
          });
        } catch { return null; }
      };

      lastStep = "address_fill";
      await stage("address_fill");
      // Single round-trip address fill. Walking a selector map inside one
      // page.evaluate is dramatically faster than 9 sequential page.$ calls
      // (each was ~100-200ms) and lets React's checkout state settle in a
      // single render pass instead of nine.
      await page.evaluate((p) => {
        const setVal = (sels, value) => {
          if (value == null || value === "") return;
          for (const sel of sels) {
            const node = document.querySelector(sel);
            if (!node) continue;
            const tag = (node.tagName || "").toLowerCase();
            const wanted = String(value);
            try { node.focus(); } catch {}
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
            try { node.blur(); } catch {}
            return;
          }
        };
        setVal(['input[type="email"]', 'input[name="checkout[email]"]', 'input[name="email"]', 'input[autocomplete="email"]', '#email'], p.email);
        setVal(['input[name="checkout[shipping_address][first_name]"]', 'input[autocomplete="given-name"]', 'input[name="firstName"]', 'input[name*="first" i]'], p.first_name);
        setVal(['input[name="checkout[shipping_address][last_name]"]', 'input[autocomplete="family-name"]', 'input[name="lastName"]', 'input[name*="last" i]'], p.last_name);
        setVal(['input[name="checkout[shipping_address][address1]"]', 'input[autocomplete="address-line1"]', 'input[name="address1"]', 'input[name*="address" i]'], p.address1);
        setVal(['input[name="checkout[shipping_address][address2]"]', 'input[autocomplete="address-line2"]', 'input[name="address2"]'], p.address2 ?? "");
        setVal(['input[name="checkout[shipping_address][city]"]', 'input[autocomplete="address-level2"]', 'input[name="city"]'], p.city);
        setVal(['select[name="checkout[shipping_address][province]"], input[name="checkout[shipping_address][province]"]', 'select[autocomplete="address-level1"], input[autocomplete="address-level1"]', 'select[name="province"], input[name="province"]'], p.province);
        setVal(['input[name="checkout[shipping_address][zip]"]', 'input[autocomplete="postal-code"]', 'input[name="postalCode"]', 'input[name="zip"]'], p.zip);
        setVal(['input[name="checkout[shipping_address][phone]"]', 'input[type="tel"]', 'input[autocomplete="tel"]', 'input[name="phone"]'], p.phone);
      }, input.profile);
      await page.keyboard.press("Tab").catch(() => null);
      await page.waitForNetworkIdle?.({ idleTime: 80, timeout: 350 }).catch(() => null);
      log("address_fill", true);


      const checkoutStep = async () => {
        try {
          return await page.evaluate(() => {
            const visible = (el) => {
              if (!el) return false;
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
            };
            const urlStep = (new URL(location.href).searchParams.get("step") || "").toLowerCase();
            if (/payment/.test(urlStep)) return "payment";
            if (/shipping_method|shipping-rate|shipping_rate/.test(urlStep)) return "shipping_method";
            if (/contact|information|shipping_address/.test(urlStep)) return "contact";

            const body = document.body?.innerText || "";
            // Some Shopify checkouts keep the selected shipping rates visible above
            // the payment form. Detect payment before shipping so we do not get
            // stuck re-processing the already-selected shipping section.
            const paymentWidget = Array.from(document.querySelectorAll('iframe[name^="card-fields"], iframe[src*="card" i], input[autocomplete="cc-number"], input[placeholder*="Card number" i], [data-gateway-group], [data-select-gateway], .payment-method-list__item')).find(visible);
            const finalPayButton = Array.from(document.querySelectorAll('button, input[type="submit"]')).some((el) => {
              if (!visible(el) || el.disabled) return false;
              const label = ((el.tagName === "INPUT" ? el.value : el.textContent) || "").trim();
              return /^(pay now|complete order|place order|complete purchase)$/i.test(label);
            });
            const visiblePaymentText = Array.from(document.querySelectorAll('h1, h2, h3, legend, label, [role="heading"], .section__title, .radio__label, .payment-method-list__item')).some((el) => visible(el) && /payment|credit\\s*card|card number/i.test(el.textContent || ""));
            const hasCardFields = /card number|expiration date|security code|name on card/i.test(body);
            if ((paymentWidget || hasCardFields) && (finalPayButton || visiblePaymentText) && /payment|credit card|card number/i.test(body)) return "payment";

            const shippingRate = Array.from(document.querySelectorAll('input[name="checkout[shipping_rate][id]"], [data-shipping-method], [data-shipping-method-label-title]')).find(visible);
            const continueToPayment = Array.from(document.querySelectorAll('button, input[type="submit"], #continue_button, .step__footer__continue-btn')).some((el) => {
              if (!visible(el) || el.disabled) return false;
              const label = ((el.tagName === "INPUT" ? el.value : el.textContent) || "").trim();
              return /continue\\s+to\\s+payment|continue\\s+to\\s+pay/i.test(label);
            });
            if (shippingRate || (/shipping method/i.test(body) && continueToPayment)) return "shipping_method";
            const addressInput = document.querySelector('input[name="checkout[shipping_address][address1]"], input[name="checkout[shipping_address][first_name]"], input[autocomplete="address-line1"], input[autocomplete="given-name"]');
            if (visible(addressInput)) return "contact";
            return "unknown";
          });
        } catch {}
        return "unknown";
      };

      const isPaymentStep = async () => (await checkoutStep()) === "payment";

      const findContinueTarget = async (allowPaymentSubmit, preferredStep = null) => {
        return await page.evaluate((allowSubmit, preferred) => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
          };
          const els = Array.from(document.querySelectorAll('button, input[type="submit"], #continue_button, .step__footer__continue-btn'));
          const candidates = els.map((el) => {
            const text = ((el.tagName === "INPUT" ? el.value : el.textContent) || "").trim();
            const id = el.id || "";
            const cls = el.className?.toString?.() || "";
            if (!visible(el) || el.disabled || /apply/i.test(text)) return null;
            const isSubmit = /pay now|complete order|place order|complete purchase|submit/i.test(text);
            if (isSubmit && !allowSubmit) return null;
            const isContinue = /continue/i.test(text) || /continue_button|step__footer__continue/i.test(id + " " + cls);
            if (!isContinue && !isSubmit) return null;
            let score = 50;
            if (allowSubmit && isSubmit) score = 0;
            if (preferred === "shipping" && /continue\\s+to\\s+shipping|shipping method/i.test(text)) score = 0;
            if (preferred === "payment" && /continue\\s+to\\s+payment|payment method/i.test(text)) score = 0;
            if (/^continue$/i.test(text)) score += 10;
            if (isSubmit && !allowSubmit) score += 100;
            return { el, score };
          }).filter(Boolean).sort((a, b) => a.score - b.score);
          const target = candidates[0]?.el;
          if (!target) return null;
          target.scrollIntoView({ block: "center", inline: "center" });
          const r = target.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, allowPaymentSubmit, preferredStep);
      };

      const clickContinue = async (allowPaymentSubmit = false, preferredStep = null) => {
        const deadline = Date.now() + 1800;
        let target = null;
        while (Date.now() < deadline) {
          target = await findContinueTarget(allowPaymentSubmit, preferredStep);
          if (target) break;
          await new Promise((r) => setTimeout(r, 80));
        }
        if (!target) throw new Error("Could not find checkout continue button");
        try { await page.mouse.click(target.x, target.y, { delay: 20 }); } catch {}
        await page.evaluate((allowSubmit, preferred) => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
          };
          const els = Array.from(document.querySelectorAll('button, input[type="submit"], #continue_button, .step__footer__continue-btn'));
          const candidates = els.map((el) => {
            const text = ((el.tagName === "INPUT" ? el.value : el.textContent) || "").trim();
            const id = el.id || "";
            const cls = el.className?.toString?.() || "";
            if (!visible(el) || el.disabled || /apply/i.test(text)) return null;
            const isSubmit = /pay now|complete order|place order|complete purchase|submit/i.test(text);
            if (isSubmit && !allowSubmit) return null;
            const isContinue = /continue/i.test(text) || /continue_button|step__footer__continue/i.test(id + " " + cls);
            if (!isContinue && !isSubmit) return null;
            let score = 50;
            if (allowSubmit && isSubmit) score = 0;
            if (preferred === "shipping" && /continue\\s+to\\s+shipping|shipping method/i.test(text)) score = 0;
            if (preferred === "payment" && /continue\\s+to\\s+payment|payment method/i.test(text)) score = 0;
            if (/^continue$/i.test(text)) score += 10;
            if (isSubmit && !allowSubmit) score += 100;
            return { el, score };
          }).filter(Boolean).sort((a, b) => a.score - b.score);
          candidates[0]?.el?.click();
        }, allowPaymentSubmit, preferredStep);
      };

      const advanceToShipping = async (maxAttempts) => {
        for (let i = 0; i < maxAttempts; i++) {
          const step = await checkoutStep();
          if (step === "shipping_method" || step === "payment") return true;
          await clickContinue(false, "shipping").catch(() => null);
          await new Promise((r) => setTimeout(r, 450));
          const next = await checkoutStep();
          if (next === "shipping_method" || next === "payment") return true;
          const err = await visibleCheckoutError();
          if (err) throw new Error("Checkout validation: " + err);
        }
        const finalStep = await checkoutStep();
        return finalStep === "shipping_method" || finalStep === "payment";
      };

      const hasSelectedShippingRate = async () => {
        return await page.evaluate(() => {
          const visible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && !el.disabled;
          };
          const rates = Array.from(document.querySelectorAll('input[name="checkout[shipping_rate][id]"], input[type="radio"][id*="shipping" i], input[type="radio"][name*="shipping" i]')).filter(visible);
          return rates.some((input) => input.checked || input.getAttribute("aria-checked") === "true");
        }).catch(() => false);
      };

      const selectShippingRate = async () => {
        const deadline = Date.now() + 4500;
        while (Date.now() < deadline) {
          if (await hasSelectedShippingRate()) return true;
          const target = await page.evaluate(() => {
            const visible = (el) => {
              if (!el) return false;
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && !el.disabled;
            };
            const rectFor = (el) => {
              el.scrollIntoView({ block: "center", inline: "center" });
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            };
            const rates = Array.from(document.querySelectorAll('input[name="checkout[shipping_rate][id]"], input[type="radio"][id*="shipping" i], input[type="radio"][name*="shipping" i]')).filter(visible);
            const checked = rates.find((input) => input.checked || input.getAttribute("aria-checked") === "true");
            if (checked) return { selected: true };
            const first = rates.find((input) => !input.disabled);
            if (first) {
              const label = first.closest("label") || document.querySelector('label[for="' + first.id + '"]') || first.closest('.content-box__row, .radio-wrapper, [data-shipping-method]');
              return rectFor(label || first);
            }
            const rows = Array.from(document.querySelectorAll('[data-shipping-method], .content-box__row, .radio-wrapper, label'));
            for (const row of rows) {
              if (!visible(row)) continue;
              const text = (row.textContent || "").trim();
              if (/shipping|delivery|standard|express|free/i.test(text)) return rectFor(row);
            }
            const canContinue = Array.from(document.querySelectorAll('button, input[type="submit"], #continue_button')).some((el) => {
              if (!visible(el) || el.disabled) return false;
              const label = ((el.tagName === "INPUT" ? el.value : el.textContent) || "").trim();
              return /continue\\s+to\\s+payment/i.test(label);
            });
            return canContinue ? { selected: true } : null;
          }).catch(() => null);
          if (target?.selected) return true;
          if (target?.x != null && target?.y != null) {
            await page.mouse.click(target.x, target.y, { delay: 20 }).catch(() => null);
            await new Promise((r) => setTimeout(r, 160));
          } else {
            await new Promise((r) => setTimeout(r, 150));
          }
          const err = await visibleCheckoutError();
          if (err) throw new Error("Checkout validation: " + err);
        }
        return false;
      };

      const advanceToPayment = async (maxAttempts) => {
        for (let i = 0; i < maxAttempts; i++) {
          if (await isPaymentStep()) return true;
          if (!(await selectShippingRate())) return false;
          // On one-page/accordion checkouts, selecting a shipping rate reveals
          // payment immediately below it with no intermediate continue button.
          if (await isPaymentStep()) return true;
          const startUrl = page.url();
          await clickContinue(false, "payment").catch(() => null);
          await page.waitForFunction(
            (prevUrl) => {
              const step = (new URL(location.href).searchParams.get("step") || "").toLowerCase();
              if (/payment/.test(step)) return true;
              if (location.href !== prevUrl && /payment/.test(location.href)) return true;
              return false;
            },
            { timeout: 3000 },
            startUrl,
          ).catch(() => null);
          await new Promise((r) => setTimeout(r, 100));
          if (await isPaymentStep()) return true;
          const err = await visibleCheckoutError();
          if (err) throw new Error("Checkout validation: " + err);
        }
        return await isPaymentStep();
      };

      lastStep = "shipping_continue";
      await stage("shipping_continue");
      try {
        if (!(await advanceToShipping(3))) {
          const err = await visibleCheckoutError();
          if (err) return await fail("Checkout validation: " + err);
          return await fail("Could not advance to shipping method step");
        }
      } catch (e) {
        return await fail(String(e?.message ?? e));
      }
      log("shipping_continue", true);

      lastStep = "shipping_method";
      await stage("shipping_method");
      try {
        if (!(await selectShippingRate())) {
          const err = await visibleCheckoutError();
          if (err) return await fail("Checkout validation: " + err);
          return await fail("Could not select a shipping method");
        }
      } catch (e) {
        return await fail(String(e?.message ?? e));
      }
      log("shipping_method", true);

      lastStep = "payment_continue";
      await stage("payment_continue");
      try {
        if (!(await advanceToPayment(3))) {
          const err = await visibleCheckoutError();
          if (err) return await fail("Checkout validation: " + err);
          return await fail("Could not advance to payment step");
        }
      } catch (e) {
        return await fail(String(e?.message ?? e));
      }
      log("payment_continue", true);


      lastStep = "card_fill";
      await stage("card_fill");
      await new Promise((resolve) => setTimeout(resolve, 200));

      const bringPaymentIntoView = async () => {
        const deadline = Date.now() + 4500;
        while (Date.now() < deadline) {
          const found = await page.evaluate(() => {
            const visible = (el) => {
              if (!el) return false;
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
            };
            const descriptor = (el) => [el.textContent, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.id, el.className?.toString?.()].filter(Boolean).join(" ").toLowerCase();
            const els = Array.from(document.querySelectorAll('iframe, input, label, h1, h2, h3, legend, [role="heading"], [role="radio"], [data-gateway-group], [data-select-gateway], .radio-wrapper, .content-box__row, .radio__label, .payment-method-list__item'));
            const target = els.find((el) => visible(el) && /payment|credit\\s*card|card number|cc-number|card-fields|name on card|security code/i.test(descriptor(el)) && !/paypal|afterpay|klarna|zip|bitpay|crypto/i.test(descriptor(el)));
            if (!target) return false;
            target.scrollIntoView({ block: "center", inline: "center" });
            return true;
          }).catch(() => false);
          if (found) {
            await new Promise((r) => setTimeout(r, 200));
            return true;
          }
          await page.evaluate(() => window.scrollBy(0, Math.max(420, Math.floor(window.innerHeight * 0.8)))).catch(() => null);
          await page.keyboard.press("PageDown").catch(() => null);
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      };
      await bringPaymentIntoView();

      const selectCreditCardPayment = async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const target = await page.evaluate(() => {
            const visible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
            };
            const centerOf = (el) => {
              el.scrollIntoView({ block: "center", inline: "center" });
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            };
            const cssEscape = (value) => (window.CSS?.escape ? CSS.escape(value) : String(value));
            const labelFor = (el) => el.id ? document.querySelector('label[for="' + cssEscape(el.id) + '"]') : null;
            const rowFor = (el) => labelFor(el) || el.closest('label, [role="radio"], .radio-wrapper, [data-select-gateway], [data-gateway-group], .payment-method-list__item, .content-box__row') || el;
            const directTextFor = (el) => [labelFor(el)?.textContent, el.closest("label")?.textContent, el.getAttribute?.("aria-label"), el.value, el.id, el.name].filter(Boolean).join(" ").trim().toLowerCase();
            const isCard = (text) => /credit\\s*card|debit\\s*card|visa|mastercard|american express|amex|shopify payments|creditcard|card/.test(text) && !/paypal|afterpay|klarna|zip|bitpay|crypto|apple pay|google pay/.test(text);
            const isOffsite = (text) => /paypal|afterpay|klarna|zip|bitpay|crypto|apple pay|google pay/.test(text);
            const isSelected = (el) => {
              if (el.checked || el.getAttribute?.("aria-checked") === "true" || el.getAttribute?.("aria-selected") === "true") return true;
              const row = rowFor(el);
              return !!row?.querySelector?.('input[type="radio"]:checked, [aria-checked="true"], [aria-selected="true"]');
            };
            const radios = Array.from(document.querySelectorAll('input[type="radio"]')).map((input) => {
              const row = rowFor(input);
              const r = row.getBoundingClientRect();
              return { input, row, directText: directTextFor(input), y: r.top, h: r.height, selected: isSelected(input) };
            }).filter((item) => visible(item.row));
            const cardRadios = radios.filter((item) => (isCard(item.directText) || /creditcards|creditcard|credit-card|credit_card|shopify_payments|card-fields/i.test(item.input.id + " " + item.input.name + " " + item.input.getAttribute("aria-label"))) && !isOffsite(item.directText));
            const checkedCard = cardRadios.find((item) => item.selected);
            if (checkedCard) return { selected: true };

            if (cardRadios[0]) {
              return centerOf(cardRadios[0].input);
            }

            const rows = Array.from(document.querySelectorAll('label, [role="radio"], [data-gateway-group], [data-select-gateway], .radio-wrapper, .content-box__row, .radio__label, .payment-method-list__item'));
            for (const row of rows) {
              if (!visible(row)) continue;
              const text = directTextFor(row);
              if (isCard(text)) {
                const input = row.querySelector?.('input[type="radio"]');
                return centerOf(input || row);
              }
            }
            return null;
          }).catch(() => false);
          if (target?.selected) return true;
          if (target?.x != null && target?.y != null) {
            await page.mouse.click(target.x, target.y).catch(() => null);
            await new Promise((r) => setTimeout(r, 250));
            const selected = await page.evaluate(() => {
              const visible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
              };
              const cssEscape = (value) => (window.CSS?.escape ? CSS.escape(value) : String(value));
              const labelFor = (el) => el.id ? document.querySelector('label[for="' + cssEscape(el.id) + '"]') : null;
              const rowFor = (el) => labelFor(el) || el.closest('label, [role="radio"], [data-gateway-group], [data-select-gateway], .radio-wrapper, .content-box__row, .payment-method-list__item') || el;
              const directTextFor = (el) => [labelFor(el)?.textContent, el.closest?.("label")?.textContent, el.getAttribute?.("aria-label"), el.value, el.id, el.name].filter(Boolean).join(" ").toLowerCase();
              const isCard = (text) => /credit\\s*card|debit\\s*card|visa|mastercard|american express|amex|shopify payments|creditcard|card/.test(text) && !/paypal|afterpay|klarna|zip|bitpay|crypto|apple pay|google pay/.test(text);
              const hasCardFields = Array.from(document.querySelectorAll('iframe[name*="card-fields" i], iframe[id*="card-fields" i], iframe[src*="card-fields" i], input[autocomplete="cc-number"], input[placeholder*="Card number" i], input[aria-label*="card number" i]')).some(visible);
              const checkedCard = Array.from(document.querySelectorAll('input[type="radio"]')).some((el) => (el.checked || rowFor(el)?.querySelector?.('input[type="radio"]:checked')) && isCard(directTextFor(el)));
              return hasCardFields && checkedCard;
            }).catch(() => false);
            if (selected) return true;
          }
          await bringPaymentIntoView();
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      };
      const creditCardSelected = await selectCreditCardPayment();
      if (!creditCardSelected) return await fail("Credit card payment option was not available or could not be selected");

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
        await new Promise((r) => setTimeout(r, 200));
      } catch {}

      // Modern Shopify "Checkout One" (/checkouts/cn/...) puts each card field
      // inside its own cross-origin iframe under checkout.shopifycs.com. The
      // iframes are named e.g. "Field container for: Card number". Find the
      // right frame by its name (or URL path) and fill the single visible text
      // input inside it — this avoids guessing the input's id/name attributes,
      // which vary across Shopify checkout versions.
      const fillCardField = async (kind, value) => {
        const raw = String(value ?? "");
        const expectedDigits = raw.replace(/\\D/g, "");
        const typeText = kind === "name" ? raw : expectedDigits;
        const looksFilled = (current) => {
          const v = String(current || "").trim();
          const digits = v.replace(/\\D/g, "");
          if (kind === "number") return digits.length >= expectedDigits.length;
          if (kind === "expiry") return digits.length >= 4;
          if (kind === "cvv") return expectedDigits.length > 0 ? digits.length >= expectedDigits.length : digits.length >= 3;
          if (kind === "name") return v.length >= 2;
          return v.length > 0;
        };
        const nameRe = {
          number: /card\\s*number|^number$|\\/number|card-fields-number|fieldType=number/i,
          expiry: /expiration|expiry|\\/expiry|card-fields-expiry|fieldType=expiry/i,
          cvv: /security\\s*code|verification[_\\s-]?value|cvv|cvc|\\/verification|card-fields-verification|fieldType=verification/i,
          name: /name(?!.*(number|expiry|expiration|verification|cvv|cvc|security))/i,
        }[kind];
        // For "name" we must NEVER fall through to a number/expiry/cvv field.
        // looksFilled for name only checks length>=2, so it would silently
        // accept typing "M edwards" into the card number input.
        const excludeRe = kind === "name"
          ? /number|expiry|expiration|verification|cvv|cvc|security/i
          : null;
        const elementLooksLikeWrongField = async (el, ctx) => {
          if (!excludeRe) return false;
          return await (ctx || page).evaluate((node, reSrc) => {
            const re = new RegExp(reSrc, "i");
            const attrs = [
              node.getAttribute("name") || "",
              node.getAttribute("id") || "",
              node.getAttribute("placeholder") || "",
              node.getAttribute("aria-label") || "",
              node.getAttribute("autocomplete") || "",
            ].join(" ");
            return re.test(attrs);
          }, el, excludeRe.source).catch(() => false);
        };
        const readTopLevelValue = async (el) => await page.evaluate((node) => node.value || "", el).catch(() => "");
        const fillTopLevelInput = async () => {
          const selector = kind === "number"
            ? 'input[autocomplete="cc-number"], input[placeholder*="Card number" i], input[aria-label*="card number" i], input[name*="number" i]'
            : kind === "expiry"
              ? 'input[autocomplete="cc-exp"], input[placeholder*="Expiration" i], input[placeholder*="Expiry" i], input[aria-label*="expiration" i], input[name*="expiry" i]'
              : kind === "cvv"
                ? 'input[autocomplete="cc-csc"], input[placeholder*="Security" i], input[placeholder*="CVV" i], input[placeholder*="CVC" i], input[aria-label*="security" i], input[name*="verification" i]'
                : 'input[autocomplete="cc-name"], input[autocomplete="ccname"], input[placeholder*="Name on card" i], input[aria-label*="name on card" i], input[placeholder*="Cardholder" i], input[aria-label*="cardholder" i], input[name*="cardholder" i], input[id*="cardholder" i], input[id*="name_on_card" i], input[name*="name_on_card" i], input[name="checkout[credit_card][name]" i]';
          const handles = await page.$$(selector).catch(() => []);
          for (const el of handles) {
            const visible = await page.evaluate((node) => {
              if (!node) return false;
              const r = node.getBoundingClientRect();
              const s = getComputedStyle(node);
              return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !node.disabled;
            }, el).catch(() => false);
            if (!visible) continue;
            if (await elementLooksLikeWrongField(el, null)) continue;
            // DOM-set first — avoids cross-iframe keystroke leaks (the bug
            // where "M edwards" ended up inside the Card number iframe).
            // Legacy Shopify checkouts process card data server-side, so
            // DOM-set is accepted; Checkout One uses iframes handled below.
            await page.evaluate((node, val) => {
              const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
              node.focus();
              if (desc && desc.set) desc.set.call(node, String(val));
              else node.value = String(val);
              node.dispatchEvent(new Event("input", { bubbles: true }));
              node.dispatchEvent(new Event("change", { bubbles: true }));
              node.dispatchEvent(new Event("blur", { bubbles: true }));
            }, el, raw).catch(() => null);
            if (looksFilled(await readTopLevelValue(el))) return true;
            // Fallback: real keystrokes for sites whose tokenizer ignores
            // programmatic value sets. Tab off afterwards to commit + move
            // focus, instead of clicking the next field.
            await el.focus().catch(() => null);
            await el.click({ clickCount: 3 }).catch(() => null);
            await page.keyboard.press("Backspace").catch(() => null);
            await el.type(typeText, { delay: kind === "name" ? 20 : 30 }).catch(() => null);
            await page.evaluate((node) => {
              node.dispatchEvent(new Event("input", { bubbles: true }));
              node.dispatchEvent(new Event("change", { bubbles: true }));
              node.dispatchEvent(new Event("blur", { bubbles: true }));
            }, el).catch(() => null);
            await page.keyboard.press("Tab").catch(() => null);
            if (looksFilled(await readTopLevelValue(el))) return true;
          }
          return false;
        };
        // Name field on Checkout One lives in its own card-fields iframe just
        // like number/expiry/cvv. Use the same iframe-aware keystroke flow.
        // Legacy checkouts have it as a top-level input — fillTopLevelInput
        // (called inside the loop below) handles that case.
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const fname = (frame.name && frame.name()) || "";
            const furl = frame.url ? frame.url() : "";
            if (!nameRe.test(fname) && !nameRe.test(furl)) continue;
            try {
              const inputs = await frame.$$('input:not([type="hidden"])');
              for (const el of inputs) {
                const box = await el.boundingBox().catch(() => null);
                if (!box || box.width <= 0 || box.height <= 0) continue;
                const readVal = async () => await frame.evaluate((n) => n.value || "", el).catch(() => "");
                // Clear via DOM (not page.keyboard) to avoid mis-targeting another iframe.
                const clearIt = async () => {
                  await frame.evaluate((node) => {
                    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
                    if (desc && desc.set) desc.set.call(node, "");
                    else node.value = "";
                    node.dispatchEvent(new Event("input", { bubbles: true }));
                  }, el).catch(() => null);
                };
                await clearIt();
                for (let attempt = 0; attempt < 3; attempt++) {
                  // Force OS focus onto this iframe's input by clicking its
                  // centre from the page level, then type via page.keyboard.
                  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => null);
                  await el.focus().catch(() => null);
                  await page.keyboard.type(typeText, { delay: 30 }).catch(() => null);
                  await frame.evaluate((node) => {
                    node.dispatchEvent(new Event("input", { bubbles: true }));
                    node.dispatchEvent(new Event("change", { bubbles: true }));
                  }, el).catch(() => null);
                  const cur = await readVal();
                  if (looksFilled(cur)) {
                    await frame.evaluate((node) => node.dispatchEvent(new Event("blur", { bubbles: true })), el).catch(() => null);
                    return true;
                  }
                  const wantDigits = typeText.replace(/\\D/g, "");
                  const haveLen = String(cur).replace(/\\D/g, "").length;
                  if (haveLen > 0 && haveLen < wantDigits.length) {
                    const tail = wantDigits.slice(haveLen);
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => null);
                    await page.keyboard.type(tail, { delay: 35 }).catch(() => null);
                    const cur2 = await readVal();
                    if (looksFilled(cur2)) {
                      await frame.evaluate((node) => node.dispatchEvent(new Event("blur", { bubbles: true })), el).catch(() => null);
                      return true;
                    }
                  }
                  await clearIt();
                }
              }
            } catch {}
          }
          if (await fillTopLevelInput()) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      };
      // Hard guard: the unstyled <noscript> fallback contains "Issue date" and
      // "Issue number" — fields that do NOT exist on a properly-loaded card
      // iframe. If we see them on the top-level document, the card iframe
      // never rendered (CSS was blocked, network race, etc.) and any input
      // we type ends up in fake fields. Fail loudly instead of silently
      // submitting garbage to Shopify.
      const fallbackVisible = await page.evaluate(() => {
        const txt = (document.body && document.body.innerText) || "";
        return /Issue date/i.test(txt) && /Issue number/i.test(txt);
      }).catch(() => false);
      if (fallbackVisible) {
        return await fail("Legacy card-form fallback detected (Issue date / Issue number visible) — Shopify card iframe failed to load. This usually means stylesheets were blocked or the iframe was racing with submit. Aborting before sending invalid card data.");
      }
      const expiryValue = input.card.exp_month.padStart(2, "0") + " / " + input.card.exp_year.slice(-2);

      // Fill number/expiry/cvv first — those are inside cross-origin iframes
      // and need real keystrokes. Name is a top-level input that Shopify
      // renders alongside the card iframes; fill it LAST after the card
      // section is fully rendered, so the tightened cc-name selectors find
      // the real cardholder input (not a stale shipping "name" field).
      const cardNumberOk = await fillCardField("number", input.card.number);
      await page.keyboard.press("Tab").catch(() => null);
      const cardExpiryOk = await fillCardField("expiry", expiryValue);
      await page.keyboard.press("Tab").catch(() => null);
      const cardCvvOk = await fillCardField("cvv", input.card.cvv);
      await page.keyboard.press("Tab").catch(() => null);
      // Small settle so the cardholder-name input (rendered by Shopify after
      // the card iframes mount) is in the DOM before we look for it.
      await new Promise((r) => setTimeout(r, 400));
      let cardNameOk = await fillCardField("name", input.card.name);
      if (!cardNameOk) {
        await new Promise((r) => setTimeout(r, 600));
        cardNameOk = await fillCardField("name", input.card.name);
      }
      if (!cardNumberOk || !cardExpiryOk || !cardCvvOk || !cardNameOk) return await fail("Card form was not available; checkout is likely still waiting on contact or shipping details (number=" + cardNumberOk + " name=" + cardNameOk + " expiry=" + cardExpiryOk + " cvv=" + cardCvvOk + ")");
      log("card_fill", true);
      await page.waitForNetworkIdle?.({ idleTime: 150, timeout: 600 }).catch(() => null);

      // ─── Captcha handling ─────────────────────────────────────────────
      // Detect any visible hCaptcha / Turnstile / reCAPTCHA on the checkout
      // page (Shopify shows these between card_fill and submit on some
      // stores — Culture Kings, JB Hi-Fi, etc.). If a pre-solved token was
      // passed in (input.captchaToken), inject it. Otherwise auto-solve via
      // 2Captcha using TWOCAPTCHA_API_KEY.
      const injectToken = async (tok) => {
        await page.evaluate((t) => {
          const set = (name) => {
            let el = document.querySelector('[name="' + name + '"]');
            if (!el) {
              el = document.createElement("textarea");
              el.name = name;
              el.style.display = "none";
              document.body.appendChild(el);
            }
            el.value = t;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          };
          set("cf-turnstile-response");
          set("g-recaptcha-response");
          set("h-captcha-response");
        }, tok);
      };

      const detectCaptchaOnPage = async () => {
        // Scan every frame: read sitekey from data-attributes / URL params /
        // window.hcaptcha config. Returns first match or null.
        for (const frame of page.frames()) {
          const url = (frame.url && frame.url()) || "";
          let kind = null;
          if (/hcaptcha\\.com|newassets\\.hcaptcha\\.com/i.test(url)) kind = "hcaptcha";
          else if (/challenges\\.cloudflare\\.com|turnstile/i.test(url)) kind = "turnstile";
          else if (/google\\.com\\/recaptcha/i.test(url)) kind = "recaptchaV2";
          if (kind) {
            const m = url.match(/[?&](?:sitekey|k)=([^&]+)/);
            if (m && m[1]) return { kind, sitekey: decodeURIComponent(m[1]) };
          }
          // Per-frame DOM scan for data-sitekey on any container.
          try {
            const found = await frame.evaluate(() => {
              const el = document.querySelector("[data-sitekey], [data-hcaptcha-sitekey], .h-captcha, .g-recaptcha, .cf-turnstile");
              if (!el) return null;
              const sk = el.getAttribute("data-sitekey") || el.getAttribute("data-hcaptcha-sitekey");
              if (!sk) return null;
              const cls = (el.className || "") + " " + (el.id || "");
              let kind = "recaptchaV2";
              if (/h-captcha|hcaptcha/i.test(cls)) kind = "hcaptcha";
              else if (/turnstile|cf-/i.test(cls)) kind = "turnstile";
              return { kind, sitekey: sk };
            });
            if (found && found.sitekey) return found;
          } catch {}
        }
        return null;
      };

      const solveAndInjectCaptcha = async (det) => {
        if (!det || !det.sitekey) return false;
        if (!twoCaptchaKey) {
          lastStep = "captcha_blocked";
          await stage("captcha_blocked");
          return { blocked: "Captcha shown by store and TWOCAPTCHA_API_KEY is not configured" };
        }
        lastStep = "captcha_solve";
        await stage("captcha_solve");
        const typeMap = { hcaptcha: "HCaptchaTaskProxyless", turnstile: "TurnstileTaskProxyless", recaptchaV2: "RecaptchaV2TaskProxyless" };
        try {
          const createRes = await fetch("https://api.2captcha.com/createTask", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ clientKey: twoCaptchaKey, task: { type: typeMap[det.kind], websiteURL: page.url(), websiteKey: det.sitekey } }),
          });
          const createJson = await createRes.json().catch(() => ({}));
          if (createJson.errorId && createJson.errorId !== 0) {
            return { blocked: "2Captcha submit failed: " + (createJson.errorDescription || createJson.errorCode || "unknown") };
          }
          const taskId = createJson.taskId;
          if (!taskId) return { blocked: "2Captcha returned no taskId" };
          const deadline = Date.now() + 140000;
          await new Promise((r) => setTimeout(r, 8000));
          let token = null;
          while (Date.now() < deadline) {
            const pollRes = await fetch("https://api.2captcha.com/getTaskResult", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ clientKey: twoCaptchaKey, taskId }),
            });
            const pj = await pollRes.json().catch(() => ({}));
            if (pj.errorId && pj.errorId !== 0) return { blocked: "2Captcha poll failed: " + (pj.errorDescription || pj.errorCode) };
            if (pj.status === "ready") {
              token = (pj.solution && (pj.solution.token || pj.solution.gRecaptchaResponse)) || null;
              break;
            }
            await new Promise((r) => setTimeout(r, 5000));
          }
          if (!token) return { blocked: "2Captcha timed out solving " + det.kind };
          lastStep = "captcha_inject";
          await stage("captcha_inject");
          await injectToken(token);
          await page.evaluate(() => {
            const checks = Array.from(document.querySelectorAll('input[type="checkbox"]'));
            for (const c of checks) {
              const lbl = (c.closest('label')?.textContent || '').toLowerCase();
              if (lbl.includes('i am human') && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }
            }
          }).catch(() => null);
          log("captcha_inject", true, det.kind);
          return { token };
        } catch (e) {
          return { blocked: "Captcha solve error: " + (e && e.message ? e.message : String(e)) };
        }
      };

      // ─── Pre-submit captcha sweep (up to 2 attempts) ─────────────────
      if (input.captchaToken) {
        lastStep = "captcha_inject";
        await stage("captcha_inject");
        await injectToken(input.captchaToken);
        log("captcha_inject", true, "pre-supplied token");
      } else {
        for (let attempt = 0; attempt < 2; attempt++) {
          const det = await detectCaptchaOnPage();
          if (!det) break;
          if (attempt === 0) { lastStep = "captcha_detect"; await stage("captcha_detect"); }
          else { lastStep = "captcha_retry"; await stage("captcha_retry"); }
          const res = await solveAndInjectCaptcha(det);
          if (res && res.blocked) return await fail(res.blocked);
          await new Promise((r) => setTimeout(r, 800));
          const still = await detectCaptchaOnPage();
          if (!still) break;
          if (attempt === 1) {
            lastStep = "captcha_blocked";
            await stage("captcha_blocked");
            return await fail("Captcha kept reappearing after solve — proxy/IP is likely flagged. Try rotating proxies.");
          }
        }
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
      await new Promise((r) => setTimeout(r, 250));
      const securityCodeRetryNeeded = await page.evaluate(() => {
        if (/\\/thank_you|orders\\/|checkouts\\/.+\\/thank/i.test(location.href)) return false;
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const sels = ['[data-error-message]', '.field__message--error', '.error-message', '[role="alert"]', '[id*="error" i]'];
        return sels.some((s) => Array.from(document.querySelectorAll(s)).some((el) => visible(el) && /security\\s*code|cvv|cvc/i.test(el.textContent || "")));
      }).catch(() => false);
      if (securityCodeRetryNeeded) {
        lastStep = "cvv_retry";
        await stage("cvv_retry");
        const retryCvvOk = await fillCardField("cvv", input.card.cvv);
        if (!retryCvvOk) return await fail("Security code was not accepted by the payment form");
        await page.keyboard.press("Tab").catch(() => null);
        await page.waitForNetworkIdle?.({ idleTime: 150, timeout: 600 }).catch(() => null);
        lastStep = "submit";
        await stage("submit");
        await clickContinue(true);
        log("submit_retry", true);
      }

      lastStep = "payment_result";
      await stage("payment_result");
      // Detect a 3-D Secure / bank challenge in any frame: Stripe 3DS, Adyen,
      // Braintree, Shopify/payment app verification, bank ACS pages, generic
      // "challenge" / "authenticate" URLs, or visible body text.
      const detect3DS = async () => {
        try {
          const frames = page.frames();
          for (const f of frames) {
            const u = (f.url && f.url()) || "";
            if (/three_d_secure|3d[_-]?secure|3ds|hooks\\.stripe\\.com\\/3d|challenges\\.stripe\\.com|acs|authentication|authenticate|challenge|cardinalcommerce|emv3ds|adyen|braintree|checkout\\.shopifycs\\.com\\/verify|pay\\.shopify\\.com.*(?:verify|challenge)/i.test(u)) return true;
          }
          return await page.evaluate(() => {
            const visible = (el) => {
              if (!el) return false;
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
            };
            const frameHit = Array.from(document.querySelectorAll('iframe')).some((el) => {
              const u = el.getAttribute('src') || el.getAttribute('name') || el.id || '';
              return visible(el) && /three_d_secure|3d[_-]?secure|3ds|acs|authentication|authenticate|challenge|cardinalcommerce|emv3ds|adyen|braintree|verify/i.test(u);
            });
            if (frameHit) return true;
            const txt = (document.body && document.body.innerText) || "";
            return /3-?D\\s*Secure|secure checkout|verify(?:\\s+your)?\\s+(?:identity|payment|purchase|card)|verification required|authenticate(?:\\s+your)?\\s+(?:card|payment)|approve.*?(?:bank|app|purchase|payment)|open.*?(?:bank|app)|sent (?:a|you) (?:code|notification)|enter (?:the )?(?:code|otp|one-time|one time)|one-time passcode|one time passcode|bank app/i.test(txt);
          });
        } catch { return false; }
      };
      // Initial short window for instant outcomes (no 3DS path).
      let resultDeadline = Date.now() + 15000;
      let earlyReject = null;
      let threeDsActive = false;
      while (Date.now() < resultDeadline) {
        if (/\\/thank_you|orders\\/|checkouts\\/.+\\/thank/i.test(page.url())) break;
        const paymentErr = await visiblePaymentError();
        if (paymentErr) {
          if (/security\\s*code|cvv|cvc/i.test(paymentErr)) break;
          earlyReject = paymentErr;
          break;
        }
        if (!threeDsActive && await detect3DS()) {
          threeDsActive = true;
          lastStep = "three_d_secure";
          await stage("three_d_secure");
          log("three_d_secure", true, "challenge detected");
          // Extend wait to 4 minutes for user/bank to approve.
          resultDeadline = Date.now() + 240000;
        }
        // Post-submit captcha re-challenge: solve, inject, re-click Pay-now.
        if (!threeDsActive) {
          const postDet = await detectCaptchaOnPage();
          if (postDet) {
            lastStep = "captcha_retry";
            await stage("captcha_retry");
            const res = await solveAndInjectCaptcha(postDet);
            if (res && res.blocked) return await fail(res.blocked);
            await clickContinue(true).catch(() => null);
            resultDeadline = Date.now() + 20000;
          }
        }
        await new Promise((r) => setTimeout(r, threeDsActive ? 1000 : 200));
      }
      if (earlyReject) return await paymentRejected(earlyReject);
      const finalUrl = page.url();
      if (!/\\/thank_you|orders\\/|checkouts\\/.+\\/thank/i.test(finalUrl)) {
        const paymentMsg = await visiblePaymentError();
        if (paymentMsg) return await paymentRejected(paymentMsg.slice(0, 240));
        if (threeDsActive) return await paymentRejected("3-D Secure verification timed out or was not completed");
        // If a captcha is still on screen, this is a captcha block — not a payment decline.
        const stillCaptcha = await detectCaptchaOnPage();
        if (stillCaptcha) return await fail("Captcha could not be bypassed — proxy/IP is likely flagged. Try rotating proxies.");
        return await paymentRejected("Payment did not complete — store may be silently blocking this proxy/IP");
      }
      const m = finalUrl.match(/orders\\/(\\d+)|checkouts\\/[^/]+\\/([a-z0-9]+)\\/thank_you/i);
      const orderId = m ? (m[1] ?? m[2] ?? null) : null;
      // Skip success screenshot — saves ~500ms-1s and a large b64 payload.
      log("payment_result", true, orderId ?? finalUrl);
      return { ok: true, orderId, finalUrl, steps, screenshotB64: null, dryRun: false };
    } catch (e) {
      return await fail(e?.message ?? String(e));
    }
  };`;
}

// ─── RECON SCRIPT (Phase 1, throwaway) ─────────────────────────────
// Loads a PDP, adds to cart, navigates to checkout, and dumps the DOM
// shape of every step (form fields, buttons, iframes) so we can build a
// store-specific adapter without guessing selectors.
function reconScriptSource() {
  return `export default async ({ page, context }) => {
    const { productUrl } = context;
    const report = { productUrl, steps: [], screenshots: {}, errors: [] };
    const snap = async (label) => {
      try { report.screenshots[label] = await page.screenshot({ encoding: "base64", fullPage: false }); }
      catch (e) { report.errors.push(label + ":screenshot:" + (e?.message ?? e)); }
    };
    const dumpDom = async (label) => {
      try {
        const data = await page.evaluate(() => {
          const visible = (el) => {
            try {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
            } catch { return false; }
          };
          const labelOf = (el) => {
            try {
              if (el.labels && el.labels[0]) return (el.labels[0].textContent || "").trim().slice(0, 80);
              if (el.id) {
                const l = document.querySelector('label[for="' + el.id + '"]');
                if (l) return (l.textContent || "").trim().slice(0, 80);
              }
              const par = el.closest("label");
              if (par) return (par.textContent || "").trim().slice(0, 80);
            } catch {}
            return null;
          };
          const inputs = Array.from(document.querySelectorAll("input, select, textarea"))
            .filter(visible)
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute("type") || null,
              name: el.getAttribute("name") || null,
              id: el.id || null,
              placeholder: el.getAttribute("placeholder") || null,
              aria: el.getAttribute("aria-label") || null,
              autocomplete: el.getAttribute("autocomplete") || null,
              dataTest: el.getAttribute("data-testid") || el.getAttribute("data-test") || null,
              label: labelOf(el),
            }));
          const buttons = Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"]'))
            .filter(visible)
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              text: ((el.innerText || el.value || "") + "").trim().slice(0, 80),
              id: el.id || null,
              dataTest: el.getAttribute("data-testid") || el.getAttribute("data-test") || null,
              cls: (el.className || "").toString().slice(0, 120),
              type: el.getAttribute("type") || null,
            }))
            .filter((b) => b.text);
          const iframes = Array.from(document.querySelectorAll("iframe")).map((el) => ({
            name: el.getAttribute("name") || null,
            id: el.id || null,
            src: el.getAttribute("src") || null,
            visible: visible(el),
          }));
          return {
            url: location.href,
            title: document.title,
            inputs, buttons, iframes,
            bodyClass: document.body?.className || null,
            bodyText: (document.body?.innerText || "").slice(0, 4000),
          };
        });
        report.steps.push({ label, ...data });
      } catch (e) { report.errors.push(label + ":dom:" + (e?.message ?? e)); }
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const clickByText = async (re) => {
      try {
        return await page.evaluate((rs) => {
          const r = new RegExp(rs, "i");
          const cands = Array.from(document.querySelectorAll('button, a[role="button"], a, input[type="submit"]'));
          for (const el of cands) {
            const t = ((el.innerText || el.value || "") + "").trim();
            if (r.test(t)) {
              const rc = el.getBoundingClientRect();
              if (rc.width > 0 && rc.height > 0) { el.click(); return t; }
            }
          }
          return null;
        }, re.source);
      } catch { return null; }
    };
    try {
      try {
        if (context.__proxyUser) {
          await page.authenticate({ username: context.__proxyUser, password: context.__proxyPass || "" });
        }
      } catch {}
      try { await page.setViewport({ width: 1440, height: 900 }); } catch {}
      try {
        await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
        await page.setExtraHTTPHeaders({ "accept-language": "en-AU,en;q=0.9" });
      } catch {}

      await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await wait(3500);
      await snap("pdp"); await dumpDom("pdp");

      report.atcClicked = await clickByText(/^\\s*(add to cart|add to bag|buy now)\\s*$/);
      await wait(4000);
      await snap("after_atc"); await dumpDom("after_atc");

      report.checkoutClicked = await clickByText(/^\\s*(checkout|check out|secure checkout|proceed to checkout|continue to checkout)\\s*$/);
      try { await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }); }
      catch (e) { report.errors.push("nav:" + (e?.message ?? e)); }
      await wait(4500);
      await snap("checkout_contact"); await dumpDom("checkout_contact");
      try { report.checkoutHost = new URL(page.url()).host; } catch {}

      report.contactContinueClicked = await clickByText(/continue to shipping|continue|next/);
      await wait(4000);
      await snap("checkout_after_continue"); await dumpDom("checkout_after_continue");

      return { ok: true, report };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e), report };
    }
  };`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const reqUrl = new URL(req.url);
  const action = reqUrl.searchParams.get("action");
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method !== "POST" && !(req.method === "GET" && action === "stage")) {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  // Stage callback path — called from the Browserless function/page to update
  // the current checkout step label. Auth is the unguessable jobId UUID; no
  // executor token (the headless page cannot attach headers reliably).
  if (action === "stage") {
    const jobId = reqUrl.searchParams.get("jobId");
    if (!jobId) return new Response("missing jobId", { status: 400, headers: cors });
    let s: { stage?: string } = { stage: reqUrl.searchParams.get("stage") ?? undefined };
    if (!s.stage && req.method !== "GET") {
      try {
        const text = await req.text();
        if (text) s = JSON.parse(text);
      } catch {}
    }
    if (s.stage) {
      await supa
        .from("checkout_jobs")
        .update({ stage: s.stage })
        .eq("id", jobId)
        .in("status", ["pending", "running"]);
    }
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

  const runWorker = async () => {
  await supa.from("checkout_jobs").update({
    status: "running",
    stage: "checkout_start",
  }).eq("id", jobId);

  if (!BROWSERLESS_KEY) {
    await supa.from("checkout_jobs").update({
      status: "failed", stage: "transport", error: "BROWSERLESS_API_KEY missing on server",
    }).eq("id", jobId);
    await fireTerminalWebhook(supa, jobId, "failed", job, { message: "BROWSERLESS_API_KEY missing on server" });
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
    // Accept several common proxy notations and normalise to a Browserless
    // proxy URL (`http://user:pass@host:port`). Without this, formats like
    // `host:port:user:pass` get sent as `http://host:port:user:pass`, which
    // is invalid and silently fails the upstream navigation.
    const normalizeProxy = (raw: string): string => {
      let p = String(raw || "").trim();
      if (!p) return "";
      const validPort = (port: string | undefined): boolean => {
        if (!/^\d{1,5}$/.test(port || "")) return false;
        const n = Number(port);
        return n > 0 && n <= 65535;
      };
      const withAuth = (scheme: string, host: string, port: string, user?: string, pass?: string): string => {
        if (!host || !validPort(port)) return "";
        if (user !== undefined || pass !== undefined) {
          if (!user || pass === undefined || pass === "") return "";
          return scheme + "://" + encodeURIComponent(user) + ":" + encodeURIComponent(pass) + "@" + host + ":" + port;
        }
        return scheme + "://" + host + ":" + port;
      };
      // Strip an existing scheme to inspect the body uniformly.
      const schemeMatch = p.match(/^(https?|socks5?):\/\//i);
      const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "http";
      if (schemeMatch) p = p.slice(schemeMatch[0].length);
      // Already in user:pass@host:port form.
      if (p.includes("@")) {
        const at = p.lastIndexOf("@");
        const auth = p.slice(0, at);
        const hostPort = p.slice(at + 1);
        const [user, ...passParts] = auth.split(":");
        const [host, port] = hostPort.split(":");
        return withAuth(scheme, host, port, decodeURIComponent(user || ""), decodeURIComponent(passParts.join(":")));
      }
      const parts = p.split(":");
      if (parts.length === 2) {
        // host:port (no auth)
        return withAuth(scheme, parts[0], parts[1]);
      }
      if (parts.length === 4) {
        const looksHostPortFirst = validPort(parts[1]);
        const looksHostPortLast = validPort(parts[3]);
        // Prefer `host:port:user:pass` when the 2nd segment looks like a port.
        if (looksHostPortFirst && !looksHostPortLast) {
          return withAuth(scheme, parts[0], parts[1], parts[2], parts[3]);
        }
        // Otherwise assume `user:pass:host:port`.
        if (looksHostPortLast) return withAuth(scheme, parts[2], parts[3], parts[0], parts[1]);
      }
      // Unknown — pass through with scheme so Browserless surfaces the error.
      return scheme + "://" + p;
    };
    const proxyUrl = normalizeProxy(input.proxy);
    if (proxyUrl) {
      // Chromium does NOT parse `user:pass@` from --proxy-server, so we pass
      // only host:port via Chrome launch args and forward credentials through
      // context for page.authenticate() inside the script. This is the only
      // reliable way to use third-party authenticated proxies on Browserless.
      try {
        const u = new URL(proxyUrl);
        const scheme = u.protocol.replace(/:$/, "");
        const hostPort = `${u.hostname}:${u.port}`;
        url.searchParams.set("launch", JSON.stringify({ args: [`--proxy-server=${scheme}://${hostPort}`] }));
        (input as any).__proxyUser = u.username ? decodeURIComponent(u.username) : "";
        (input as any).__proxyPass = u.password ? decodeURIComponent(u.password) : "";
      } catch {
        // fall through; Browserless will surface the error
      }
    }

  }
  // Browserless plan supports up to 15-min /function sessions.
  // 360s gives generous headroom for slow Shopify checkouts incl. 3-D Secure.
  url.searchParams.set("timeout", "360000");
  url.searchParams.set("blockAds", "true");
  url.searchParams.set("stealth", "true");

  // No external abort. The Browserless `/function` call is bounded by its own
  // `timeout=360000` query param, and we always write a terminal row in the
  // try/catch below — even if the call returns garbage or throws. The old 90s
  // launch watchdog was killing real checkouts that had already taken money
  // because in-page stage callbacks (cross-origin POSTs from inside Shopify)
  // are unreliable, so `stage` stayed at "launch" while payment completed.
  // Stage write from Deno-side BEFORE handing off to Browserless. Guarantees
  // the UI advances off "Starting checkout" even if every in-page beacon dies.
  await writeStage(supa, jobId, "payment_submitting");
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: checkoutScriptSource(),
        context: {
          input,
          stageUrl: selfUrl.toString(),
          twoCaptchaKey: Deno.env.get("TWOCAPTCHA_API_KEY") ?? "",
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const errMsg = "Browserless HTTP " + res.status + ": " + text.slice(0, 400);
      await supa.from("checkout_jobs").update({
        status: "failed", stage: "transport", error: errMsg,
      }).eq("id", jobId);
      await fireTerminalWebhook(supa, jobId, "failed", job, { message: errMsg });
      return new Response("browserless error", { status: 502, headers: cors });
    }
    const result = await res.json().catch(() => null);
    if (!result || typeof result !== "object") {
      await supa.from("checkout_jobs").update({
        status: "failed", stage: "transport", error: "Browserless returned non-JSON",
      }).eq("id", jobId);
      await fireTerminalWebhook(supa, jobId, "failed", job, { message: "Browserless returned non-JSON" });
      return new Response("bad json", { status: 502, headers: cors });
    }


    // Translate runner result into the true outcome:
    // - paymentRejected (Shopify showed a decline message) => failed/payment_declined
    // - ok + dryRun => succeeded/dry_run_done
    // - ok + (orderId or thank-you URL) => succeeded/confirm
    // - ok but no confirmation signal => failed/confirm_uncertain (don't false-positive)
    // - !ok => failed with the runner's failedStep + error
    const finalUrlStr: string = typeof result?.finalUrl === "string" ? result.finalUrl : "";
    const looksConfirmed = !!result?.orderId || /\/thank_you|orders\//i.test(finalUrlStr);
    let outStatus: "succeeded" | "failed";
    let outStage: string;
    let outError: string | null;
    if (result?.ok && result?.paymentRejected) {
      outStatus = "failed";
      outStage = "payment_declined";
      outError = (result.paymentMessage as string) || "Payment declined";
    } else if (result?.ok && result?.dryRun) {
      outStatus = "succeeded"; outStage = "dry_run_done"; outError = null;
    } else if (result?.ok && looksConfirmed) {
      outStatus = "succeeded"; outStage = "confirm"; outError = null;
    } else if (result?.ok) {
      outStatus = "failed"; outStage = "confirm_uncertain";
      outError = "Order outcome uncertain (no order id or thank-you URL). Payment may have completed — verify in bank / Shopify order email.";
    } else {
      outStatus = "failed";
      outStage = (result?.failedStep as string) ?? "unknown";
      outError = (result?.error as string) ?? "unknown";
    }
    await supa.from("checkout_jobs").update({
      status: outStatus, stage: outStage, result, error: outError,
    }).eq("id", jobId);
    console.log("[run-checkout] terminal", jobId, outStatus, outStage, outError ?? "");
    const elapsedMs = Date.now() - (Date.parse(job?.created_at ?? "") || Date.now());
    await fireTerminalWebhook(supa, jobId, outStatus, job, {
      orderId: (result?.orderId as string) ?? null,
      elapsedMs,
      message: outError,
    });
    return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    // Only update if still running — never overwrite a terminal row.
    const transportErr = "transport: " + errorMessage + " (Payment status uncertain — verify in bank / Shopify order email.)";
    await supa.from("checkout_jobs").update({
      status: "failed", stage: "transport", error: transportErr,
    }).eq("id", jobId).in("status", ["pending", "running"]);
    await fireTerminalWebhook(supa, jobId, "failed", job, { message: transportErr });
    return new Response("transport error", { status: 500, headers: cors });

  }
  };

  // Outer safety net: any uncaught throw still marks the row failed instead
  // of silently leaving it `running` forever.
  const workerPromise = runWorker().catch(async (e) => {
    const errorMessage = e instanceof Error ? e.message : String(e);
    const crashErr = "worker crashed: " + errorMessage + " (Payment status uncertain — verify in bank / Shopify order email.)";
    try {
      await supa.from("checkout_jobs").update({
        status: "failed", stage: "transport", error: crashErr,
      }).eq("id", jobId).in("status", ["pending", "running"]);
      await fireTerminalWebhook(supa, jobId, "failed", job, { message: crashErr });
    } catch {}
    return new Response("worker crashed", { status: 500, headers: cors });
  });

  const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(workerPromise);
    return new Response(JSON.stringify({ ok: true, accepted: true }), {
      status: 202,
      headers: { ...cors, "content-type": "application/json" },
    });
  }
  return await workerPromise;
});
