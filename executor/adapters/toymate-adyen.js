// Toymate Adyen v3 (scheme) helpers — HTTP only (no Playwright in module path).
// Isolated from Kmart / Paydock.
// Research UI tooling (Playwright) lives in experiments/ — never import it from adapters.

import https from "node:https";
import forge from "node-forge";

export const BC_INTERNAL_HEADER =
  "This API endpoint is for internal use only and may change in the future";

export function storefrontPaymentHeaders(jar, ua, extra = {}) {
  const d = jar?.dump?.() || {};
  const headers = {
    "user-agent": ua,
    accept: "application/vnd.bc.v1+json",
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    "X-API-INTERNAL": BC_INTERNAL_HEADER,
    origin: "https://toymate.com.au",
    referer: "https://toymate.com.au/checkout",
    ...extra,
  };
  if (d["XSRF-TOKEN"]) {
    try {
      headers["x-xsrf-token"] = decodeURIComponent(d["XSRF-TOKEN"]);
    } catch {
      headers["x-xsrf-token"] = d["XSRF-TOKEN"];
    }
  }
  if (d["SF-CSRF-TOKEN"]) {
    try {
      headers["x-sf-csrf-token"] = decodeURIComponent(d["SF-CSRF-TOKEN"]);
    } catch {
      headers["x-sf-csrf-token"] = d["SF-CSRF-TOKEN"];
    }
  }
  return headers;
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            Origin: "https://toymate.com.au",
            Referer: "https://toymate.com.au/",
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          },
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(d));
            } catch (e) {
              reject(e);
            }
          });
        },
      )
      .on("error", reject);
  });
}

export async function fetchAdyenPublicKey(clientKey) {
  const json = await httpsJson(
    `https://checkoutshopper-live.adyen.com/checkoutshopper/v1/clientKeys/${clientKey}`,
  );
  if (!json?.publicKey) throw new Error("Adyen publicKey missing for clientKey");
  return json.publicKey;
}

function encryptAdyenField(publicKey, dataObj) {
  const [expHex, modHex] = String(publicKey).split("|");
  const modulus = new forge.jsbn.BigInteger(modHex, 16);
  const exponent = new forge.jsbn.BigInteger(expHex, 16);
  const pub = forge.pki.setRsaPublicKey(modulus, exponent);
  const plain = JSON.stringify(dataObj);
  const aesKey = forge.random.getBytesSync(32);
  const iv = forge.random.getBytesSync(16);
  const cipher = forge.cipher.createCipher("AES-CBC", aesKey);
  cipher.start({ iv });
  cipher.update(forge.util.createBuffer(plain, "utf8"));
  cipher.finish();
  const encrypted = cipher.output.getBytes();
  const encryptedKey = pub.encrypt(aesKey, "RSAES-PKCS1-V1_5");
  return (
    "adyenjs_0_1_25$" +
    forge.util.encode64(encryptedKey) +
    "$" +
    forge.util.encode64(iv + encrypted)
  );
}

/**
 * Encrypt PAN/exp/cvc for Adyen Components-style paymentMethod payload.
 */
export async function encryptAdyenCard({
  clientKey,
  number,
  expMonth,
  expYear,
  cvv,
  holder,
} = {}) {
  const publicKey = await fetchAdyenPublicKey(clientKey);
  const generationtime = new Date().toISOString();
  const month = String(expMonth || "").padStart(2, "0").slice(-2);
  let year = String(expYear || "").trim();
  if (year.length === 2) year = `20${year}`;
  return {
    type: "scheme",
    holderName: String(holder || "Cardholder").trim(),
    encryptedCardNumber: encryptAdyenField(publicKey, {
      number: String(number || "").replace(/\s+/g, ""),
      generationtime,
    }),
    encryptedExpiryMonth: encryptAdyenField(publicKey, {
      expiryMonth: month,
      generationtime,
    }),
    encryptedExpiryYear: encryptAdyenField(publicKey, {
      expiryYear: year,
      generationtime,
    }),
    encryptedSecurityCode: encryptAdyenField(publicKey, {
      cvc: String(cvv || "").trim(),
      generationtime,
    }),
  };
}

export function browserInfo() {
  return {
    color_depth: 24,
    java_enabled: false,
    language: "en-AU",
    screen_height: 1080,
    screen_width: 1920,
    time_zone_offset: String(-new Date().getTimezoneOffset()),
  };
}

