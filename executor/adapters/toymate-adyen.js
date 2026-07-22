// Toymate Adyen v3 (scheme) helpers — CapSolver-free except caller-supplied captcha.
// Isolated from Kmart / Paydock.

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

/** Fetch Adyen CSE public key for a live/test clientKey. */
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
 * Playwright: open /checkout with jar cookies + same proxy, fill Adyen hosted fields, place order.
 * Returns { ok, status, note, declined, orderNumber, body }.
 */
export async function placeOrderViaCheckoutUi({
  proxyUrl,
  cookies,
  userAgent,
  card,
  checkoutUrl = "https://toymate.com.au/checkout",
  timeoutMs = 120_000,
} = {}) {
  const { chromium } = await import("playwright");
  let proxy = null;
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      proxy = {
        server: `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      };
    } catch {
      proxy = null;
    }
  }

  const browser = await chromium.launch({
    headless: true,
    proxy: proxy || undefined,
  });
  try {
    const context = await browser.newContext({
      userAgent:
        userAgent ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-AU",
      viewport: { width: 1280, height: 900 },
    });
    const jarCookies = [];
    for (const [name, value] of Object.entries(cookies || {})) {
      jarCookies.push({
        name,
        value: String(value),
        domain: ".toymate.com.au",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      });
    }
    if (jarCookies.length) await context.addCookies(jarCookies);

    const page = await context.newPage();
    const paymentLogs = [];
    page.on("response", async (res) => {
      const url = res.url();
      if (/payments|order|adyen|checkout/i.test(url) && res.request().method() !== "GET") {
        let body = "";
        try {
          body = (await res.text()).slice(0, 500);
        } catch {
          /* ignore */
        }
        paymentLogs.push({ url: url.slice(0, 160), status: res.status(), body });
      }
    });

    await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2500);

    // Prefer credit card / Adyen radio if present.
    for (const sel of [
      'label:has-text("Credit Card")',
      'text=Credit Card',
      '[data-test="payment-method-scheme"]',
      "#radio-adyenv3",
      'input[value="scheme"]',
    ]) {
      const el = page.locator(sel).first();
      if (await el.count()) {
        try {
          await el.click({ timeout: 2000 });
          break;
        } catch {
          /* try next */
        }
      }
    }
    await page.waitForTimeout(1500);

    const number = String(card.number || "").replace(/\s+/g, "");
    const expMonth = String(card.expMonth || "").padStart(2, "0").slice(-2);
    let expYear = String(card.expYear || "").trim();
    if (expYear.length === 4) expYear = expYear.slice(-2);
    const cvv = String(card.cvv || "").trim();
    const holder = String(card.holder || "Cardholder").trim();

    // Holder often outside iframe.
    for (const sel of [
      'input[name="cc-name"]',
      'input[autocomplete="cc-name"]',
      'input[id*="cardholder" i]',
      'input[name*="holder" i]',
    ]) {
      const el = page.locator(sel).first();
      if (await el.count()) {
        try {
          await el.fill(holder);
          break;
        } catch {
          /* ignore */
        }
      }
    }

    async function fillFrame(titleRe, value) {
      const frame = page.frameLocator(`iframe[title*="${titleRe}" i]`).first();
      const input = frame.locator("input").first();
      await input.waitFor({ timeout: 20_000 });
      await input.fill(value);
    }

    // Adyen secured-field iframe titles vary slightly.
    const tries = [
      async () => {
        await fillFrame("card number", number);
        await fillFrame("expiry", `${expMonth}${expYear}`);
        await fillFrame("security", cvv);
      },
      async () => {
        await fillFrame("number", number);
        await fillFrame("expir", `${expMonth} / ${expYear}`);
        await fillFrame("cvc", cvv);
      },
      async () => {
        await fillFrame("encryptedCardNumber", number);
        await fillFrame("encryptedExpiryDate", `${expMonth}${expYear}`);
        await fillFrame("encryptedSecurityCode", cvv);
      },
    ];
    let filled = false;
    let fillErr = null;
    for (const fn of tries) {
      try {
        await fn();
        filled = true;
        break;
      } catch (e) {
        fillErr = e;
      }
    }
    if (!filled) {
      return {
        ok: false,
        status: null,
        note: `Adyen fields not found: ${fillErr?.message || fillErr}`,
        declined: false,
        paymentLogs,
      };
    }

    // Place order
    for (const sel of [
      '#checkout-payment-continue',
      'button:has-text("Place Order")',
      'button:has-text("Pay")',
      'button[type="submit"]',
    ]) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        try {
          await btn.click({ timeout: 5000 });
          break;
        } catch {
          /* next */
        }
      }
    }

    const deadline = Date.now() + timeoutMs;
    let declined = false;
    let orderNumber = null;
    let note = "waiting for payment result";
    while (Date.now() < deadline) {
      const url = page.url();
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (/order-confirmation|order confirmation|thank you for your order/i.test(url + bodyText)) {
        orderNumber =
          bodyText.match(/order\s*(?:number|#)?\s*[:#]?\s*(\d{5,})/i)?.[1] || null;
        note = orderNumber ? `order ${orderNumber}` : "confirmation page";
        return {
          ok: true,
          status: 200,
          note,
          declined: false,
          orderNumber,
          paymentLogs,
          finalUrl: url,
        };
      }
      if (
        /declin|insufficient|not enough|do not honour|do not honor|payment failed|unable to process|card was declined|authentication failed/i.test(
          bodyText,
        )
      ) {
        declined = true;
        note = (bodyText.match(/.{0,40}(declin|insufficient|not enough|honou?r|payment failed|unable to process).{0,60}/i) || [
          null,
          bodyText.slice(0, 120),
        ])[0] || "declined";
        return {
          ok: true, // reached gateway — decline is a successful smoke for this goal
          status: 402,
          note: String(note).replace(/\s+/g, " ").slice(0, 180),
          declined: true,
          orderNumber: null,
          paymentLogs,
          finalUrl: url,
        };
      }
      // BigPay error responses in logs
      if (paymentLogs.some((l) => /declin|insufficient|402|payment_failed/i.test(l.body))) {
        const hit = paymentLogs.find((l) => /declin|insufficient|402|payment_failed/i.test(l.body));
        return {
          ok: true,
          status: hit.status,
          note: hit.body.slice(0, 180),
          declined: true,
          paymentLogs,
          finalUrl: url,
        };
      }
      await page.waitForTimeout(1000);
    }
    return {
      ok: false,
      status: null,
      note: `timeout after place — ${note}`,
      declined,
      paymentLogs,
      finalUrl: page.url(),
    };
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}
