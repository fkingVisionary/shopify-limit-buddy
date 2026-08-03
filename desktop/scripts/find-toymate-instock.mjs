#!/usr/bin/env node
/**
 * CapSolver + sticky proxy: find an in-stock Toymate PDP for dual-lab e2e.
 * Env: CAPSOLVER_API_KEY, optional PROXY_GROUP_ID (default px_noontide_resi_dual)
 */
import fs from "node:fs";
import path from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "../../executor/node_modules/undici/index.js";

const GROUP_ID = process.env.PROXY_GROUP_ID || "px_noontide_resi_dual";
const API_KEY = String(process.env.CAPSOLVER_API_KEY || "").trim();
if (!API_KEY) {
  console.error("CAPSOLVER_API_KEY required");
  process.exit(2);
}

const db = JSON.parse(
  fs.readFileSync(
    path.join(process.env.APPDATA, "vanta-desktop/j1ms-desktop/db.json"),
    "utf8",
  ),
);
const g = (db.proxyGroups || []).find((x) => x && x.id === GROUP_ID);
const raw = (g?.entries || [])[0];
if (!raw) {
  console.error("no proxy entries");
  process.exit(2);
}
const parts = String(raw).split(":");
const host = parts[0];
const port = parts[1];
const pass = parts[parts.length - 1];
const user = parts.slice(2, -1).join(":");
const proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
const proxyColon = `${host}:${port}:${user}:${pass}`;
const agent = new ProxyAgent(proxyUrl);
const ua =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function get(url, headers = {}) {
  const res = await undiciFetch(url, {
    dispatcher: agent,
    headers: {
      "user-agent": ua,
      accept: "text/html,application/xhtml+xml",
      ...headers,
    },
    redirect: "follow",
  });
  return { status: res.status, html: await res.text() };
}

async function capSolve(html) {
  const created = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientKey: API_KEY,
      task: {
        type: "AntiCloudflareTask",
        websiteURL: "https://toymate.com.au/",
        proxy: proxyColon,
        userAgent: ua,
        html: html.slice(0, 120000),
      },
    }),
  }).then((r) => r.json());
  if (!created.taskId) throw new Error(created.errorDescription || "createTask failed");
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const j = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey: API_KEY, taskId: created.taskId }),
    }).then((r) => r.json());
    if (j.status === "ready") return j.solution;
    if (j.errorId) throw new Error(j.errorDescription || "capsolver error");
  }
  throw new Error("capsolver timeout");
}

function cookieHeader(cookies) {
  if (!cookies) return "";
  if (Array.isArray(cookies)) {
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

const warm = await get("https://toymate.com.au/");
const sol = await capSolve(warm.html);
const headers = {
  "user-agent": sol.userAgent || ua,
  cookie: cookieHeader(sol.cookies),
};

const searches = ["lego", "pokemon", "hot wheels", "barbie", "plush"];
const seedUrls = [
  "https://toymate.com.au/products.php?productId=53116",
  "https://toymate.com.au/lego-city-the-lego-van-60500/",
];
const hits = [];
const candidates = new Set(seedUrls);

for (const q of searches) {
  const s = await get(
    `https://toymate.com.au/search.php?search_query=${encodeURIComponent(q)}`,
    headers,
  );
  // Product cards: <article ... data-product-id="123"> ... href="/slug/"
  const cardRe =
    /data-product-id=["'](\d+)["'][\s\S]{0,400}?href=["'](\/[^"'#]+?)["']/gi;
  let m;
  while ((m = cardRe.exec(s.html)) && candidates.size < 40) {
    const rel = m[2];
    if (/search|login|cart|account|wishlist|category/i.test(rel)) continue;
    candidates.add(`https://toymate.com.au${rel}`);
  }
  // Fallback: products.php links
  const phpRe = /href=["'](\/products\.php\?productId=\d+)["']/gi;
  while ((m = phpRe.exec(s.html)) && candidates.size < 50) {
    candidates.add(`https://toymate.com.au${m[1]}`);
  }
}

for (const u of candidates) {
  const p = await get(u, headers);
  const pid = p.html.match(/data-product-id=["'](\d+)["']/i)?.[1] || null;
  const formAdd = /id=["']form-action-addToCart["']|id=["']add-to-cart["']/i.test(p.html);
  const btnDisabled = /add-to-cart[^>]+disabled|data-product-attribute.*out.of.stock/i.test(
    p.html,
  );
  const oos =
    btnDisabled ||
    /productView-price.*[Oo]ut of [Ss]tock|class=["'][^"']*out-of-stock|Notify Me When Available/i.test(
      p.html,
    );
  const add = formAdd || /name=["']action["']\s+value=["']add["']/i.test(p.html);
  const row = { url: u, status: p.status, pid, oos, add, formAdd };
  hits.push(row);
  if (add && !oos && pid) {
    // Confirm ATC remotely
    const mpBoundary = "----j1m" + Date.now();
    const body = [
      `--${mpBoundary}`,
      'Content-Disposition: form-data; name="action"',
      "",
      "add",
      `--${mpBoundary}`,
      'Content-Disposition: form-data; name="product_id"',
      "",
      String(pid),
      `--${mpBoundary}`,
      'Content-Disposition: form-data; name="qty[]"',
      "",
      "1",
      `--${mpBoundary}--`,
      "",
    ].join("\r\n");
    const atc = await undiciFetch("https://toymate.com.au/remote/v1/cart/add", {
      dispatcher: agent,
      method: "POST",
      headers: {
        ...headers,
        "content-type": `multipart/form-data; boundary=${mpBoundary}`,
        "x-requested-with": "stencil-utils",
        origin: "https://toymate.com.au",
        referer: u,
      },
      body,
    });
    const atcText = await atc.text();
    let atcJson = null;
    try {
      atcJson = JSON.parse(atcText);
    } catch {
      /* ignore */
    }
    const cartId = atcJson?.data?.cart_id || null;
    const err = atcJson?.error || null;
    const ok = Boolean(cartId) && !err;
    console.log(
      JSON.stringify(
        { winner: ok, ...row, atcStatus: atc.status, cartId, atcError: err, proxyHost: host },
        null,
        2,
      ),
    );
    if (ok) {
      await agent.close();
      process.exit(0);
    }
  }
}

console.log(JSON.stringify({ winner: false, hits: hits.slice(0, 30), proxyHost: host }, null, 2));
await agent.close();
process.exit(1);
