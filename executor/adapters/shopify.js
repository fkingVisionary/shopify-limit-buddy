/**
 * Generic Shopify adapter — add-to-cart + checkout handoff (NO payment).
 *
 * This is the fast, browserless path that current-gen retail bots use for the
 * pre-payment leg of a Shopify checkout. It drives the store's *public,
 * documented* storefront/cart endpoints only:
 *
 *   GET  /                       warm the session (cart currency + _shopify_* cookies)
 *   GET  /products/{handle}.js   optional: verify the variant + report stock (best effort)
 *   POST /cart/add.js            add the variant to the cart (JSON ajax)
 *   GET  /cart.js                read the cart back (item_count / total / token) — win milestone
 *   POST /cart                   hand off to checkout and resolve the real checkout URL
 *
 * It deliberately STOPS before payment. Shopify's card vault + the Checkout One
 * completion API are intentionally out of scope here: the adapter's job is to
 * land a prepared cart and hand back a ready-to-pay checkout URL. A human (or a
 * separate, explicitly-authorized flow) finishes payment.
 *
 * Routing: `matches()` only claims `*.myshopify.com` so the dedicated retailer
 * adapters (kmart/toymate/bandai/pkc/disney) always win first. `runShopify` is
 * also used by the generic fallback in checkout.js for custom-domain Shopify
 * stores, so there is exactly one implementation.
 *
 * Checkout-One note: a modern `POST /cart` 302s to the Shop Pay "universal
 * redirect" on shop.app, with the store's real `/checkouts/cn/{token}` URL
 * tucked into the `ur_back_url` query param. We extract that rather than
 * following the redirect onto shop.app.
 */

import { request } from "../http.js";

const now = () => Date.now();

/** Normalise a store URL to `{ base, host }` (origin, no trailing slash). */
export function normalizeStore(storeUrl) {
  const raw = String(storeUrl || "").trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(withScheme);
  return { base: `${u.protocol}//${u.host}`, host: u.host.toLowerCase() };
}

/**
 * Given a redirect `Location` from `POST /cart`, return the store's real
 * checkout URL — or null if the redirect didn't land somewhere we recognise.
 *
 *  • Shop Pay universal redirect (shop.app) → pull `ur_back_url`.
 *  • Direct same-host `/checkouts/...` or `/checkout` → use as-is.
 */
export function resolveCheckoutUrl(location, base) {
  if (!location) return null;
  let u;
  try {
    u = new URL(location, base);
  } catch {
    return null;
  }
  const baseHost = (() => {
    try {
      return new URL(base).host.toLowerCase();
    } catch {
      return "";
    }
  })();

  // Universal redirect (shop.app / pay.shopify.com) carries the real checkout
  // URL in ur_back_url. Prefer it over ever touching the Shop Pay host.
  const back = u.searchParams.get("ur_back_url");
  if (back) {
    try {
      return new URL(back, base).toString();
    } catch {
      /* fall through */
    }
  }

  // Direct checkout redirect on the same shop host.
  if (u.host.toLowerCase() === baseHost && /\/checkouts?(\/|$)/i.test(u.pathname)) {
    return u.toString();
  }

  // Some stores redirect to a dedicated checkout host (e.g. checkout.<brand>).
  if (/\/checkouts?(\/|$)/i.test(u.pathname)) {
    return u.toString();
  }

  return null;
}

/** Force `skip_shop_pay=true` so the checkout page renders instead of bouncing to Shop Pay. */
function withSkipShopPay(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("skip_shop_pay")) u.searchParams.set("skip_shop_pay", "true");
    return u.toString();
  } catch {
    return url;
  }
}

/** Heuristic: does this HTML look like a real Shopify checkout page? */
function looksLikeCheckout(html) {
  return /serialized-session-?token|checkout-web|Shopify\.Checkout|__st\b|<title>\s*Checkout/i.test(
    String(html || ""),
  );
}

/**
 * Classify a `/cart/add.js` failure body into a human-readable reason + a
 * stable `reason` code so the UI can colour sold-out vs. bad-variant vs. limit.
 */