/** Pick Adyen v3 scheme (card) method from Storefront payments list. */
export function pickAdyenCardMethod(methods) {
  const list = Array.isArray(methods) ? methods : [];
  return (
    list.find((m) => m?.id === "scheme" && /adyen/i.test(String(m.gateway || ""))) ||
    list.find((m) => m?.id === "scheme") ||
    list.find((m) => /adyen/i.test(String(m.gateway || "")) && m?.method === "scheme") ||
    null
  );
}

function jarCookie(jar, name) {
  const d = jar?.dump?.() || {};
  const raw = d[name];
  if (raw == null) return null;
  try {
    return decodeURIComponent(String(raw));
  } catch {
    return String(raw);
  }
}

async function readCheckoutBootstrap(request, ctx, ua, apex) {
  const res = await request(`${apex}/checkout`, {
    headers: {
      "user-agent": ua,
      accept: "text/html,application/xhtml+xml",
      referer: `${apex}/`,
    },
  }, ctx);
  const html = await res.text().catch(() => "");
  const sfToken =
    html.match(/storefront_api\\":\{\\"token\\":\\"([^\\]+)\\"/)?.[1] ||
    html.match(/"storefront_api"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/)?.[1] ||
    null;
  const storeHash =
    html.match(/"storeHash"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/storeHash\\":\\"([^\\]+)\\"/)?.[1] ||
    "cf7jv97qb3";
  return { status: res.status, html, sfToken, storeHash };
}

/**
 * GraphQL Storefront completeCheckout → orderEntityId + paymentAccessToken.
 * Docs: checkout { completeCheckout(...) { orderEntityId paymentAccessToken } }
 */
async function completeCheckoutGraphql(request, ctx, { apex, ua, jar, sfToken, checkoutId }) {
  const headers = {
    "user-agent": ua,
    accept: "application/json",
    "content-type": "application/json",
    origin: apex,
    referer: `${apex}/checkout`,
    Authorization: `Bearer ${sfToken}`,
  };
  const xsrf = jarCookie(jar, "XSRF-TOKEN");
  const sf = jarCookie(jar, "SF-CSRF-TOKEN");
  if (xsrf) headers["x-xsrf-token"] = xsrf;
  if (sf) headers["x-sf-csrf-token"] = sf;

  const attempts = [
    {
      name: "gql_nested",
      query: `mutation completeCheckout($completeCheckoutInput: CompleteCheckoutInput!) {
        checkout {
          completeCheckout(input: $completeCheckoutInput) {
            orderEntityId
            paymentAccessToken
          }
        }
      }`,
      variables: { completeCheckoutInput: { checkoutEntityId: checkoutId } },
    },
    {
      name: "gql_value",
      query: `mutation completeCheckout($completeCheckoutInput: CompleteCheckoutInput!) {
        checkout {
          completeCheckout(input: $completeCheckoutInput) {
            orderEntityId
            paymentAccessToken { value }
          }
        }
      }`,
      variables: { completeCheckoutInput: { checkoutEntityId: checkoutId } },
    },
  ];

  for (const a of attempts) {
    const res = await request(
      `${apex}/graphql`,
      { method: "POST", headers, body: JSON.stringify({ query: a.query, variables: a.variables }) },
      ctx,
    );
    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    const node = json?.data?.checkout?.completeCheckout || json?.data?.completeCheckout;
    const patRaw = node?.paymentAccessToken;
    const pat = typeof patRaw === "string" ? patRaw : patRaw?.value || null;
    const orderId = node?.orderEntityId || null;
    if (res.status >= 200 && res.status < 300 && (pat || orderId) && !json?.errors?.length) {
      return {
        ok: true,
        via: a.name,
        status: res.status,
        orderId,
        payToken: pat,
        body: text.slice(0, 240),
      };
    }
    if (a === attempts[attempts.length - 1]) {
      return {
        ok: false,
        via: a.name,
        status: res.status,
        orderId: null,
        payToken: null,
        body: text.slice(0, 240),
        errors: json?.errors?.[0]?.message || null,
      };
    }
  }
  return { ok: false, via: null, status: null, orderId: null, payToken: null, body: "" };
}

/**
 * HTTP place-order (module path — no Playwright):
 * 1) spam-protection (soft on 429)
 * 2) GraphQL completeCheckout → PAT (preferred) or internalapi order
 * 3) BigPay POST /stores/{hash}/payments with card instrument
 */
export async function placeOrderViaHttp({
  request,
  ctx,
  userAgent,
  checkoutId,
  card,
  captchaToken = null,
  profile = {},
} = {}) {
  const apex = "https://toymate.com.au";
  const ua = userAgent || "Mozilla/5.0";
  const jar = ctx?.jar;
  const headers = storefrontPaymentHeaders(jar, ua, { accept: "application/json" });
  const logs = [];

  if (captchaToken) {
    const spam = await request(
      `${apex}/api/storefront/checkouts/${checkoutId}/spam-protection`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          spamProtection: { method: "recaptcha_v2", token: captchaToken },
        }),
      },
      ctx,
    );
    const spamText = await spam.text().catch(() => "");
    logs.push({ step: "spam", status: spam.status, body: spamText.slice(0, 160) });
    // Soft-continue on 429 — BC has been rate-limiting spam while order/pay may still work.
    if (!(spam.status >= 200 && spam.status < 300) && spam.status !== 429) {
      return {
        ok: false,
        declined: false,
        note: `http spam ${spam.status}`,
        paymentLogs: logs,
      };
    }
  }

  const methodsRes = await request(
    `${apex}/api/storefront/payments?cartId=${checkoutId}`,
    { headers: storefrontPaymentHeaders(jar, ua) },
    ctx,
  );
  const methods = await methodsRes.json().catch(() => null);
  const adyen = pickAdyenCardMethod(methods);
  logs.push({
    step: "methods",
    status: methodsRes.status,
    body: adyen ? `${adyen.gateway}/${adyen.id}` : "none",
  });
  if (!adyen) {
    return { ok: false, declined: false, note: "http: no Adyen scheme", paymentLogs: logs };
  }

  const boot = await readCheckoutBootstrap(request, ctx, ua, apex);
  logs.push({
    step: "checkout_boot",
    status: boot.status,
    body: `sf=${Boolean(boot.sfToken)} hash=${boot.storeHash}`,
  });

  let orderId = null;
  let payToken = null;
  let orderVia = null;

  if (boot.sfToken) {
    const gql = await completeCheckoutGraphql(request, ctx, {
      apex,
      ua,
      jar,
      sfToken: boot.sfToken,
      checkoutId,
    });
    logs.push({
      step: "complete_checkout",
      status: gql.status,
      body: `${gql.via || ""} ${gql.errors || gql.body || ""}`.slice(0, 200),
    });
    if (gql.ok) {
      orderId = gql.orderId;
      payToken = gql.payToken;
      orderVia = "graphql";
    }
  }

  // Fallback: Optimized Checkout internal order create (returns token when not 429).
  if (!payToken) {
    const orderRes = await request(
      `${apex}/internalapi/v1/checkout/order`,
      {
        method: "POST",
        headers: {
          ...headers,
          accept: "application/json, text/plain, */*",
          "x-requested-with": "XMLHttpRequest",
        },
        body: JSON.stringify({}),
      },
      ctx,
    );
    const orderText = await orderRes.text().catch(() => "");
    logs.push({ step: "order_create", status: orderRes.status, body: orderText.slice(0, 240) });
    if (orderRes.status >= 200 && orderRes.status < 300) {
      let orderJson = null;
      try {
        orderJson = JSON.parse(orderText);
      } catch {
        /* ignore */
      }
      orderId =
        orderJson?.data?.order?.orderId || orderJson?.orderId || orderJson?.id || orderId;
      payToken =
        orderJson?.data?.order?.token ||
        orderJson?.data?.token ||
        orderJson?.token ||
        orderJson?.payment?.token ||
        null;
      orderVia = "internalapi";
    }
  }

  if (!payToken) {
    return {
      ok: false,
      declined: false,
      note: `http no paymentAccessToken (gql/internal blocked — often spam/order 429)`,
      paymentLogs: logs,
      orderId,
    };
  }

  const number = String(card.number || "").replace(/\s+/g, "");
  const expMonth = Number(String(card.expMonth || "").padStart(2, "0").slice(-2));
  let expYear = Number(String(card.expYear || "").trim());
  if (expYear > 0 && expYear < 100) expYear += 2000;
  const holder =
    card.holder || `${profile.first_name || "Test"} ${profile.last_name || "Buyer"}`;
  const cvv = String(card.cvv || "").trim();

  // Docs: Adyen V3 OAuth supports raw card on Payments API.
  const paymentMethodIds = [
    `${adyen.gateway}.card`,
    `${adyen.gateway}.${adyen.id}`,
    adyen.id === "scheme" ? "adyenv3.card" : null,
  ].filter(Boolean);

  const payHeaders = {
    "user-agent": ua,
    accept: "application/vnd.bc.v1+json",
    "content-type": "application/json",
    Authorization: `PAT ${payToken}`,
    origin: apex,
    referer: `${apex}/checkout`,
  };

  let payRes = null;
  let payText = "";
  let usedMethod = null;
  for (const paymentMethodId of paymentMethodIds) {
    const payBody = {
      payment: {
        instrument: {
          type: "card",
          number,
          cardholder_name: holder,
          expiry_month: expMonth,
          expiry_year: expYear,
          verification_value: cvv,
        },
        payment_method_id: paymentMethodId,
      },
    };
    payRes = await request(
      `https://payments.bigcommerce.com/stores/${boot.storeHash}/payments`,
      {
        method: "POST",
        headers: payHeaders,
        body: JSON.stringify(payBody),
      },
      ctx,
    );
    payText = await payRes.text().catch(() => "");
    usedMethod = paymentMethodId;
    logs.push({
      step: "bigpay",
      status: payRes.status,
      body: `${paymentMethodId} ${payText}`.slice(0, 300),
    });
    // Retry next method id only on clear method errors.
    if (
      payRes.status >= 200 &&
      payRes.status < 300
    ) {
      break;
    }
    if (!/payment_method|not supported|invalid.*method/i.test(payText)) break;
  }

  // Optional CSE fallback if raw card rejected (hosted-form stores).
  if (payRes && !(payRes.status >= 200 && payRes.status < 300)) {
    const clientKey = adyen.initializationData?.clientKey || adyen.config?.clientKey;
    if (clientKey) {
      try {
        const encrypted = await encryptAdyenCard({
          clientKey,
          number,
          expMonth: card.expMonth,
          expYear: card.expYear,
          cvv,
          holder,
        });
        const encRes = await request(
          "https://payments.bigcommerce.com/api/public/v1/orders/payments",
          {
            method: "POST",
            headers: {
              "user-agent": ua,
              accept: "application/json",
              "content-type": "application/json",
              Authorization: `PAT ${payToken}`,
              origin: apex,
              referer: `${apex}/checkout`,
            },
            body: JSON.stringify({
              payment: {
                payment_method_id: usedMethod || `${adyen.gateway}.${adyen.id}`,
                ...(orderId ? { orderId: String(orderId) } : {}),
                paymentData: JSON.stringify({
                  paymentMethod: encrypted,
                  browserInfo: browserInfo(),
                  clientStateDataIndicator: true,
                  origin: apex,
                }),
              },
            }),
          },
          ctx,
        );
        const encText = await encRes.text().catch(() => "");
        logs.push({ step: "bigpay_cse", status: encRes.status, body: encText.slice(0, 300) });
        if (encRes.status >= 200 && encRes.status < 300) {
          payRes = encRes;
          payText = encText;
        } else if (/declin|refused|insufficient|invalid card/i.test(encText)) {
          payRes = encRes;
          payText = encText;
        }
      } catch (e) {
        logs.push({ step: "bigpay_cse", status: null, body: e?.message || String(e) });
      }
    }
  }

  const declined =
    /declin|refused|insufficient|invalid card|not enough|do not honour|payment_failed|"status"\s*:\s*"error"/i.test(
      payText,
    ) && !/unauthorized/i.test(payText);
  const orderNumber =
    payText.match(/order(?:_?(?:number|id))?["']?\s*:\s*["']?(\d{5,})/i)?.[1] ||
    (orderId ? String(orderId) : null);

  if (declined) {
    return {
      ok: true,
      declined: true,
      status: payRes?.status ?? null,
      note: payText.replace(/\s+/g, " ").slice(0, 180),
      orderNumber: null,
      paymentLogs: logs,
      orderVia,
    };
  }
  if (payRes && payRes.status >= 200 && payRes.status < 300) {
    return {
      ok: true,
      declined: false,
      status: payRes.status,
      note: orderNumber ? `order ${orderNumber}` : `bigpay ${payRes.status}`,
      orderNumber,
      paymentLogs: logs,
      orderVia,
    };
  }
  return {
    ok: false,
    declined: false,
    status: payRes?.status ?? null,
    note: `http pay ${payRes?.status}: ${payText.replace(/\s+/g, " ").slice(0, 140)}`,
    paymentLogs: logs,
    orderVia,
  };
}

