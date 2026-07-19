const { ProxyAgent, fetch } = require("undici");
const { parseKmartPdpHtml } = require("../lib/kmart-stock-probe.cjs");
const { loadIspEntries } = require("../src/proxies.cjs");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PDP =
  process.env.PDP_URL ||
  "https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/";

function collect(res, jar) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const p = String(line).split(";")[0];
    const i = p.indexOf("=");
    if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
}

async function probeOne(proxyUrl) {
  const dispatcher = new ProxyAgent(proxyUrl);
  const jar = new Map();
  const home = await fetch("https://www.kmart.com.au/", {
    dispatcher,
    headers: {
      "user-agent": UA,
      "accept-language": "en-AU,en;q=0.9",
      accept: "text/html",
    },
    redirect: "follow",
  });
  collect(home, jar);
  const homeHtml = await home.text();
  const pdp = await fetch(PDP, {
    dispatcher,
    headers: {
      "user-agent": UA,
      "accept-language": "en-AU,en;q=0.9",
      accept: "text/html,application/xhtml+xml",
      referer: "https://www.kmart.com.au/",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "upgrade-insecure-requests": "1",
      ...(jar.size
        ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") }
        : {}),
    },
    redirect: "follow",
  });
  const html = await pdp.text();
  const parsed = parseKmartPdpHtml(html, String(pdp.url || PDP));
  return {
    proxyHost: proxyUrl.split("@").pop(),
    homeStatus: home.status,
    homeBytes: homeHtml.length,
    cookies: [...jar.keys()],
    pdpStatus: pdp.status,
    pdpBytes: html.length,
    denied: /access denied/i.test(html),
    parsed,
  };
}

async function main() {
  const entries = loadIspEntries();
  const n = Math.min(8, entries.length);
  for (let i = 0; i < n; i++) {
    try {
      const r = await probeOne(entries[i]);
      console.log(
        JSON.stringify({
          i,
          host: r.proxyHost,
          home: r.homeStatus,
          pdp: r.pdpStatus,
          denied: r.denied,
          ok: r.parsed.ok,
          inStock: r.parsed.inStock,
          sku: r.parsed.sku,
          title: r.parsed.title && r.parsed.title.slice(0, 60),
          price: r.parsed.price,
          cookies: r.cookies.length,
        }),
      );
      if (r.parsed.ok) {
        console.log("SUCCESS");
        process.exit(0);
      }
    } catch (e) {
      console.log(JSON.stringify({ i, error: e.message }));
    }
  }
  process.exit(2);
}

main();
