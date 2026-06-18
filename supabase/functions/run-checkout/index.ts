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
            const addressInput = document.querySelector('input[name="checkout[shipping_address][address1]"], input[name="checkout[shipping_address][first_name]"], input[autocomplete="address-line1"], input[autocomplete="given-name"]');
            if (visible(addressInput)) return "contact";

            // Some Shopify checkouts keep the selected shipping rates visible above
            // the payment form. Detect payment before shipping so we do not get
            // stuck re-processing the already-selected shipping section.
            const paymentWidget = Array.from(document.querySelectorAll('iframe[name^="card-fields"], iframe[src*="card" i], input[autocomplete="cc-number"], input[placeholder*="Card number" i], [data-gateway-group], [data-select-gateway], .payment-method-list__item')).find(visible);
            const finalPayButton = Array.from(document.querySelectorAll('button, input[type="submit"]')).some((el) => {
              if (!visible(el) || el.disabled) return false;
              const label = ((el.tagName === "INPUT" ? el.value : el.textContent) || "").trim();
              return /^(pay now|complete order|place order|complete purchase)$/i.test(label);
            });
            const visiblePaymentText = Array.from(document.querySelectorAll('h1, h2, h3, legend, label, [role="heading"], .section__title, .radio__label, .payment-method-list__item')).some((el) => visible(el) && /payment|credit\s*card|card number/i.test(el.textContent || ""));
            const hasCardFields = /card number|expiration date|security code|name on card/i.test(body);
            if ((paymentWidget || hasCardFields) && (finalPayButton || visiblePaymentText) && /payment|credit card|card number/i.test(body)) return "payment";

            const shippingRate = Array.from(document.querySelectorAll('input[name="checkout[shipping_rate][id]"], [data-shipping-method], [data-shipping-method-label-title]')).find(visible);
            const continueToPayment = Array.from(document.querySelectorAll('button, input[type="submit"], #continue_button, .step__footer__continue-btn')).some((el) => {
              if (!visible(el) || el.disabled) return false;
              const label = ((el.tagName === "INPUT" ? el.value : el.textContent) || "").trim();
              return /continue\s+to\s+payment|continue\s+to\s+pay/i.test(label);
            });
            if (shippingRate || (/shipping method/i.test(body) && continueToPayment)) return "shipping_method";
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
            if (preferred === "shipping" && /continue\s+to\s+shipping|shipping method/i.test(text)) score = 0;
            if (preferred === "payment" && /continue\s+to\s+payment|payment method/i.test(text)) score = 0;
            if (/^continue$/i.test(text)) score += 10;
            if (isSubmit) score += 100;
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
        const deadline = Date.now() + 7000;
        let target = null;
        while (Date.now() < deadline) {
          target = await findContinueTarget(allowPaymentSubmit, preferredStep);
          if (target) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!target) throw new Error("Could not find checkout continue button");
        try { await page.mouse.click(target.x, target.y, { delay: 40 }); } catch {}
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
            if (preferred === "shipping" && /continue\s+to\s+shipping|shipping method/i.test(text)) score = 0;
            if (preferred === "payment" && /continue\s+to\s+payment|payment method/i.test(text)) score = 0;
            if (/^continue$/i.test(text)) score += 10;
            if (isSubmit) score += 100;
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
          await new Promise((r) => setTimeout(r, 1200));
          const next = await checkoutStep();
          if (next === "shipping_method" || next === "payment") return true;
          const err = await visibleCheckoutError();
          if (err) throw new Error("Checkout validation: " + err);
        }
        const finalStep = await checkoutStep();
        return finalStep === "shipping_method" || finalStep === "payment";
      };

      const selectShippingRate = async () => {
        if (await isPaymentStep()) return true;
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          if (await isPaymentStep()) return true;
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
              return /continue\s+to\s+payment/i.test(label);
            });
            return canContinue ? { selected: true } : null;
          }).catch(() => null);
          if (target?.selected) return true;
          if (target?.x != null && target?.y != null) {
            await page.mouse.click(target.x, target.y, { delay: 35 }).catch(() => null);
            await new Promise((r) => setTimeout(r, 550));
          } else {
            await new Promise((r) => setTimeout(r, 450));
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
            { timeout: 10000 },
            startUrl,
          ).catch(() => null);
          await new Promise((r) => setTimeout(r, 900));
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
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const bringPaymentIntoView = async () => {
        const deadline = Date.now() + 8000;
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
            const target = els.find((el) => visible(el) && /payment|credit\s*card|card number|cc-number|card-fields|name on card|security code/i.test(descriptor(el)) && !/paypal|afterpay|klarna|zip|bitpay|crypto/i.test(descriptor(el)));
            if (!target) return false;
            target.scrollIntoView({ block: "center", inline: "center" });
            return true;
          }).catch(() => false);
          if (found) {
            await new Promise((r) => setTimeout(r, 700));
            return true;
          }
          await page.evaluate(() => window.scrollBy(0, Math.max(420, Math.floor(window.innerHeight * 0.8)))).catch(() => null);
          await page.keyboard.press("PageDown").catch(() => null);
          await new Promise((r) => setTimeout(r, 450));
        }
        return false;
      };
      await bringPaymentIntoView();

      const selectCreditCardPayment = async () => {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          const target = await page.evaluate(() => {
            const visible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
            };
            const rectFor = (el) => {
              el.scrollIntoView({ block: "center", inline: "center" });
              const r = el.getBoundingClientRect();
              return { x: r.left + Math.min(32, Math.max(12, r.width * 0.12)), y: r.top + r.height / 2 };
            };
            const cssEscape = (value) => (window.CSS?.escape ? CSS.escape(value) : String(value));
            const labelFor = (el) => el.id ? document.querySelector('label[for="' + cssEscape(el.id) + '"]') : null;
            const rowFor = (el) => labelFor(el) || el.closest('label, [role="radio"], .radio-wrapper, [data-select-gateway], [data-gateway-group], .payment-method-list__item, .content-box__row') || el;
            const directTextFor = (el) => [labelFor(el)?.textContent, el.closest("label")?.textContent, el.getAttribute?.("aria-label"), el.value, el.id, el.name].filter(Boolean).join(" ").trim().toLowerCase();
            const isCard = (text) => /credit\s*card|debit\s*card|visa|mastercard|american express|amex|shopify payments|creditcard|card/.test(text) && !/paypal|afterpay|klarna|zip|bitpay|crypto|apple pay|google pay/.test(text);
            const isOffsite = (text) => /paypal|afterpay|klarna|zip|bitpay|crypto|apple pay|google pay/.test(text);
            const isSelected = (el) => {
              if (el.checked || el.getAttribute?.("aria-checked") === "true" || el.getAttribute?.("aria-selected") === "true") return true;
              const row = rowFor(el);
              return !!row?.querySelector?.('input[type="radio"]:checked, [aria-checked="true"], [aria-selected="true"]');
            };
            const hasOpenCardFields = Array.from(document.querySelectorAll('iframe[name*="card-fields" i], iframe[id*="card-fields" i], iframe[src*="card-fields" i], input[autocomplete="cc-number"], input[placeholder*="Card number" i], input[aria-label*="card number" i]')).some(visible);
            const radios = Array.from(document.querySelectorAll('input[type="radio"]')).map((input) => {
              const row = rowFor(input);
              const r = row.getBoundingClientRect();
              return { input, row, directText: directTextFor(input), y: r.top, h: r.height, selected: isSelected(input) };
            }).filter((item) => visible(item.row));
            const cardRadios = radios.filter((item) => isCard(item.directText) || /creditcard|credit-card|credit_card|shopify_payments|card-fields/i.test(item.input.id + " " + item.input.name + " " + item.input.getAttribute("aria-label")));
            const activeOffsite = radios.find((item) => item.selected && isOffsite(item.directText));
            const checkedCard = cardRadios.find((item) => item.selected);
            if (checkedCard && hasOpenCardFields) return { selected: true };

            if (cardRadios[0]) {
              try { cardRadios[0].input.click(); cardRadios[0].row?.click?.(); } catch {}
              return rectFor(cardRadios[0].row || cardRadios[0].input);
            }

            if (hasOpenCardFields && !activeOffsite) return { selected: true };
            const rows = Array.from(document.querySelectorAll('label, [role="radio"], [data-gateway-group], [data-select-gateway], .radio-wrapper, .content-box__row, .radio__label, .payment-method-list__item'));
            for (const row of rows) {
              if (!visible(row)) continue;
              const text = directTextFor(row);
              if (isCard(text)) {
                try { row.querySelector?.('input[type="radio"]')?.click(); row.click?.(); } catch {}
                return rectFor(row);
              }
            }
            return null;
          }).catch(() => false);
          if (target?.selected) return true;
          if (target?.x != null && target?.y != null) {
            await page.mouse.click(target.x, target.y).catch(() => null);
            await new Promise((r) => setTimeout(r, 900));
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
              const isCard = (text) => /credit\s*card|debit\s*card|visa|mastercard|american express|amex|shopify payments|creditcard|card/.test(text) && !/paypal|afterpay|klarna|zip|bitpay|crypto|apple pay|google pay/.test(text);
              const hasCardFields = Array.from(document.querySelectorAll('iframe[name*="card-fields" i], iframe[id*="card-fields" i], iframe[src*="card-fields" i], input[autocomplete="cc-number"], input[placeholder*="Card number" i], input[aria-label*="card number" i]')).some(visible);
              const checkedCard = Array.from(document.querySelectorAll('input[type="radio"]')).some((el) => (el.checked || rowFor(el)?.querySelector?.('input[type="radio"]:checked')) && isCard(directTextFor(el)));
              return hasCardFields && checkedCard;
            }).catch(() => false);
            if (selected) return true;
          }
          await bringPaymentIntoView();
          await new Promise((r) => setTimeout(r, 400));
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
        await new Promise((r) => setTimeout(r, 600));
      } catch {}

      const setIn = async (namePart, value, selectors = []) => {
        const query = ['input[data-current-field="' + namePart + '"], input[id="' + namePart + '"], input[name="' + namePart + '"]', ...selectors, 'input[name*="' + namePart + '" i]'].join(', ');
        const deadline = Date.now() + 10000;
        const expectedDigits = String(value).replace(/\D/g, "");
        const looksFilled = (current) => {
          const v = String(current || "").trim();
          const digits = v.replace(/\D/g, "");
          if (namePart === "number") return digits.endsWith(expectedDigits.slice(-4));
          if (namePart === "expiry") return digits.length >= 4;
          if (namePart === "verification_value") return digits.length >= Math.min(3, expectedDigits.length);
          if (namePart === "name") return v.length >= 2;
          return v.length > 0;
        };
        while (Date.now() < deadline) {
          for (const f of page.frames()) {
            try {
              const els = await f.$$(query);
              for (const el of els) {
                const visible = await f.evaluate((node) => {
                  if (!node) return false;
                  const rect = node.getBoundingClientRect();
                  const style = getComputedStyle(node);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !node.disabled && node.getAttribute("aria-hidden") !== "true" && !node.hasAttribute("data-honeypot-field");
                }, el).catch(() => false);
                if (!visible) continue;

                await el.focus().catch(() => null);
                await el.click({ clickCount: 3 }).catch(() => null);
                await page.keyboard.press("Backspace").catch(() => null);
                await el.type(String(value), { delay: 45 }).catch(() => null);
                const typedValue = await f.evaluate((node) => {
                  node.dispatchEvent(new Event("input", { bubbles: true }));
                  node.dispatchEvent(new Event("change", { bubbles: true }));
                  node.dispatchEvent(new Event("blur", { bubbles: true }));
                  return node.value || node.getAttribute("value") || "";
                }, el).catch(() => "");
                if (looksFilled(typedValue)) return true;

                await el.click({ clickCount: 3 }).catch(() => null);
                await f.evaluate((node, val) => {
                  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  const desc = Object.getOwnPropertyDescriptor(proto, "value");
                  if (desc && desc.set) desc.set.call(node, String(val));
                  else node.value = String(val);
                  node.dispatchEvent(new Event("input", { bubbles: true }));
                  node.dispatchEvent(new Event("change", { bubbles: true }));
                  node.dispatchEvent(new Event("blur", { bubbles: true }));
                }, el, value).catch(() => null);
                const setValue = await f.evaluate((node) => node.value || node.getAttribute("value") || "", el).catch(() => "");
                if (looksFilled(setValue)) return true;
              }
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 350));
        }
        return false;
      };
      const expiryValue = input.card.exp_month.padStart(2, "0") + input.card.exp_year.slice(-2);
      const cardNumberOk = await setIn("number", input.card.number, ['input[autocomplete="cc-number"]', 'input[placeholder*="Card number" i]', 'input[id*="number" i]', 'input[aria-label*="card number" i]']);
      const cardExpiryOk = await setIn("expiry", expiryValue, ['input[name*="exp" i]', 'input[autocomplete="cc-exp"]', 'input[placeholder*="Expiration" i]', 'input[placeholder*="MM" i]', 'input[id*="expiry" i]', 'input[id*="exp" i]', 'input[aria-label*="expiration" i]', 'input[aria-label*="expiry" i]']);
      const cardCvvOk = await setIn("verification_value", input.card.cvv, ['input[name*="security" i]', 'input[name*="cvv" i]', 'input[name*="cvc" i]', 'input[autocomplete="cc-csc"]', 'input[placeholder*="Security" i]', 'input[placeholder*="CVV" i]', 'input[placeholder*="CVC" i]', 'input[id*="verification" i]', 'input[id*="security" i]', 'input[id*="cvv" i]', 'input[id*="cvc" i]', 'input[aria-label*="security" i]']);
      const cardNameOk = await setIn("name_on_card", input.card.name, ['input[autocomplete="cc-name"]', 'input[name*="name_on_card" i]', 'input[name*="cardholder" i]', 'input[placeholder*="Name on card" i]', 'input[placeholder*="Cardholder" i]', 'input[id*="name_on_card" i]', 'input[id*="cardholder" i]', 'input[aria-label*="name on card" i]', 'input[aria-label*="cardholder" i]']);
      if (!cardNumberOk || !cardExpiryOk || !cardCvvOk || !cardNameOk) return await fail("Card form was not available; checkout is likely still waiting on contact or shipping details (number=" + cardNumberOk + " name=" + cardNameOk + " expiry=" + cardExpiryOk + " cvv=" + cardCvvOk + ")");
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
