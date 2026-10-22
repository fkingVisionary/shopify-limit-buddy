import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeDispatcher, createJar } from "../http.js";
import {
  runShopify,
  resolveCheckoutUrl,
  classifyCartAddError,
  normalizeStore,
  shopifyAdapter,
} from "./shopify.js";

// ── Pure helpers ───────────────────────────────────────────────────────────

test("normalizeStore strips trailing slash and lowercases host", () => {
  assert.deepEqual(normalizeStore("https://Shop.MyShopify.com/"), {
    base: "https://shop.myshopify.com",
    host: "shop.myshopify.com",
  });
  assert.deepEqual(normalizeStore("deathwishcoffee.com"), {
    base: "https://deathwishcoffee.com",
    host: "deathwishcoffee.com",
  });
});

test("shopifyAdapter only claims *.myshopify.com", () => {
  assert.equal(shopifyAdapter.matches("hydrogen-preview.myshopify.com"), true);
  assert.equal(shopifyAdapter.matches("myshopify.com"), true);
  assert.equal(shopifyAdapter.matches("www.kmart.com.au"), false);
  assert.equal(shopifyAdapter.matches("allbirds.com"), false);
});

test("resolveCheckoutUrl pulls the real checkout out of a shop.app universal redirect", () => {
  const base = "https://graphql.myshopify.com";
  const real = "https://graphql.myshopify.com/checkouts/cn/ABC123/en-ca?_r=xyz&skip_shop_pay=true";
  const loc =
    "https://shop.app/checkout/13120893/cn/ABC123/en-ca/shoppay?redirect_source=checkout_universal_redirect" +
    `&ur_back_url=${encodeURIComponent(real)}&shop_pay_token=zzz`;
  assert.equal(resolveCheckoutUrl(loc, base), real);
});

test("resolveCheckoutUrl accepts a direct same-host /checkouts redirect", () => {
  const base = "https://shop.myshopify.com";
  const loc = "/checkouts/cn/TOKEN?key=1";
  assert.equal(resolveCheckoutUrl(loc, base), "https://shop.myshopify.com/checkouts/cn/TOKEN?key=1");
});

test("resolveCheckoutUrl returns null for an unrecognised redirect", () => {
  assert.equal(resolveCheckoutUrl("https://evil.example.com/login", "https://shop.myshopify.com"), null);
  assert.equal(resolveCheckoutUrl(null, "https://shop.myshopify.com"), null);
});

test("classifyCartAddError distinguishes sold-out / selling-plan / bad-variant / limit", () => {
  assert.equal(classifyCartAddError(422, '{"description":"All 3 Snowboard are in your cart."}').reason, "quantity_limit");
  assert.equal(
    classifyCartAddError(422, '{"description":"The product is sold out."}').reason,
    "sold_out",
  );
  assert.equal(
    classifyCartAddError(422, '{"description":"Variant can only be purchased with a selling plan."}').reason,
    "selling_plan_required",
  );
  assert.equal(classifyCartAddError(404, '{"description":"Cannot find variant"}').reason, "variant_not_found");
  assert.equal(classifyCartAddError(429, "Too Many Requests").reason, "rate_limited");
});

// ── End-to-end against an in-process mock Shopify store ──────────────────────
//
// localhost is in the executor's no_proxy set, so request()'s undici dispatcher
// connects straight to this server — exercising the real cookie jar + redirect
// handling without touching the network.

const VARIANTS = {
  1001: { ok: true, title: "Good Thing", price: 2500, available: true },
  2002: { ok: false, status: 422, body: { description: "The product is sold out.", status: 422 } },
  3003: {
    ok: false,
    status: 422,
    body: { description: "Variant can only be purchased with a selling plan.", status: 422 },
  },
  4004: { ok: false, status: 404, body: { description: "Cannot find variant", status: 404 } },
};

