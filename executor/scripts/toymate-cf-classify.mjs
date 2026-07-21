#!/usr/bin/env node
// Light CF classification via ISP proxies — NO CapSolver spend.
// Samples a few exits, one GET each, prints status / challenge shape.
//
// Usage: node scripts/toymate-cf-classify.mjs [maxProxies=3]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const max = Math.max(1, Math.min(5, Number(process.argv[2] || 3)));
const listPath = path.join(__dirname, "..", "resi.proxies");
const lines = fs
  .readFileSync(listPath, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

function toProxyUrl(raw) {
  const parts = raw.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  return null;
}

function classify(status, html, headers) {
  const h = String(html || "").slice(0, 8000);
  const server = headers.get("server") || "";
  const cfRay = headers.get("cf-ray") || "";
  if (status === 200 && /login\.php|bigcommerce|data-product/i.test(h) && !/just a moment/i.test(h)) {
    return "clear";
  }
  if (/just a moment|cf-browser-verification|challenge-platform|__cf_chl/i.test(h)) {
    return "challenge_html";
  }
  if (status === 403 && /request blocked|attention required/i.test(h)) return "hard_block";
  if (status === 403) return "403_other";
  return `status_${status}`;
}

const targets = lines.slice(0, max);
console.log(JSON.stringify({ mode: "cf_classify", count: targets.length, note: "no CapSolver" }));

for (let i = 0; i < targets.length; i++) {
  const raw = targets[i];
  const proxyUrl = toProxyUrl(raw);
  const host = raw.split(":")[0];
  const t0 = Date.now();
  try {
    const agent = new ProxyAgent({ uri: proxyUrl, connect: { timeout: 20_000 } });
    const res = await undiciFetch("https://www.toymate.com.au/", {
      dispatcher: agent,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "text/html",
      },
    });
    const html = await res.text();
    const kind = classify(res.status, html, res.headers);
    console.log(
      JSON.stringify({
        i,
        host,
        status: res.status,
        kind,
        ms: Date.now() - t0,
        cfRay: res.headers.get("cf-ray") || null,
        bytes: html.length,
        snippet: html.replace(/\s+/g, " ").slice(0, 120),
      }),
    );
    await agent.close?.();
  } catch (e) {
    console.log(JSON.stringify({ i, host, ok: false, error: e?.message || String(e), ms: Date.now() - t0 }));
  }
}
