import assert from "node:assert/strict";
import {
  DISNEY_GE_MID,
  DISNEY_ORIGIN,
  DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
  disneyController,
  disneyUrls,
  parseDisneyProductUrl,
  resolveDisneyPid,
  resolveDisneyPdpUrl,
  parseDisneyPdp,
  parseMiniCartHtml,
  parseCsrfGenerateJson,
  extractAkamaiScriptPath,
  looksLikeAkamaiDenied,
} from "./disney-session.js";
import { buildAddToCartFields } from "./disney-cart.js";
import { buildGetCartTokenParams } from "./bandai-ge-http.js";
import {
  DISNEY_GLOBALE_MID,
  DISNEY_GE_MERCHANT_HASHED,
  DISNEY_GE_ENCODED_MERCHANT,
  DISNEY_GE_SECURE,
  DISNEY_GE_WEBSERVICES,
  DISNEY_GE_ISSUER_ACTION,
} from "./disney-ge.js";
import { disneyAdapter } from "./disney.js";

assert.equal(DISNEY_GE_MID, "1696");
assert.equal(DISNEY_GLOBALE_MID, "1696");
assert.equal(DISNEY_GE_MERCHANT_HASHED, "mZ25");
assert.equal(DISNEY_GE_ENCODED_MERCHANT, "8u87");
assert.equal(DISNEY_GE_SECURE, "https://secure.ges.global-e.com");
assert.equal(DISNEY_GE_WEBSERVICES, "https://webservices.global-e.com");
assert.match(DISNEY_GE_ISSUER_ACTION, /handlecreditcardrequestV2/i);
assert.notEqual(DISNEY_GE_MID, "1925");
assert.notEqual(DISNEY_GE_ENCODED_MERCHANT, "8urc");
assert.notEqual(DISNEY_GE_ENCODED_MERCHANT, "8u22");

assert.equal(
  disneyController("Cart-AddProduct"),
  `${DISNEY_ORIGIN}/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/Cart-AddProduct`,
);

const urls = disneyUrls();
assert.ok(urls.csrf.endsWith("/CSRF-Generate"));
assert.ok(urls.geCartToken.endsWith("/Globale-GetCartToken"));
assert.ok(urls.recaptchaEnterprise.endsWith("/Google-reCaptchaEnterprise"));

const p = parseDisneyProductUrl(
  "https://www.disneystore.com.au/disney-lorcana-trading-card-game-by-ravensburger-gateway-050368983992.html",
);
assert.equal(p.pid, "050368983992");
assert.equal(p.isNz, false);
assert.ok(p.slug.includes("lorcana"));

const nz = parseDisneyProductUrl(
  "https://www.disneystore.com.au/nz/stitch-foldable-backpack-lilo-stitch-442031042213.html",
);
assert.equal(nz.pid, "442031042213");
assert.equal(nz.isNz, true);

assert.equal(
  resolveDisneyPid({
    pdpUrl:
      "https://www.disneystore.com.au/disney-lorcana-trading-card-game-by-ravensburger-gateway-050368983992.html",
  }),
  "050368983992",
);
assert.equal(resolveDisneyPid({ pid: "123456789012" }), "123456789012");

assert.ok(resolveDisneyPdpUrl({}).includes("disneystore.com.au"));
assert.ok(resolveDisneyPdpUrl({ pid: "050368983992" }).includes("050368983992"));

const csrf = parseCsrfGenerateJson({
  csrf: { tokenName: "csrf_token", token: "ABC123" },
});
assert.equal(csrf.tokenName, "csrf_token");
assert.equal(csrf.token, "ABC123");
assert.equal(parseCsrfGenerateJson({ error: {} }), null);

const fields = buildAddToCartFields({
  pid: "050368983992",
  quantity: 2,
  csrf,
});
assert.equal(fields.pid, "050368983992");
assert.equal(fields.quantity, "2");
assert.equal(fields.csrf_token, "ABC123");

const pdpHtml = `
<title>Disney Lorcana Gateway</title>
<input type="hidden" class="add-to-cart-url" value="/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/Cart-AddProduct" />
<button class="add-to-cart primary-add-to-cart" data-pid="050368983992" data-sitekey="${DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY}">Add to Bag</button>
<div id="g-recaptch" data-recaptcha-url="https://www.disneystore.com.au/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/Google-reCaptcha" data-recaptcha-enterprise-url="https://www.disneystore.com.au/on/demandware.store/Sites-DisneyStoreAUNZ-Site/en_AU/Google-reCaptchaEnterprise"></div>
{"availability":"online - in_stock"}
`;
const parsed = parseDisneyPdp(pdpHtml);
assert.equal(parsed.pid, "050368983992");
assert.equal(parsed.available, true);
assert.ok(parsed.addToCartUrl.includes("Cart-AddProduct"));
assert.equal(parsed.recaptchaSitekey, DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY);

const mini = parseMiniCartHtml(
  `<div class="minibag__inner-content minibag__empty" data-tealium-basketData="{&quot;cart_total_items&quot;:0}"></div>`,
);
assert.equal(mini.empty, true);
assert.equal(mini.itemCount, 0);

assert.equal(
  looksLikeAkamaiDenied(
    `<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>https://errors.edgesuite.net/18.x</BODY></HTML>`,
    403,
  ),
  true,
);

const akPath = extractAkamaiScriptPath(
  `<script src="/w0N2Bq/HEw42m/J1-2kI/5Ln5-r/f93ph8SQ1QGkfh3Owu/Qk1QICEi/Ah/ZxVX1fRjQB"></script>
   <script src="/on/demandware.static/Sites-DisneyStoreAUNZ-Site/-/en_AU/v1/js/main.js"></script>`,
);
assert.ok(akPath.startsWith("/w0N2Bq/"));

// GE builder parameterized — Disney mid, not Bandai default when passed.
const gct = buildGetCartTokenParams({
  merchantId: DISNEY_GE_MID,
  merchantCartToken: "CART_X",
  webStoreCode: "disneystore.com.au",
  webStoreInstanceCode: "au",
});
assert.equal(gct.MerchantId, "1696");
assert.equal(gct.WebStoreCode, "disneystore.com.au");
assert.notEqual(gct.MerchantId, "1925");

assert.equal(disneyAdapter.id, "disney");
assert.equal(disneyAdapter.matches("www.disneystore.com.au"), true);
assert.equal(disneyAdapter.matches("shopdisney.com.au"), true);
assert.equal(disneyAdapter.matches("disneystore.com"), false);
assert.equal(disneyAdapter.matches("p-bandai.com"), false);

console.log("disney-session.test.mjs: ok");
