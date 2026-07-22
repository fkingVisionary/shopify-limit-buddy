#!/usr/bin/env node
// Probe Toymate payment providers after CF + login + cart scaffold.
// CapSolver: 1 CF solve. No card charge.

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

function xsrfHeaders(jar, ua, extra = {}) {
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

async function text(res) {
  return res.text();
}
async function json(res) {
  try {
    return JSON.parse(await text(res));
  } catch {
    return null;
  }
}

try {
  let res = await request(
    "https://www.toymate.com.au/login.php",
    { headers: { "user-agent": UA, accept: "text/html" } },
    ctx,
  );
  let html = await text(res);
  console.log(
    JSON.stringify({
      phase: "warm",
      status: res.status,
      bytes: html.length,
      cf: looksLikeCfChallenge(html, res.status),
    }),
  );
  if (looksLikeCfChallenge(html, res.status)) {
    const solved = await solveCloudflareChallenge({
      pageUrl: "https://www.toymate.com.au/login.php",
      html,
      proxyRaw: proxyUrl,
      userAgent: UA,
    });
    console.log(
      JSON.stringify({
        phase: "cf_solve",
        ok: solved.ok,
        err: solved.error || null,
        cookies: Object.keys(solved.cookies || {}),
      }),
    );
    if (!solved.ok) process.exit(1);
    for (const [k, v] of Object.entries(solved.cookies || {})) jar.set(k, String(v));
    if (solved.userAgent) ctx.extraHeaders = { "user-agent": solved.userAgent };
  }
  const ua = ctx.extraHeaders?.["user-agent"] || UA;

  res = await request(
    `${apex}/login.php`,
    { headers: { "user-agent": ua, accept: "text/html", referer: `${apex}/` } },
    ctx,
  );
  html = await text(res);
  const token = html.match(/name=["']authenticity_token["']\s+value=["']([^"']+)/i)?.[1];
  res = await request(
    `${apex}/login.php?action=check_login`,
    {
      method: "POST",
      headers: {
        "user-agent": ua,
        "content-type": "application/x-www-form-urlencoded",
        referer: `${apex}/login.php`,
        origin: apex,
      },
      body: new URLSearchParams({
        login_email: process.env.ACCOUNT_EMAIL || "proof3+mrv40gx11rzw@bullposted.com",
        login_pass: process.env.ACCOUNT_PASS || "Password1",
        ...(token ? { authenticity_token: token } : {}),
      }).toString(),
    },
    ctx,
  );
  console.log(
    JSON.stringify({ phase: "login", status: res.status, loc: res.headers?.get?.("location") }),
  );
  await text(res);

  const productId = Number(process.env.PRODUCT_ID || 53116);
  res = await request(
    `${apex}/api/storefront/carts`,
    {
      method: "POST",
      headers: xsrfHeaders(jar, ua, {
        referer: `${apex}/products.php?productId=${productId}`,
      }),
      body: JSON.stringify({ lineItems: [{ quantity: 1, productId }] }),
    },
    ctx,
  );
  let cart = await json(res);
  console.log(
    JSON.stringify({ phase: "cart", status: res.status, id: cart?.id, amount: cart?.cartAmount }),
  );
  const checkoutId = cart?.id;
  if (!checkoutId) process.exit(2);

  res = await request(
    `${apex}/api/storefront/checkouts/${checkoutId}?include=cart.lineItems.physicalItems.options,customer,payments,promotions.banners`,
    { headers: xsrfHeaders(jar, ua) },
    ctx,
  );
  let co = await json(res);
  const itemId = co?.cart?.lineItems?.physicalItems?.[0]?.id;
  console.log(
    JSON.stringify({
      phase: "checkout",
      status: res.status,
      grandTotal: co?.grandTotal,
      itemId,
      customerId: co?.cart?.customerId,
    }),
  );

  res = await request(
    `${apex}/api/storefront/checkouts/${checkoutId}/consignments?include=consignments.availableShippingOptions`,
    {
      method: "POST",
      headers: xsrfHeaders(jar, ua),
      body: JSON.stringify([
        {
          shippingAddress: {
            firstName: "Test",
            lastName: "Buyer",
            email: process.env.ACCOUNT_EMAIL || "proof3+mrv40gx11rzw@bullposted.com",
            phone: "0412345678",
            address1: "10 George Street",
            city: "Sydney",
            stateOrProvinceCode: "NSW",
            postalCode: "2000",
            countryCode: "AU",
          },
          lineItems: [{ itemId, quantity: 1 }],
        },
      ]),
    },
    ctx,
  );
  co = await json(res);
  const consignmentId = co?.consignments?.[0]?.id;
  const optionId = co?.consignments?.[0]?.availableShippingOptions?.[0]?.id;
  console.log(
    JSON.stringify({
      phase: "consign",
      status: res.status,
      consignmentId,
      optionId,
      opts: (co?.consignments?.[0]?.availableShippingOptions || [])
        .slice(0, 4)
        .map((o) => ({ id: o.id, d: o.description, c: o.cost })),
    }),
  );
  if (consignmentId && optionId) {
    res = await request(
      `${apex}/api/storefront/checkouts/${checkoutId}/consignments/${consignmentId}?include=consignments.availableShippingOptions`,
      {
        method: "PUT",
        headers: xsrfHeaders(jar, ua),
        body: JSON.stringify({ shippingOptionId: optionId }),
      },
      ctx,
    );
    co = await json(res);
    console.log(JSON.stringify({ phase: "ship", status: res.status, grandTotal: co?.grandTotal }));
  }

  res = await request(
    `${apex}/api/storefront/checkouts/${checkoutId}/billing-address`,
    {
      method: "POST",
      headers: xsrfHeaders(jar, ua),
      body: JSON.stringify({
        firstName: "Test",
        lastName: "Buyer",
        email: process.env.ACCOUNT_EMAIL || "proof3+mrv40gx11rzw@bullposted.com",
        phone: "0412345678",
        address1: "10 George Street",
        city: "Sydney",
        stateOrProvinceCode: "NSW",
        postalCode: "2000",
        countryCode: "AU",
      }),
    },
    ctx,
  );
  co = await json(res);
  console.log(JSON.stringify({ phase: "billing", status: res.status, grandTotal: co?.grandTotal }));

  for (const url of [
    `${apex}/api/storefront/payments?cartId=${checkoutId}`,
    `${apex}/api/storefront/payments`,
  ]) {
    res = await request(url, { method: "GET", headers: xsrfHeaders(jar, ua) }, ctx);
    const body = await text(res);
    console.log(
      JSON.stringify({
        phase: "payments_get",
        path: url.replace(apex, ""),
        status: res.status,
        body: body.slice(0, 2000),
      }),
    );
  }

  res = await request(
    `${apex}/checkout`,
    { headers: { "user-agent": ua, accept: "text/html", referer: `${apex}/` } },
    ctx,
  );
  html = await text(res);
  console.log(
    JSON.stringify({
      phase: "checkout_html",
      status: res.status,
      bytes: html.length,
      stripe: /stripe/i.test(html),
      braintree: /braintree/i.test(html),
      paypal: /paypal/i.test(html),
      afterpay: /afterpay/i.test(html),
      bigpay: /bigpay/i.test(html),
      adyen: /adyen/i.test(html),
      windcave: /windcave|paymentexpress/i.test(html),
      eway: /eway/i.test(html),
      fatzebra: /fatzebra/i.test(html),
      methodIds: [
        ...new Set(
          [...html.matchAll(/["']methodId["']\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]),
        ),
      ],
      scripts: [...html.matchAll(/src=["']([^"']+)["']/g)]
        .map((m) => m[1])
        .filter((s) => /pay|checkout|stripe|brain|bigpay|adyen|after|card/i.test(s))
        .slice(0, 50),
    }),
  );
} finally {
  try {
    await dispatcher.close?.();
  } catch {
    /* ignore */
  }
}
