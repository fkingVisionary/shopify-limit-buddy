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
import {
  extractGeCheckoutGuid,
  parseJsonp,
  buildGetCartTokenParams,
  buildGetCartTokenUrl,
  buildIssuerFormBody,
  extractUrlStructureToken,
  htmlFormValue,
  parseCheckoutV2Form,
  buildHandleActionBodies,
  buildCheckoutSaveBody,
  isBandaiGePaymentRedirectSignal,
  isBandaiGeRedirectDecline,
  decodeCcPaymentRedirectData,
} from "./bandai-ge-http.js";
import { resolveBandaiCheckoutPayPath } from "./bandai.js";

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
// Issuer = HandleCreditCard* family (handleaction/save are not bank)
assert.equal(
  isBandaiGeIssuerPaymentUrl(
    "https://secure-bandai.global-e.com/1/Payments/HandleCreditCardRequestV2/8urc/08f4e43c?mode=1",
  ),
  true,
);
assert.equal(
  isBandaiGeIssuerPaymentUrl(
    "https://secure-bandai.global-e.com/1/Payments/HandleCreditCard/8urc/abc",
  ),
  true,
);
assert.equal(
  isBandaiGeIssuerPaymentUrl(
    "https://secure-bandai.global-e.com/1/checkoutv2/save/x",
  ),
  false,
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
assert.equal(
  extractGeCheckoutGuid(
    "https://secure-bandai.global-e.com/1/Payments/HandleCreditCardRequestV2/8urc/08f4e43c-73ba-4a1e-9c2d-099033fe73ba?mode=1",
  ),
  "08f4e43c-73ba-4a1e-9c2d-099033fe73ba",
);
assert.equal(
  extractGeCheckoutGuid(
    "https://webservices.global-e.com/checkoutv2/handleaction/2/099033fe-73ba-4a1e-9c2d-08f4e43c73ba/8urc",
  ),
  "099033fe-73ba-4a1e-9c2d-08f4e43c73ba",
);
assert.deepEqual(
  parseJsonp('callback_1({"Success":true,"CartToken":"bbb30554-2fd8-4780-995a-e4d29201cf96"})'),
  { Success: true, CartToken: "bbb30554-2fd8-4780-995a-e4d29201cf96" },
);
assert.deepEqual(
  parseJsonp('({"Success":true,"CartToken":"aaa30554-2fd8-4780-995a-e4d29201cf96"})'),
  { Success: true, CartToken: "aaa30554-2fd8-4780-995a-e4d29201cf96" },
);
const gct = buildGetCartTokenParams({
  merchantCartToken: "CART_Checkout_suffix",
  area: "au",
});
assert.equal(gct.MerchantCartToken, "CART_Checkout_suffix");
assert.equal(gct.MerchantId, "1925");
assert.equal(gct.WebStoreInstanceCode, "au");
assert.ok(buildGetCartTokenUrl({ merchantCartToken: "X" }).includes("/Checkout/GetCartToken?"));
assert.ok(
  buildIssuerFormBody({
    card: { number: "4111111111111111", expMonth: "07", expYear: "31", cvv: "123" },
    cartToken: "guid",
    machineId: "m",
    urlStructureToken: "jwt",
  }).includes("PaymentData.cartToken=guid"),
);
assert.equal(
  extractUrlStructureToken('name="PaymentData.UrlStructureTokenEncoded" value="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb"'),
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb",
);

// --- Checkout/v2 form scrape + handleaction bodies (GEM wire) ---
const checkoutHtml = `
<select id="ShippingStateID" name="CheckoutData.ShippingStateID">
  <option value="">Please select</option>
  <option data-code="QLD" selected="selected" value="49181">Queensland</option>
</select>
<input name="CheckoutData.ShippingCountryID" value="14" />
<input name="CheckoutData.ShippingAddress1" value="1/133 Allenby Road" />
<input name="CheckoutData.ShippingCity" value="Alexandra Hills" />
<input name="CheckoutData.ShippingZIP" value="4160" />
<input name="CheckoutData.ShippingFirstName" value="Niamh" />
<input name="CheckoutData.ShippingLastName" value="Erin" />
<input name="CheckoutData.Email" value="a@b.com" />
<input name="CheckoutData.ShippingPhone" value="+61402601618" />
<input name="CheckoutData.CultureID" value="2057" />
<input name="CheckoutData.SelectedPaymentMethodID" value="1" />
<input name="CheckoutData.CurrentPaymentGayewayID" value="2" />
<input name="CheckoutData.ShippingType" value="ShippingSameAsBilling" checked />
`;
assert.equal(htmlFormValue(checkoutHtml, "CheckoutData.ShippingStateID"), "49181");
const form = parseCheckoutV2Form(checkoutHtml);
assert.equal(form.shipping.StateId, "49181");
assert.equal(form.shipping.Zip, "4160");
assert.equal(form.hasAddress, true);
const bodies = buildHandleActionBodies(form, { cartToken: "guid-1", shippingMethodId: "99" });
assert.equal(bodies[1].Action, 1);
assert.equal(bodies[1].Token, "guid-1");
assert.equal(bodies[1].ShippingData.StateId, "49181");
assert.equal(bodies[1].ShippingMethodID, "99");
assert.equal(bodies[2].Action, 2);
assert.equal(bodies[3].Action, 3);
assert.equal(bodies[1].MerchantId, 1925);

const saveBody = buildCheckoutSaveBody(form, {
  cartToken: "guid-1",
  shippingMethodId: "99",
  paymentMethodId: "1",
  gatewayId: "2",
  machineId: "blackbox-iovation-test-value-0123456789",
  forterToken: "forter-test-token",
  selectedTaxOption: "3",
});
assert.match(saveBody, /ioBlackBox=blackbox-iovation/);
assert.match(saveBody, /ForterToken=forter-test-token/);
assert.match(saveBody, /SelectedTaxOption=3/);
const saveBadTax = buildCheckoutSaveBody(form, {
  cartToken: "guid-1",
  selectedTaxOption: "{{:value}}",
  machineId: "x",
});
assert.equal(/SelectedTaxOption=/.test(saveBadTax), false);

// ReloadBehaviour-only JWT must NOT score as bank
const reloadJwt =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  Buffer.from(
    JSON.stringify([
      { Key: "ReloadBehaviour", Value: "Redirect" },
      { Key: "finalizeProcess", Value: "1" },
    ]),
  )
    .toString("base64url") +
  ".sig";
assert.equal(
  isBandaiGePaymentRedirectSignal(`https://webservices.global-e.com/payments/CCPaymentRedirect?Data=${reloadJwt}`),
  false,
);
const bankJwt =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  Buffer.from(JSON.stringify([{ Key: "TransactionStatus", Value: "Declined" }])).toString(
    "base64url",
  ) +
  ".sig";
assert.equal(
  isBandaiGePaymentRedirectSignal(`https://webservices.global-e.com/payments/CCPaymentRedirect?Data=${bankJwt}`),
  true,
);
assert.ok(Array.isArray(decodeCcPaymentRedirectData(reloadJwt)));

// AutherizationFailed + TransactionId = bank hit (decline), not DataCorruption
const authFailJwt =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  Buffer.from(
    JSON.stringify([
      { Key: "ReloadBehaviour", Value: "Redirect" },
      { Key: "TransactionStatusType", Value: "AutherizationFailed" },
      { Key: "TransactionId", Value: "170555028" },
      { Key: "Success", Value: "False" },
      { Key: "MerchantId", Value: "1925" },
      {
        Key: "PaymentErrorBody",
        Value: "Your payment couldn’t be completed, and you weren’t charged.",
      },
    ]),
  )
    .toString("base64url") +
  ".sig";
const authFailUrl = `https://webservices.global-e.com/payments/CCPaymentRedirect?Data=${authFailJwt}`;
assert.equal(isBandaiGePaymentRedirectSignal(authFailUrl), true);
assert.equal(isBandaiGeRedirectDecline(authFailUrl), true);

// --- Fast vs Safe pay path (ATC always HTTP) ---
assert.equal(resolveBandaiCheckoutPayPath({}).mode, "fast");
assert.equal(resolveBandaiCheckoutPayPath({}).placeOrderGeHttp, true);
assert.equal(resolveBandaiCheckoutPayPath({ bandaiCheckoutMode: "safe" }).mode, "safe");
assert.equal(resolveBandaiCheckoutPayPath({ bandaiCheckoutMode: "safe" }).placeOrderGe, true);
assert.equal(resolveBandaiCheckoutPayPath({ bandaiCheckoutMode: "safe" }).placeOrderGeHttp, false);
assert.equal(resolveBandaiCheckoutPayPath({ bandaiBrowserCheckout: true }).mode, "safe");
assert.equal(resolveBandaiCheckoutPayPath({ bandaiBrowserFull: true }).mode, "full");

console.log("bandai-flow.test.mjs ok");
