#!/usr/bin/env node
// Lightweight undici probe through ISP — cookies, CSP, challenge shapes, Cortex soft paths.
import { ProxyAgent, fetch } from "undici";
import fs from "node:fs";

const PROXY_RAW = String(process.env.PROXY || "").trim();
const OUT = process.env.PC_CAPTURE_DIR || `/tmp/pc-undici-${Date.now()}`;
fs.mkdirSync(OUT, { recursive: true });

function toProxyUrl(raw) {
  const parts = raw.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  return raw;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const agent = new ProxyAgent({ uri: toProxyUrl(PROXY_RAW), connect: { timeout: 45_000 } });
const jar = new Map();

function ingest(res) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const sc of raw) {
    const [pair] = sc.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function req(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    dispatcher: agent,
    headers: {
      "user-agent": UA,
      "accept-language": "en-AU,en;q=0.9",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...headers,
    },
    body,
  });
  ingest(res);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: Object.fromEntries(res.headers), body: buf, url };
}

function parseDd(html) {
  const m = String(html).match(/var\s+dd\s*=\s*(\{[\s\S]*?\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/'/g, '"').replace(/([,{]\s*)(\w+)\s*:/g, '$1"$2":'));
  } catch {
    return { raw: m[1].slice(0, 300) };
  }
}

const results = [];
async function probe(name, url, opts) {
  try {
    const r = await req(url, opts);
    const text = r.body.toString("utf8");
    const row = {
      name,
      url,
      status: r.status,
      bytes: r.body.length,
      csp: r.headers["content-security-policy"]?.slice(0, 500) || null,
      xcdn: r.headers["x-cdn"] || null,
      xdd: r.headers["x-datadome"] || null,
      setCookieNames: [...jar.keys()],
      incap: /_Incapsula_Resource|Incapsula incident/i.test(text),
      dd: parseDd(text),
      reese: (text.match(/<script[^>]+src=["'](\/[^"']+)["'][^>]*async/i) || [])[1] || null,
      globaleInCsp: (r.headers["content-security-policy"] || "").match(/[a-z0-9.-]*global-e\.com/gi) || [],
      snippet: text.slice(0, 180).replace(/\s+/g, " "),
    };
    results.push(row);
    console.log(JSON.stringify({ name, status: r.status, bytes: r.bytes ?? r.body.length, incap: row.incap, dd: row.dd?.t || null, reese: row.reese }));
    fs.writeFileSync(`${OUT}/${name}.bin`, r.body.slice(0, 200_000));
    return r;
  } catch (e) {
    results.push({ name, url, error: e.message });
    console.log(JSON.stringify({ name, error: e.message }));
  }
}

const home = "https://www.pokemoncenter.com/en-au/";
await probe("ipify", "https://api.ipify.org?format=json");
await probe("robots", "https://www.pokemoncenter.com/robots.txt");
await probe("home", home);
if (jar.size) {
  // fetch reese script if present
  const last = results.find((r) => r.name === "home");
  if (last?.reese) {
    await probe("reese_script", `https://www.pokemoncenter.com${last.reese}`, {
      headers: { referer: home, accept: "*/*", "sec-fetch-dest": "script" },
    });
  }
}
await probe("pdp", "https://www.pokemoncenter.com/en-au/product/10-10186-109/pokemon-tcg-elite-trainer-box");
await probe("cortex", "https://www.pokemoncenter.com/cortex");
await probe("carts", "https://www.pokemoncenter.com/carts");
await probe("items", "https://www.pokemoncenter.com/items");
await probe("intl", "https://www.pokemoncenter.com/intl-checkout");

fs.writeFileSync(
  `${OUT}/undici-summary.json`,
  JSON.stringify(
    {
      cookies: [...jar.entries()].map(([name, value]) => ({
        name,
        valueLen: value.length,
        prefix: value.slice(0, 20),
      })),
      results: results.map((r) => ({
        ...r,
        body: undefined,
      })),
    },
    null,
    2,
  ),
);
console.log("wrote", OUT);
await agent.close();