function startMockStore() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    hits.push(`${req.method} ${u.pathname}`);
    const json = (code, obj, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const html = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };

    if (req.method === "GET" && u.pathname === "/") {
      return html(200, "<!doctype html><html><body>home</body></html>", {
        "set-cookie": "cart_currency=USD; path=/",
      });
    }
    if (req.method === "GET" && /^\/products\/[^/]+\.js$/.test(u.pathname)) {
      return json(200, {
        title: "Good Thing",
        variants: [
          { id: 1001, title: "Default", price: 2500, available: true },
          { id: 2002, title: "Sold Out", price: 2500, available: false },
        ],
      });
    }
    if (req.method === "POST" && u.pathname === "/cart/add.js") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      return req.on("end", () => {
        let id = 0;
        try {
          id = Number(JSON.parse(raw).items?.[0]?.id);
        } catch {
          /* ignore */
        }
        const v = VARIANTS[id];
        if (!v || !v.ok) {
          return json(v?.status ?? 422, v?.body ?? { description: "Cart Error", status: 422 });
        }
        return json(200, { items: [{ id, quantity: 1 }], item_count: 1 }, {
          "set-cookie": "cart=TOKEN123; path=/",
        });
      });
    }
    if (req.method === "GET" && u.pathname === "/cart.js") {
      return json(200, {
        token: "TOKEN123",
        item_count: 1,
        total_price: 2500,
        currency: "USD",
        items: [{ id: 1001, quantity: 1 }],
      });
    }
    if (req.method === "POST" && u.pathname === "/cart") {
      // Modern universal redirect: 302 to shop.app with the real checkout in ur_back_url.
      const real = `http://${req.headers.host}/checkouts/cn/TOKEN123?_r=abc`;
      const loc =
        `https://shop.app/checkout/1/cn/TOKEN123/en/shoppay?redirect_source=checkout_universal_redirect` +
        `&ur_back_url=${encodeURIComponent(real)}`;
      res.writeHead(302, { location: loc });
      return res.end();
    }
    if (req.method === "GET" && /^\/checkouts\/cn\//.test(u.pathname)) {
      return html(
        200,
        '<html><head><meta name="serialized-session-token" content="abc"/></head><body>Checkout</body></html>',
      );
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}`, hits });
    });
  });
}

async function runAgainstMock(task) {
  const { server, base, hits } = await startMockStore();
  const dispatcher = makeDispatcher(null, { forceUndici: true });
  const jar = createJar();
  const progressSteps = [];
  const ctx = { dispatcher, jar, onProgress: (s) => progressSteps.push(s) };
  try {
    const out = await runShopify({ storeUrl: base, taskId: "t1", qty: 1, ...task }, ctx);
    return { out, hits, progressSteps };
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
    await new Promise((r) => server.close(r));
  }
}

test("runShopify: happy path adds to cart and resolves the checkout URL (no payment)", async () => {
  const { out, hits } = await runAgainstMock({ variantId: 1001, handle: "good-thing" });
  assert.equal(out.ok, true);
  assert.equal(out.checkoutStage, "checkout_ready");
  assert.equal(out.dryRun, true);
  assert.equal(out.adapter, "shopify");
  assert.equal(out.shopify.reachedCheckout, true);
  assert.match(out.shopify.checkoutUrl, /\/checkouts\/cn\/TOKEN123/);
  assert.match(out.shopify.checkoutUrl, /skip_shop_pay=true/);
  assert.equal(out.shopify.cart.itemCount, 1);
  assert.equal(out.shopify.cart.totalPrice, "25.00");
  assert.equal(out.shopify.variant.available, true);
  // Steps reached checkout confirmation and explicitly skipped payment.
  const names = out.steps.map((s) => s.step);
  assert.deepEqual(
    names.filter((n) => ["cart_add", "cart_get", "cart_checkout", "checkout_page", "payment_skipped"].includes(n)),
    ["cart_add", "cart_get", "cart_checkout", "checkout_page", "payment_skipped"],
  );
  // Never touched a card-vault / completion endpoint.
  assert.equal(
    hits.some((h) => /sessions|deposit|graphql|payments?\b|complete/i.test(h)),
    false,
  );
});

test("runShopify: sold-out variant fails at cart_add with a clear reason", async () => {
  const { out } = await runAgainstMock({ variantId: 2002 });
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, "cart_add");
  assert.equal(out.checkoutStage, "pre_cart");
  assert.match(out.error, /sold_out/);
});

test("runShopify: selling-plan-only variant fails at cart_add", async () => {
  const { out } = await runAgainstMock({ variantId: 3003 });
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, "cart_add");
  assert.match(out.error, /selling_plan_required/);
});

test("runShopify: unknown variant fails as variant_not_found", async () => {
  const { out } = await runAgainstMock({ variantId: 4004 });
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, "cart_add");
  assert.match(out.error, /variant_not_found/);
});

test("runShopify: emits progress steps mapping to warm → product → cart → details", async () => {
  const { progressSteps } = await runAgainstMock({ variantId: 1001, handle: "good-thing" });
  assert.ok(progressSteps.includes("warm_home"));
  assert.ok(progressSteps.includes("cart_add"));
  assert.ok(progressSteps.includes("cart_get"));
  assert.ok(progressSteps.includes("cart_checkout"));
});
