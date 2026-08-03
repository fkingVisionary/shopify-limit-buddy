#!/usr/bin/env node
// Quick stock probe for a few Bandai AU SKUs via sticky proxy (no card data).
const fs = require("fs");
const path = require("path");
const { ProxyAgent, fetch } = require(
  path.join(__dirname, "..", "..", "executor", "node_modules", "undici"),
);

function toUrl(line) {
  const p = String(line || "").trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  const parts = p.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(rest.join(":"))}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
  return p;
}

async function probe(sku, proxyUrl) {
  const url = `https://p-bandai.com/au/item/${sku}`;
  const dispatcher = new ProxyAgent(proxyUrl);
  try {
    const res = await fetch(url, {
      dispatcher,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "accept-language": "en-AU,en;q=0.9",
      },
    });
    const body = await res.text();
    const soldOut =
      /sold\s*out|out\s*of\s*stock|currently unavailable|not available for purchase/i.test(body);
    const addCart = /add to cart|addToCart|data-stock=["']?in/i.test(body);
    const title =
      body.match(/<h1[^>]*>([^<]+)/i)?.[1]?.trim() ||
      body.match(/property="og:title" content="([^"]+)"/i)?.[1] ||
      "";
    return {
      sku,
      status: res.status,
      soldOut,
      addCartHint: addCart,
      likelyInStock: res.status === 200 && !soldOut && addCart,
      title: title.slice(0, 80),
    };
  } catch (e) {
    return { sku, error: e.message || String(e) };
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const dbPath =
    process.env.DESKTOP_DB ||
    path.join(process.env.APPDATA || "", "vanta-desktop", "j1ms-desktop", "db.json");
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const group = (db.proxyGroups || []).find((g) => g.entries?.length) || {};
  const line = group.entries[Math.floor(Math.random() * group.entries.length)];
  const proxyUrl = toUrl(line);
  if (!proxyUrl) {
    console.error(JSON.stringify({ ok: false, error: "no proxy" }));
    process.exit(1);
  }

  let skus = (process.argv.slice(2).length
    ? process.argv.slice(2)
    : ["N2903432004", "N2890904001", "N2856354001", "N2826596003", "N2828968001", "N2847890001"]
  ).map((s) => String(s).trim());

  const results = [];
  for (const sku of skus) {
    const r = await probe(sku, proxyUrl);
    results.push(r);
    console.error(`[probe] ${sku} ${r.likelyInStock ? "IN" : r.soldOut ? "OOS" : "?"} ${r.title || r.error || r.status}`);
  }
  const inStock = results.filter((r) => r.likelyInStock);
  console.log(
    JSON.stringify(
      {
        ok: true,
        proxyHost: proxyUrl.replace(/:[^:@/]+@/, ":***@").split("@").pop(),
        inStock,
        results,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
