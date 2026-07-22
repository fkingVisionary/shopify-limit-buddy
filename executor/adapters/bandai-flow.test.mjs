// Offline Bandai flow invariants — no network. Run: node adapters/bandai-flow.test.mjs
import assert from "node:assert/strict";
import {
  isBandaiF5Gated,
  pickBandaiSensors,
  parseBandaiProxy,
} from "./bandai-f5.js";
import {
  extractCsrfFromHtml,
  extractPreloadSuffix,
  bandaiApiHeaders,
  normalizeBandaiArea,
} from "./bandai-session.js";
import { findCartLine, listCartLines } from "./bandai-cart.js";
import {
  isBandaiGeCheckoutPayFrame,
  isBandaiGeAuthPaymentUrl,
  isBandaiGeChargeRequest,
  isBandaiGeHandleAction,
  isBandaiGeIssuerPaymentUrl,
  bandaiGeHandleActionId,
} from "./bandai-ge-pay.js";

// --- F5 gate matrix ---
assert.equal(isBandaiF5Gated("POST", "/login"), true);
assert.equal(isBandaiF5Gated("POST", "/login/"), true);
assert.equal(isBandaiF5Gated("POST", "https://p-bandai.com/login"), true);
assert.equal(isBandaiF5Gated("POST", "/api/cart/addToCart"), true);
assert.equal(isBandaiF5Gated("POST", "/api/cart/addtocart"), true);
assert.equal(isBandaiF5Gated("PUT", "/api/cart/modifyCartItem"), true);
assert.equal(isBandaiF5Gated("PUT", "/api/cart/modifycartitem?cartItemSn=1&qty=1"), true);
assert.equal(isBandaiF5Gated("POST", "/api/cart/1515791/checkout"), true);
assert.equal(isBandaiF5Gated("GET", "/api/cart/detail"), false);
assert.equal(isBandaiF5Gated("POST", "/api/products/search"), false);
assert.equal(isBandaiF5Gated("GET", "/login"), false);

// --- Sensor pick ---
const sensors = pickBandaiSensors({
  "P8komysnbc-abc": "v1",
  "p8komysnbc-xyz": "v2",
  "x-csrf-token": "nope",
  Cookie: "SESSION=1",
});
assert.deepEqual(sensors, {
  "p8komysnbc-abc": "v1",
  "p8komysnbc-xyz": "v2",
});
assert.deepEqual(pickBandaiSensors({}), {});

// --- Proxy parse ---
const hp = parseBandaiProxy("1.2.3.4:8000:user:p%40ss");
assert.match(hp.url, /^http:\/\/user:p/);
assert.equal(hp.playwright.server, "http://1.2.3.4:8000");
assert.equal(hp.playwright.username, "user");
const at = parseBandaiProxy("user:pass@host.example:60000");
assert.equal(at.playwright.server, "http://host.example:60000");
assert.equal(parseBandaiProxy("").url, null);

// --- CSRF / PRELOAD extract ---
const csrf = extractCsrfFromHtml(`
  <script>window.USER_DATA = { csrfToken: "csrf-from-html-99" };</script>
`);
assert.equal(csrf, "csrf-from-html-99");
assert.equal(
  extractCsrfFromHtml(`<meta name="csrf-token" content="meta-csrf" />`),
  "meta-csrf",
);

const suffix = extractPreloadSuffix(`
  PRELOAD_DATA = { globaleMerchantCartTokenSuffix: "AbCdEf123" };
`);
assert.equal(suffix, "AbCdEf123");

// merchantCartToken formula (contract)
const cartId = "CART99";
const merchantCartToken = `${cartId}_Checkout_${suffix}`;
assert.equal(merchantCartToken, "CART99_Checkout_AbCdEf123");

// --- Area headers ---
const h = bandaiApiHeaders({ csrfToken: "t", area: "us", referer: "https://p-bandai.com/us/" });
assert.equal(h["x-g1-area-code"], "us");
assert.equal(h["x-csrf-token"], "t");
assert.equal(h["x-requested-with"], "XMLHttpRequest");
assert.equal(normalizeBandaiArea("jp"), null);

// --- Nested cart walk ---
const cartJson = {
  subCarts: [
    {
      cartSn: "1515791",
      cartId: "CID1",
      cartType: "normal",
      combinedShippings: [
        {
          lineItems: [
            {
              cartLineItemSn: "LISN-9",
              product: { areaItemNo: "AAI0013787AU", qty: 1 },
            },
          ],
        },
      ],
    },
  ],
};
const line = findCartLine(cartJson, "AAI0013787AU");
assert.equal(line.cartSn, "1515791");
assert.equal(line.cartId, "CID1");
assert.equal(line.cartItemSn, "LISN-9");
assert.equal(line.areaItemNo, "AAI0013787AU");
assert.equal(findCartLine(cartJson, "NOPE"), null);
assert.equal(listCartLines(cartJson).length, 1);
assert.equal(listCartLines(cartJson)[0].cartItemSn, "LISN-9");

// --- GE pay frame / auth URL (single-flight Pay contract) ---
assert.equal(
  isBandaiGeCheckoutPayFrame("https://webservices.global-e.com/Checkout/v2/abc"),
  true,
);
assert.equal(
  isBandaiGeCheckoutPayFrame("https://secure-bandai.global-e.com/payments/CreditCardForm/x"),
  false,
);
assert.equal(isBandaiGeAuthPaymentUrl("https://webservices.global-e.com/ProcessPayment"), true);
assert.equal(isBandaiGeAuthPaymentUrl("https://cdn.global-e.com/static.js"), false);
assert.equal(
  isBandaiGeChargeRequest("POST", "https://webservices.global-e.com/Checkout/ProcessPayment"),
  true,
);
assert.equal(
  isBandaiGeChargeRequest("POST", "https://web-bandai.global-e.com/shared/prefetcher/1925/AU"),
  false,
);
assert.equal(isBandaiGeChargeRequest("GET", "https://webservices.global-e.com/ProcessPayment"), false);
// Issuer = HandleCreditCardRequestV2 only (handleaction/save are not bank)
assert.equal(
  isBandaiGeIssuerPaymentUrl(
    "https://secure-bandai.global-e.com/1/Payments/HandleCreditCardRequestV2/8urc/08f4e43c?mode=1",
  ),
  true,
);
assert.equal(
  isBandaiGeChargeRequest(
    "POST",
    "https://secure-bandai.global-e.com/1/Payments/HandleCreditCardRequestV2/8urc/x",
  ),
  true,
);
assert.equal(
  isBandaiGeChargeRequest(
    "POST",
    "https://webservices.global-e.com/checkoutv2/handleaction/3/099033fe-73ba/8urc",
  ),
  false,
);
assert.equal(
  isBandaiGeHandleAction(
    "https://webservices.global-e.com/checkoutv2/handleaction/2/099033fe-73ba/8urc",
  ),
  true,
);
assert.equal(
  isBandaiGeChargeRequest("POST", "https://gem-bandai.global-e.com/includes/js/1925"),
  false,
);
assert.equal(
  bandaiGeHandleActionId(
    "https://webservices.global-e.com/checkoutv2/handleaction/2/099033fe-73ba/8urc",
  ),
  2,
);
assert.equal(
  bandaiGeHandleActionId(
    "https://webservices.global-e.com/checkoutv2/handleaction/1/abc/8urc",
  ),
  1,
);

console.log("bandai-flow.test.mjs ok");
