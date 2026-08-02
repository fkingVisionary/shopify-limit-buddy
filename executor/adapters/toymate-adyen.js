// Toymate Adyen v3 (scheme) helpers — HTTP only (no Playwright in module path).
// Isolated from Kmart / Paydock.
// Research UI tooling (Playwright) lives in experiments/ — never import it from adapters.

import https from "node:https";
import forge from "node-forge";
import { pspPostForensics } from "../pay-forensics.js";

export const BC_INTERNAL_HEADER =
  "This API endpoint is for internal use only and may change in the future";

/** Matches checkout-sdk default request headers (spam/order/payments). */
export const BC_CHECKOUT_SDK_VERSION = "1.793.0";

export function storefrontPaymentHeaders(jar, ua, extra = {}) {
  const d = jar?.dump?.() || {};
  const headers = {
    "user-agent": ua,
    accept: "application/vnd.bc.v1+json",
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    "X-API-INTERNAL": BC_INTERNAL_HEADER,
    "X-Checkout-SDK-Version": BC_CHECKOUT_SDK_VERSION,
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

function storefrontGraphqlHeaders(jar, ua, apex, sfToken) {
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
  return headers;
}

/**
 * checkout-sdk posts spam-protection with body `{ token }` (not nested spamProtection).
 * GraphQL applyCheckoutSpamProtection is the alternate plane when REST 429s.
 */
export async function applySpamProtectionHttp(
  request,
  ctx,
  { apex, ua, jar, checkoutId, captchaToken, sfToken = null, skipRest = false },
) {
  const logs = [];
  let restStatus = null;
  if (!skipRest) {
    const restHeaders = storefrontPaymentHeaders(jar, ua);
    const spam = await request(
      `${apex}/api/storefront/checkouts/${checkoutId}/spam-protection`,
      {
        method: "POST",
        headers: restHeaders,
        body: JSON.stringify({ token: captchaToken }),
      },
      ctx,
    );
    const spamText = await spam.text().catch(() => "");
    restStatus = spam.status;
    logs.push({ step: "spam_rest", status: spam.status, body: spamText.slice(0, 160) });
    if (spam.status >= 200 && spam.status < 300) {
      return { ok: true, via: "rest", status: spam.status, logs };
    }
  }

  if (sfToken) {
    const gqlHeaders = storefrontGraphqlHeaders(jar, ua, apex, sfToken);
    const query = `mutation applyCheckoutSpamProtection($input: ApplyCheckoutSpamProtectionInput!) {
      checkout {
        applyCheckoutSpamProtection(input: $input) {
          checkout { entityId }
        }
      }
    }`;
    const gql = await request(
      `${apex}/graphql`,
      {
        method: "POST",
        headers: gqlHeaders,
        body: JSON.stringify({
          query,
          variables: {
            input: { checkoutEntityId: checkoutId, data: { token: captchaToken } },
          },
        }),
      },
      ctx,
    );
    const gqlText = await gql.text().catch(() => "");
    let gqlJson = null;
    try {
      gqlJson = JSON.parse(gqlText);
    } catch {
      /* ignore */
    }
    const node = gqlJson?.data?.checkout?.applyCheckoutSpamProtection;
    const err =
      gqlJson?.errors?.map((e) => e.message).filter(Boolean).join("; ") || null;
    logs.push({
      step: "spam_gql",
      status: gql.status,
      body: (err || gqlText).slice(0, 160),
    });
    if (gql.status >= 200 && gql.status < 300 && node && !err) {
      return { ok: true, via: "graphql", status: gql.status, logs };
    }
  }

  return {
    ok: false,
    via: null,
    status: restStatus,
    logs,
    note: restStatus != null ? `spam rest ${restStatus}` : "spam gql failed",
  };
}

/**
 * GraphQL Storefront completeCheckout → orderEntityId + paymentAccessToken.
 * Docs: checkout { completeCheckout(...) { orderEntityId paymentAccessToken } }
 */
async function completeCheckoutGraphql(request, ctx, { apex, ua, jar, sfToken, checkoutId }) {
  const headers = storefrontGraphqlHeaders(jar, ua, apex, sfToken);

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
    // Keep last error; try next mutation shape before giving up.
    if (a === attempts[attempts.length - 1] || json?.errors?.length) {
      const errMsg =
        json?.errors?.map((e) => e.message).filter(Boolean).join("; ") || null;
      // If GraphQL returned a structured error, don't bother with alt shapes that share the same root cause (spam).
      if (errMsg && /spam|internal server error|not complete|forbidden/i.test(errMsg)) {
        return {
          ok: false,
          via: a.name,
          status: res.status,
          orderId: null,
          payToken: null,
          body: text.slice(0, 240),
          errors: errMsg,
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
          errors: errMsg,
        };
      }
    }
  }
  return { ok: false, via: null, status: null, orderId: null, payToken: null, body: "" };
}

/**
 * HTTP place-order (module path — no Playwright):
 * 1) spam-protection body `{ token }` (+ GraphQL applyCheckoutSpamProtection)
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
  spamAlreadyCleared = false,
  spamRestAttempted = false,
} = {}) {
  const apex = "https://toymate.com.au";
  const ua = userAgent || "Mozilla/5.0";
  const jar = ctx?.jar;
  const headers = storefrontPaymentHeaders(jar, ua, { accept: "application/json" });
  const logs = [];

  const bootEarly = await readCheckoutBootstrap(request, ctx, ua, apex);
  logs.push({
    step: "checkout_boot",
    status: bootEarly.status,
    body: `sf=${Boolean(bootEarly.sfToken)} hash=${bootEarly.storeHash}`,
  });

  if (captchaToken && !spamAlreadyCleared) {
    const spam = await applySpamProtectionHttp(request, ctx, {
      apex,
      ua,
      jar,
      checkoutId,
      captchaToken,
      sfToken: bootEarly.sfToken,
      // Adapter already POSTed REST once — only GraphQL retry here.
      skipRest: Boolean(spamRestAttempted),
    });
    logs.push(...spam.logs);
    // Soft-continue: still probe completeCheckout/order for decline wire.
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

  const boot = bootEarly;
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

  // Fallback: Optimized Checkout internal order create.
  // checkout-sdk reads payment token from response header `token`.
  if (!payToken) {
    const orderBodies = [
      { cartId: checkoutId },
      { cartId: checkoutId, customerMessage: "", useStoreCredit: false },
      {},
    ];
    for (const orderBody of orderBodies) {
      const orderRes = await request(
        `${apex}/internalapi/v1/checkout/order`,
        {
          method: "POST",
          headers: {
            ...headers,
            accept: "application/json, text/plain, */*",
            "x-requested-with": "XMLHttpRequest",
          },
          body: JSON.stringify(orderBody),
        },
        ctx,
      );
      const orderText = await orderRes.text().catch(() => "");
      const headerToken =
        orderRes.headers?.get?.("token") ||
        orderRes.headers?.token ||
        null;
      logs.push({
        step: "order_create",
        status: orderRes.status,
        body: `${headerToken ? "hdrToken " : ""}${orderText}`.slice(0, 240),
      });
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
          headerToken ||
          orderJson?.data?.order?.token ||
          orderJson?.data?.token ||
          orderJson?.token ||
          orderJson?.payment?.token ||
          null;
        orderVia = "internalapi";
        if (payToken) break;
      }
      // Don't spray alternate bodies on hard rate-limit HTML.
      if (orderRes.status === 429) break;
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

  // Prefer the live method id first (adyenv3.scheme). Extra ids only on
  // clear method-shape errors — never spray after a bank decline.
  const paymentMethodIds = [
    `${adyen.gateway}.${adyen.id}`,
    `${adyen.gateway}.card`,
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

  const looksDeclined = (text) =>
    /declin|refused|insufficient|invalid card|not enough|do not honour|payment_failed|"status"\s*:\s*"error"/i.test(
      String(text || ""),
    ) && !/unauthorized/i.test(String(text || ""));
  const looksMethodError = (text) =>
    /payment_method|not supported|invalid.*method|instrument.*not.*supported/i.test(
      String(text || ""),
    );

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
    const payUrl = `https://payments.bigcommerce.com/stores/${boot.storeHash}/payments`;
    const payBodyStr = JSON.stringify(payBody);
    pspPostForensics("start", {
      store: "toymate",
      via: "bigpay",
      url: payUrl,
      body: payBodyStr,
      paymentMethodId,
      reqShape: {
        method: "POST",
        headerNames: Object.keys(payHeaders || {}).map((k) => k.toLowerCase()).sort(),
        contentType: payHeaders?.["content-type"] || payHeaders?.["Content-Type"] || null,
        accept: payHeaders?.accept || payHeaders?.Accept || null,
        origin: payHeaders?.origin || payHeaders?.Origin || null,
        referer: payHeaders?.referer || payHeaders?.Referer || null,
        secFetchMode: payHeaders?.["sec-fetch-mode"] || null,
        secFetchSite: payHeaders?.["sec-fetch-site"] || null,
        secFetchDest: payHeaders?.["sec-fetch-dest"] || null,
        hasAuth: Boolean(payHeaders?.Authorization || payHeaders?.authorization),
        bodyKeys: ["payment.instrument.type", "payment.payment_method_id"],
        instrumentType: "card",
      },
    });
    const tPay = Date.now();
    payRes = await request(
      payUrl,
      {
        method: "POST",
        headers: payHeaders,
        body: payBodyStr,
      },
      ctx,
    );
    payText = await payRes.text().catch(() => "");
    usedMethod = paymentMethodId;
    pspPostForensics("end", {
      store: "toymate",
      via: "bigpay",
      url: payUrl,
      status: payRes.status,
      ms: Date.now() - tPay,
      ok: payRes.status >= 200 && payRes.status < 300,
      bankSignal: looksDeclined(payText) || payRes.status === 422 || (payRes.status >= 200 && payRes.status < 300),
      paymentMethodId,
    });
    logs.push({
      step: "bigpay",
      status: payRes.status,
      body: `${paymentMethodId} ${payText}`.slice(0, 300),
    });
    if (payRes.status >= 200 && payRes.status < 300) break;
    // Terminal bank/PSP outcome — do NOT try another method id or CSE.
    if (looksDeclined(payText) || payRes.status === 422) break;
    if (!looksMethodError(payText)) break;
  }

  // CSE only when raw instrument shape was rejected — never after a decline.
  // (Previously any non-2xx including 422 insufficient-funds fired a 2nd auth.)
  const shouldTryCse =
    payRes &&
    !(payRes.status >= 200 && payRes.status < 300) &&
    !looksDeclined(payText) &&
    payRes.status !== 422 &&
    looksMethodError(payText);

  if (shouldTryCse) {
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
        const cseUrl = "https://payments.bigcommerce.com/api/public/v1/orders/payments";
        const cseBodyStr = JSON.stringify({
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
        });
        pspPostForensics("start", {
          store: "toymate",
          via: "bigpay_cse",
          url: cseUrl,
          body: cseBodyStr,
        });
        const tCse = Date.now();
        const encRes = await request(
          cseUrl,
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
            body: cseBodyStr,
          },
          ctx,
        );
        const encText = await encRes.text().catch(() => "");
        pspPostForensics("end", {
          store: "toymate",
          via: "bigpay_cse",
          url: cseUrl,
          status: encRes.status,
          ms: Date.now() - tCse,
          ok: encRes.status >= 200 && encRes.status < 300,
          bankSignal:
            looksDeclined(encText) ||
            (encRes.status >= 200 && encRes.status < 300),
        });
        logs.push({ step: "bigpay_cse", status: encRes.status, body: encText.slice(0, 300) });
        if (encRes.status >= 200 && encRes.status < 300) {
          payRes = encRes;
          payText = encText;
        } else if (looksDeclined(encText)) {
          payRes = encRes;
          payText = encText;
        }
      } catch (e) {
        logs.push({ step: "bigpay_cse", status: null, body: e?.message || String(e) });
      }
    }
  } else if (payRes && !(payRes.status >= 200 && payRes.status < 300)) {
    logs.push({
      step: "bigpay_cse",
      status: null,
      body: looksDeclined(payText) || payRes.status === 422
        ? "skipped_cse_after_decline"
        : "skipped_cse_non_method_error",
    });
  }

  const declined = looksDeclined(payText);
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