export function classifyCartAddError(status, bodyText) {
  let description = `HTTP ${status}`;
  let message = null;
  try {
    const j = JSON.parse(bodyText);
    description = j.description || j.message || description;
    message = j.message || null;
  } catch {
    const t = String(bodyText || "").trim();
    if (t) description = t.slice(0, 200);
  }
  const hay = `${description} ${message || ""}`.toLowerCase();
  let reason = "cart_add_failed";
  if (status === 404 || /cannot find variant|not found/.test(hay)) reason = "variant_not_found";
  else if (/sold out|out of stock|unavailable|can't be purchased|cannot be purchased|no longer available/.test(hay))
    reason = "sold_out";
  else if (/selling plan/.test(hay)) reason = "selling_plan_required";
  else if (
    /maximum|only \d+|limit|you can only add|can't add more|cannot add more|are in your cart|\d+ left|exceeds/.test(hay)
  )
    reason = "quantity_limit";
  else if (status === 429) reason = "rate_limited";
  return { reason, description };
}

const JSON_HEADERS = (base) => ({
  accept: "application/json, text/javascript, */*; q=0.01",
  "x-requested-with": "XMLHttpRequest",
  referer: `${base}/`,
  origin: base,
});

const HTML_HEADERS = (base, referer) => ({
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "upgrade-insecure-requests": "1",
  referer: referer || `${base}/`,
});

/**
 * Run the Shopify add-to-cart + checkout-handoff chain. Never submits payment.
 *
 * @param {object} task  { taskId, storeUrl, variantId, qty, handle?, pdpUrl? }
 * @param {object} ctx   { dispatcher, jar, onProgress?, steps? }
 */
export async function runShopify(task, ctx) {
  const t0 = now();
  const { base, host } = normalizeStore(task.storeUrl);
  const variantId = Number(task.variantId);
  const qty = Math.max(1, Number(task.qty ?? 1) || 1);
  const steps = Array.isArray(ctx.steps) ? ctx.steps : (ctx.steps = []);
  const progress = (name) => {
    try {
      ctx.onProgress?.(name);
    } catch {
      /* progress must never break checkout */
    }
  };

  const step = (name, ok, status, ms, note) => {
    steps.push({ step: name, ok, status, ms, note });
    return { name, ok, status, ms, note };
  };

  const shopify = {
    reachedCheckout: false,
    checkoutUrl: null,
    cart: null,
    variant: null,
  };

  const done = (extra) => ({
    taskId: task.taskId,
    adapter: "shopify",
    dryRun: true, // ATC-only: this adapter never places an order
    elapsedMs: now() - t0,
    steps,
    cookies: ctx.jar?.dump?.() ?? {},
    finalUrl: shopify.checkoutUrl || `${base}/cart`,
    shopify,
    ...extra,
  });

  const fail = (failedStep, error, checkoutStage = "pre_cart") =>
    done({ ok: false, failedStep, error, checkoutStage });

  // ── 1. Warm the session ────────────────────────────────────────────────
  progress("warm_home");
  {
    const s = now();
    try {
      const res = await request(`${base}/`, { method: "GET", headers: HTML_HEADERS(base) }, ctx);
      await res.text();
      step("warm_home", res.status < 400, res.status, now() - s, `${host}`);
    } catch (e) {
      // Non-fatal: ATC can still work from a cold jar on most stores.
      step("warm_home", false, null, now() - s, e?.message ?? String(e));
    }
  }

  // ── 2. Optional variant / stock verify (best effort) ────────────────────
  const handle = typeof task.handle === "string" && task.handle ? task.handle : handleFromPdp(task.pdpUrl);
  if (handle) {
    progress("product_get");
    const s = now();
    try {
      const res = await request(
        `${base}/products/${encodeURIComponent(handle)}.js`,
        { method: "GET", headers: JSON_HEADERS(base) },
        ctx,
      );
      const body = await res.text();
      if (res.status < 400) {
        const prod = JSON.parse(body);
        const v = (prod.variants || []).find((x) => Number(x.id) === variantId) || null;
        if (v) {
          shopify.variant = {
            id: v.id,
            title: [prod.title, v.title].filter(Boolean).join(" · "),
            price: typeof v.price === "number" ? (v.price / 100).toFixed(2) : String(v.price ?? ""),
            available: Boolean(v.available),
          };
          step(
            "product_get",
            true,
            res.status,
            now() - s,
            `${shopify.variant.title} · ${shopify.variant.available ? "available" : "SOLD OUT"}`,
          );
        } else {
          step("product_get", true, res.status, now() - s, `variant ${variantId} not in product`);
        }
      } else {
        step("product_get", false, res.status, now() - s, body.slice(0, 120));
      }
    } catch (e) {
      step("product_get", false, null, now() - s, e?.message ?? String(e));
    }
  }

  // ── 3. Add to cart ──────────────────────────────────────────────────────
  progress("cart_add");
  {
    const s = now();
    try {
      const res = await request(
        `${base}/cart/add.js`,
        {
          method: "POST",
          headers: { ...JSON_HEADERS(base), "content-type": "application/json" },
          body: JSON.stringify({ items: [{ id: variantId, quantity: qty }] }),
          allowMutationRetry: false,
        },
        ctx,
      );
      const body = await res.text();
      if (res.status >= 400) {
        const { reason, description } = classifyCartAddError(res.status, body);
        step("cart_add", false, res.status, now() - s, `${reason}: ${description}`);
        return fail("cart_add", `${reason}: ${description}`);
      }
      step("cart_add", true, res.status, now() - s, `variant ${variantId} ×${qty}`);
    } catch (e) {
      step("cart_add", false, null, now() - s, e?.message ?? String(e));
      return fail("cart_add", e?.message ?? String(e));
    }
  }

  // ── 4. Read the cart back — this is the "cart win" milestone ────────────
  progress("cart_get");
  {
    const s = now();
    try {
      const res = await request(`${base}/cart.js`, { method: "GET", headers: JSON_HEADERS(base) }, ctx);
      const body = await res.text();
      if (res.status >= 400) {
        step("cart_get", false, res.status, now() - s, body.slice(0, 120));
        return fail("cart_get", `cart.js HTTP ${res.status}`, "cart_atc");
      }
      const cart = JSON.parse(body);
      shopify.cart = {
        token: cart.token ?? null,
        itemCount: Number(cart.item_count ?? 0),
        totalPrice:
          typeof cart.total_price === "number" ? (cart.total_price / 100).toFixed(2) : null,
        currency: cart.currency ?? null,
      };
      const ok = shopify.cart.itemCount > 0;
      step(
        "cart_get",
        ok,
        res.status,
        now() - s,
        `items=${shopify.cart.itemCount} total=${shopify.cart.totalPrice ?? "?"} ${shopify.cart.currency ?? ""}`.trim(),
      );
      if (!ok) return fail("cart_get", "cart is empty after add", "cart_atc");
    } catch (e) {
      step("cart_get", false, null, now() - s, e?.message ?? String(e));
      return fail("cart_get", e?.message ?? String(e), "cart_atc");
    }
  }

  // ── 5. Checkout handoff — resolve the real checkout URL (no submit) ──────
  progress("cart_checkout");
  {
    const s = now();
    try {
      const res = await request(
        `${base}/cart`,
        {
          method: "POST",
          headers: {
            ...HTML_HEADERS(base, `${base}/cart`),
            "content-type": "application/x-www-form-urlencoded",
            origin: base,
          },
          body: new URLSearchParams({ checkout: "" }).toString(),
          allowMutationRetry: false,
        },
        ctx,
      );
      await res.text();
      const location = res.headers.get("location");
      const resolved = resolveCheckoutUrl(location, base);
      if (!resolved) {
        step(
          "cart_checkout",
          false,
          res.status,
          now() - s,
          location ? `unrecognised redirect: ${location.slice(0, 160)}` : "no Location header",
        );
        // ATC still succeeded — report cart_atc, not a hard failure.
        return done({
          ok: true,
          checkoutStage: "cart_atc",
          note: "added to cart; checkout URL could not be resolved from redirect",
        });
      }
      shopify.checkoutUrl = withSkipShopPay(resolved);
      step("cart_checkout", true, res.status, now() - s, shopify.checkoutUrl);
    } catch (e) {
      step("cart_checkout", false, null, now() - s, e?.message ?? String(e));
      return done({ ok: true, checkoutStage: "cart_atc", note: `ATC ok; handoff error: ${e?.message ?? e}` });
    }
  }

  // ── 6. Confirm the checkout page loads (GET only — nothing submitted) ───
  {
    const s = now();
    try {
      const res = await request(
        shopify.checkoutUrl,
        { method: "GET", headers: HTML_HEADERS(base, `${base}/cart`) },
        ctx,
      );
      const html = await res.text();
      const ok = res.status < 400 && looksLikeCheckout(html);
      shopify.reachedCheckout = ok;
      step(
        "checkout_page",
        ok,
        res.status,
        now() - s,
        ok ? `${html.length}b checkout page` : `status=${res.status} checkout markers=${looksLikeCheckout(html)}`,
      );
    } catch (e) {
      step("checkout_page", false, null, now() - s, e?.message ?? String(e));
    }
  }

  // Explicitly mark that payment is intentionally not attempted.
  step("payment_skipped", true, null, 0, "ATC-only adapter — payment left to the operator");

  return done({
    ok: true,
    checkoutStage: shopify.reachedCheckout ? "checkout_ready" : "cart_atc",
  });
}

/** Pull a product handle out of a PDP URL like `/products/the-thing?variant=123`. */
function handleFromPdp(pdpUrl) {
  if (typeof pdpUrl !== "string" || !pdpUrl) return null;
  const m = pdpUrl.match(/\/products\/([a-z0-9][a-z0-9-]*)/i);
  return m?.[1] ?? null;
}

export const shopifyAdapter = {
  id: "shopify",
  matches(hostArg) {
    const host = String(hostArg || "").toLowerCase();
    return host === "myshopify.com" || host.endsWith(".myshopify.com");
  },
  async run(task, ctx) {
    return runShopify(task, ctx);
  },
};
