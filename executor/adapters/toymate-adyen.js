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

/**
 * HTTP place-order via BC internal order create + BigPay payments.
 * Prefer this over Playwright when spam-protection has cleared (no CF Turnstile).
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
  const clientKey = adyen.initializationData?.clientKey || adyen.config?.clientKey;
  if (!clientKey) {
    return { ok: false, declined: false, note: "http: missing Adyen clientKey", paymentLogs: logs };
  }

  const encrypted = await encryptAdyenCard({
    clientKey,
    number: card.number,
    expMonth: card.expMonth,
    expYear: card.expYear,
    cvv: card.cvv,
    holder: card.holder || `${profile.first_name || "Test"} ${profile.last_name || "Buyer"}`,
  });

  // Create order (BC Optimized Checkout internal API).
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
  if (!(orderRes.status >= 200 && orderRes.status < 300)) {
    return {
      ok: false,
      declined: false,
      note: `http order_create ${orderRes.status}`,
      paymentLogs: logs,
    };
  }
  let orderJson = null;
  try {
    orderJson = JSON.parse(orderText);
  } catch {
    /* ignore */
  }
  const orderId = orderJson?.data?.order?.orderId || orderJson?.orderId || orderJson?.id || null;
  const payToken =
    orderJson?.data?.order?.token ||
    orderJson?.data?.token ||
    orderJson?.token ||
    orderJson?.payment?.token ||
    null;

  const payHeaders = {
    "user-agent": ua,
    accept: "application/json",
    "content-type": "application/json",
    origin: apex,
    referer: `${apex}/checkout`,
  };
  // Prefer PAT-only for BigPay when we have a payment token.
  if (payToken) payHeaders.Authorization = `PAT ${payToken}`;

  const payBody = {
    payment: {
      payment_method_id: `${adyen.gateway}.${adyen.id}`,
      methodId: adyen.id,
      gatewayId: adyen.gateway,
      ...(orderId ? { orderId: String(orderId) } : {}),
      paymentData: JSON.stringify({
        paymentMethod: encrypted,
        browserInfo: browserInfo(),
        clientStateDataIndicator: true,
        origin: apex,
      }),
    },
  };

  const payRes = await request(
    "https://payments.bigcommerce.com/api/public/v1/orders/payments",
    {
      method: "POST",
      headers: payHeaders,
      body: JSON.stringify(payBody),
    },
    ctx,
  );
  const payText = await payRes.text().catch(() => "");
  logs.push({ step: "bigpay", status: payRes.status, body: payText.slice(0, 300) });

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
      status: payRes.status,
      note: payText.replace(/\s+/g, " ").slice(0, 180),
      orderNumber: null,
      paymentLogs: logs,
    };
  }
  if (payRes.status >= 200 && payRes.status < 300) {
    return {
      ok: true,
      declined: false,
      status: payRes.status,
      note: orderNumber ? `order ${orderNumber}` : `bigpay ${payRes.status}`,
      orderNumber,
      paymentLogs: logs,
    };
  }
  return {
    ok: false,
    declined: false,
    status: payRes.status,
    note: `http pay ${payRes.status}: ${payText.replace(/\s+/g, " ").slice(0, 140)}`,
    paymentLogs: logs,
  };
}

