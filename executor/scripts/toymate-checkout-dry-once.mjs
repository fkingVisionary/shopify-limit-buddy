#!/usr/bin/env node
// ONE Toymate checkout dry-run: CF → login → PDP → cart → address (no placeOrder).
// CapSolver: ~1–2 CF solves (discover + adapter warm). No card charge.
//
// Usage:
//   CAPSOLVER_API_KEY=... PROXY_LINE='host:port:user:pass' \
//   ACCOUNT_EMAIL=... ACCOUNT_PASS=Password1 \
//   node scripts/toymate-checkout-dry-once.mjs [pdpUrl]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDispatcher, createJar, request, UA } from "../http.js";
import { toymateAdapter } from "../adapters/toymate.js";
import {
  solveCloudflareChallenge,
  looksLikeCfChallenge,
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

function pickProxy() {
  if (process.env.PROXY_LINE) return process.env.PROXY_LINE.trim();
  const local = path.join(__dirname, "..", "noontide.proxies.local");
  if (fs.existsSync(local)) {
    const lines = fs
      .readFileSync(local, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    // Prefer a fresh session mint from template of line 1.
    const base = lines[0];
    if (base) {
      const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      return base.replace(/session-[^-]+/, `session-${stamp}`);
    }
  }
  return null;
}

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const parts = raw.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  return raw;
}

async function discoverPdp(proxyUrl) {
  const dispatcher = makeDispatcher(proxyUrl, { forceUndici: true });
  const jar = createJar();
  const ctx = { dispatcher, jar };
  try {
    let res = await request("https://www.toymate.com.au/", {
      headers: { "user-agent": UA, accept: "text/html" },
    }, ctx);
    let html = await res.text();
    if (looksLikeCfChallenge(html, res.status)) {
      const solved = await solveCloudflareChallenge({
        pageUrl: "https://www.toymate.com.au/",
        html,
        proxyRaw: proxyUrl,
        userAgent: UA,
      });
      if (!solved.ok) return { ok: false, error: solved.error || "CF discover failed" };
      for (const [k, v] of Object.entries(solved.cookies || {})) jar.set(k, String(v));
    }
    const q = process.env.SEARCH_QUERY || "pokemon";
    res = await request(
      `https://toymate.com.au/search.php?search_query=${encodeURIComponent(q)}`,
      {
        headers: {
          "user-agent": UA,
          accept: "text/html",
          referer: "https://toymate.com.au/",
        },
      },
      ctx,
    );
    html = await res.text();
    // Theme often omits classic .html hrefs; cards expose data-product-id.
    const pid =
      html.match(/data-product-id=["'](\d+)["']/i)?.[1] ||
      html.match(/data-entity-id=["'](\d+)["']/i)?.[1] ||
      null;
    const pdp = pid ? `https://toymate.com.au/products.php?productId=${pid}` : null;
    return { ok: Boolean(pdp), pdp, productId: pid, status: res.status, bytes: html.length };
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
  }
}

loadKey();
if (!process.env.CAPSOLVER_API_KEY) {
  console.error("CAPSOLVER_API_KEY missing");
  process.exit(1);
}

const proxyRaw = toProxyUrl(pickProxy());
const email = process.env.ACCOUNT_EMAIL || "proof3+mrv40gx11rzw@bullposted.com";
const password = process.env.ACCOUNT_PASS || "Password1";
// Default to a known in-stock SKU when discover is skipped (Pokemon PDPs often OOS).
let pdpUrl =
  process.argv[2] ||
  process.env.PDP_URL ||
  "https://toymate.com.au/products.php?productId=53116";

console.log(
  JSON.stringify({
    phase: "start",
    mode: "checkout_dry",
    proxyHost: proxyRaw ? new URL(proxyRaw).hostname : null,
    email,
    pdp: pdpUrl || "(discover)",
  }),
);

if (!pdpUrl) {
  const found = await discoverPdp(proxyRaw);
  console.log(JSON.stringify({ phase: "discover", ...found, pdp: found.pdp || null }));
  if (!found.ok) {
    console.error("Could not discover a PDP — pass a product URL as argv");
    process.exit(2);
  }
  pdpUrl = found.pdp;
}

const dispatcher = makeDispatcher(proxyRaw, { forceUndici: true });
const jar = createJar();
const ctx = { dispatcher, jar, steps: [] };

const task = {
  taskId: `chk-dry-${Date.now().toString(36)}`,
  storeUrl: pdpUrl,
  pdpUrl,
  toymateMode: "checkout",
  proxy: proxyRaw,
  placeOrder: false,
  dryRun: true,
  paymentMethod: "credit_card",
  account: { email, password },
  qty: 1,
  profile: {
    email,
    first_name: "Test",
    last_name: "Buyer",
    phone: "0412345678",
    address1: "10 George Street",
    city: "Sydney",
    province: "NSW",
    zip: "2000",
  },
};

const t0 = Date.now();
try {
  const out = await toymateAdapter.run(task, ctx);
  const steps = (out.steps || []).map((s) => ({
    step: s.step,
    ok: s.ok,
    status: s.status,
    note: String(s.note || "").slice(0, 180),
  }));
  const cartOk = steps.some((s) => s.step === "cart_create" && s.ok);
  const addrOk = steps.some((s) => s.step === "checkout_set_address" && s.ok);
  const loginOk = steps.some((s) => s.step === "account_login" && s.ok);
  console.log(
    JSON.stringify({
      phase: "done",
      ok: Boolean(out.ok),
      ms: Date.now() - t0,
      checkoutStage: out.checkoutStage || null,
      dryRun: out.dryRun !== false,
      loginOk,
      cartOk,
      addrOk,
      error: out.error || null,
      failedStep: out.failedStep || null,
      pdpUrl,
      steps,
    }),
  );
  // Success for this smoke = logged in + cart created (address nice-to-have).
  process.exit(loginOk && cartOk ? 0 : 3);
} catch (e) {
  console.log(JSON.stringify({ phase: "throw", error: e?.message || String(e), ms: Date.now() - t0 }));
  process.exit(4);
} finally {
  try {
    await dispatcher.close?.();
  } catch {
    /* ignore */
  }
}
