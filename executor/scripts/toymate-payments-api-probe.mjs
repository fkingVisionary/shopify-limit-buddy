#!/usr/bin/env node
// Discover Toymate / BigPay payment-methods endpoint after full scaffold.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDispatcher, createJar, request, UA } from "../http.js";
import {
  looksLikeCfChallenge,
  solveCloudflareChallenge,
} from "../adapters/toymate-cf-solve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadKey() {
  if (process.env.CAPSOLVER_API_KEY) return;
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "..", ".env.local"), "utf8");
    const m = raw.match(/^CAPSOLVER_API_KEY=(.+)$/m);
    if (m) process.env.CAPSOLVER_API_KEY = m[1].trim();
  } catch {
    /* ignore */
  }
}
function mintProxy() {
  if (process.env.PROXY_LINE) {
    const raw = process.env.PROXY_LINE.trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    const [host, port, user, ...pass] = raw.split(":");
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  const local = path.join(__dirname, "..", "noontide.proxies.local");
  const lines = fs
    .readFileSync(local, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const raw = lines[0].replace(/session-[^-]+/, `session-${stamp}`);
  const [host, port, user, ...pass] = raw.split(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
}
function xsrf(jar, ua, extra = {}) {
  const d = jar.dump?.() || {};
  const h = {
    "user-agent": ua,
    accept: "application/json",
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    origin: "https://toymate.com.au",
    referer: "https://toymate.com.au/checkout",
    ...extra,
  };
  if (d["XSRF-TOKEN"]) {
    try {
      h["x-xsrf-token"] = decodeURIComponent(d["XSRF-TOKEN"]);
    } catch {
      h["x-xsrf-token"] = d["XSRF-TOKEN"];
    }
  }
  return h;
}

loadKey();
const proxyUrl = mintProxy();
const dispatcher = makeDispatcher(proxyUrl, { forceUndici: true });
const jar = createJar();
const ctx = { dispatcher, jar };
const apex = "https://toymate.com.au";
const email = process.env.ACCOUNT_EMAIL || "proof3+mrv40gx11rzw@bullposted.com";
const pass = process.env.ACCOUNT_PASS || "Password1";
const ship = {
  firstName: "Test",
  lastName: "Buyer",
  email,
  phone: "0412345678",
  address1: "10 George Street",
  city: "Sydney",
  stateOrProvinceCode: "NSW",
  postalCode: "2000",
  countryCode: "AU",
};

try {
  let res = await request(
    "https://www.toymate.com.au/login.php",
    { headers: { "user-agent": UA, accept: "text/html" } },
    ctx,
  );
  let html = await res.text();
  console.log(JSON.stringify({ phase: "warm", status: res.status, cf: looksLikeCfChallenge(html, res.status) }));
  if (looksLikeCfChallenge(html, res.status)) {
    const solved = await solveCloudflareChallenge({
      pageUrl: "https://www.toymate.com.au/login.php",
      html,
      proxyRaw: proxyUrl,
      userAgent: UA,
    });
    console.log(JSON.stringify({ phase: "cf", ok: solved.ok, err: solved.error || null }));
    if (!solved.ok) process.exit(1);
    for (const [k, v] of Object.entries(solved.cookies || {})) jar.set(k, String(v));
    if (solved.userAgent) ctx.extraHeaders = { "user-agent": solved.userAgent };
  }
  const ua = ctx.extraHeaders?.["user-agent"] || UA;

  res = await request(`${apex}/login.php`, { headers: { "user-agent": ua, accept: "text/html" } }, ctx);
  html = await res.text();
  const at = html.match(/name=["']authenticity_token["']\s+value=["']([^"']+)/i)?.[1];
  res = await request(`${apex}/login.php?action=check_login`, {
    method: "POST",
    headers: {
      "user-agent": ua,
      "content-type": "application/x-www-form-urlencoded",
      origin: apex,
      referer: `${apex}/login.php`,
    },
    body: new URLSearchParams({
      login_email: email,
      login_pass: pass,
      ...(at ? { authenticity_token: at } : {}),
    }).toString(),
  }, ctx);
  await res.text();
  console.log(JSON.stringify({ phase: "login", status: res.status }));

  const productId = Number(process.env.PRODUCT_ID || 53116);
  res = await request(`${apex}/api/storefront/carts`, {
    method: "POST",
    headers: xsrf(jar, ua, { referer: `${apex}/products.php?productId=${productId}` }),
    body: JSON.stringify({ lineItems: [{ quantity: 1, productId }] }),
  }, ctx);
  const cart = await res.json();
  const checkoutId = cart.id;
  res = await request(
    `${apex}/api/storefront/checkouts/${checkoutId}?include=cart.lineItems.physicalItems.options`,
    { headers: xsrf(jar, ua) },
    ctx,
  );
  let co = await res.json();
  const itemId = co.cart.lineItems.physicalItems[0].id;
  res = await request(
    `${apex}/api/storefront/checkouts/${checkoutId}/consignments?include=consignments.availableShippingOptions`,
    {
      method: "POST",
      headers: xsrf(jar, ua),
      body: JSON.stringify([{ shippingAddress: ship, lineItems: [{ itemId, quantity: 1 }] }]),
    },
    ctx,
  );
  co = await res.json();
  await request(
    `${apex}/api/storefront/checkouts/${checkoutId}/consignments/${co.consignments[0].id}?include=consignments.availableShippingOptions`,
    {
      method: "PUT",
      headers: xsrf(jar, ua),
      body: JSON.stringify({ shippingOptionId: co.consignments[0].availableShippingOptions[0].id }),
    },
    ctx,
  );
  await request(`${apex}/api/storefront/checkouts/${checkoutId}/billing-address`, {
    method: "POST",
    headers: xsrf(jar, ua),
    body: JSON.stringify(ship),
  }, ctx);
  console.log(JSON.stringify({ phase: "scaffold", checkoutId, grandTotal: co.grandTotal }));

  res = await request(`${apex}/checkout`, {
    headers: { "user-agent": ua, accept: "text/html", referer: `${apex}/` },
  }, ctx);
  html = await res.text();
  const sfToken =
    html.match(/storefront_api\\":\{\\"token\\":\\"([^\\]+)\\"/)?.[1] ||
    html.match(/"storefront_api"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/)?.[1];
  const storeHash = html.match(/"storeHash"\s*:\s*"([^"]+)"/)?.[1] || "cf7jv97qb3";
  const recaptchaKey = html.match(/googleRecaptchaSitekey"\s*:\s*"([^"]+)"/)?.[1];
  console.log(
    JSON.stringify({
      phase: "tokens",
      sf: Boolean(sfToken),
      storeHash,
      recaptchaKey,
      spam: /isSpamProtectionEnabled":true/.test(html),
    }),
  );

  const attempts = [
    {
      url: `${apex}/api/storefront/payments?cartId=${checkoutId}`,
      headers: xsrf(jar, ua, { accept: "application/vnd.bc.v1+json" }),
    },
    {
      url: `${apex}/api/storefront/payments?cartId=${checkoutId}`,
      headers: {
        ...xsrf(jar, ua),
        Authorization: `Bearer ${sfToken}`,
      },
    },
    {
      url: `https://www.toymate.com.au/api/storefront/payments?cartId=${checkoutId}`,
      headers: xsrf(jar, ua),
    },
    {
      url: `https://payments.bigcommerce.com/api/public/v1/payments/payment-methods?cartId=${checkoutId}`,
      headers: {
        "user-agent": ua,
        accept: "application/json",
        Authorization: `PAT ${sfToken}`,
        origin: apex,
        referer: `${apex}/checkout`,
      },
    },
    {
      url: `https://payments.bigcommerce.com/api/public/v1/payments/payment-methods?cartId=${checkoutId}`,
      headers: {
        "user-agent": ua,
        accept: "application/json",
        Authorization: `Bearer ${sfToken}`,
        origin: apex,
        referer: `${apex}/checkout`,
      },
    },
    {
      url: `https://payments.bigcommerce.com/stores/${storeHash}/payments`,
      headers: {
        "user-agent": ua,
        accept: "application/json",
        Authorization: `PAT ${sfToken}`,
        origin: apex,
        referer: `${apex}/checkout`,
      },
    },
    {
      url: `https://payments.bigcommerce.com/api/public/v1/payments/payment-methods?cartId=${checkoutId}`,
      headers: {
        "user-agent": ua,
        accept: "application/json",
        "X-Auth-Token": sfToken,
        origin: apex,
        referer: `${apex}/checkout`,
      },
    },
  ];

  for (const a of attempts) {
    try {
      res = await request(a.url, { method: "GET", headers: a.headers }, ctx);
      const body = await res.text();
      console.log(
        JSON.stringify({
          phase: "pay_get",
          url: a.url
            .replace("https://payments.bigcommerce.com", "PAY")
            .replace("https://toymate.com.au", "")
            .replace("https://www.toymate.com.au", "www"),
          status: res.status,
          auth: a.headers.Authorization
            ? String(a.headers.Authorization).slice(0, 20)
            : a.headers["X-Auth-Token"]
              ? "X-Auth-Token"
              : a.headers.accept || "cookie",
          body: body.slice(0, 900),
        }),
      );
      if (res.status === 200 && body.includes("methodId")) {
        fs.writeFileSync("/tmp/toymate-payment-methods.json", body);
        break;
      }
    } catch (e) {
      console.log(JSON.stringify({ phase: "pay_get_err", url: a.url, err: e.message }));
    }
  }
} finally {
  try {
    await dispatcher.close?.();
  } catch {
    /* ignore */
  }
}
