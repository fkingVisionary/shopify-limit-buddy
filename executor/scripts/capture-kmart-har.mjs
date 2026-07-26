#!/usr/bin/env node
/**
 * Capture a Chromium HAR against Kmart via optional ISP proxy.
 * Usage:
 *   node executor/scripts/capture-kmart-har.mjs
 *   PROXY_LINE='host:port:user:pass' OUT=/tmp/kmart-browser.har node executor/scripts/capture-kmart-har.mjs
 *
 * Does not call Hyper — records real browser TLS + navigation for diffs.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.OUT || "/tmp/kmart-browser.har";
const PDP =
  process.env.PDP_URL ||
  "https://www.kmart.com.au/product/31-piece-make-it-real:-juicy-couture-diy-floaty-pens-43722280/";

function parseProxyLine(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.startsWith("#")) return null;
  const parts = raw.split(":");
  if (parts.length < 2) return null;
  const [host, port, user, pass] = parts;
  return {
    server: `http://${host}:${port}`,
    ...(user ? { username: user, password: pass || "" } : {}),
  };
}

function loadProxy() {
  if (process.env.PROXY_LINE) return parseProxyLine(process.env.PROXY_LINE);
  if (process.env.PROXY_URL) {
    const u = new URL(process.env.PROXY_URL);
    return {
      server: `${u.protocol}//${u.hostname}:${u.port}`,
      ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}),
    };
  }
  const list = path.join(ROOT, "resi.proxies");
  if (!fs.existsSync(list)) return null;
  const line = fs.readFileSync(list, "utf8").split("\n").find((l) => l && !l.startsWith("#"));
  return parseProxyLine(line);
}

const proxy = loadProxy();
const launchOpts = {
  headless: true,
  channel: process.env.PW_CHANNEL || "chromium",
};
const contextOpts = {
  recordHar: { path: OUT, mode: "full" },
  userAgent:
    process.env.UA ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "en-AU",
  ...(proxy ? { proxy } : {}),
};

console.log(
  JSON.stringify(
    {
      out: OUT,
      pdp: PDP,
      proxy: proxy ? { server: proxy.server, user: proxy.username ? `${String(proxy.username).slice(0, 6)}…` : null } : null,
    },
    null,
    2,
  ),
);

const browser = await chromium.launch(launchOpts);
const context = await browser.newContext(contextOpts);
const page = await context.newPage();
const steps = [];

async function go(label, url) {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const status = res?.status() ?? null;
    const title = await page.title().catch(() => "");
    const html = await page.content().catch(() => "");
    steps.push({
      label,
      ok: status != null && status < 400 && !/Access Denied/i.test(html),
      status,
      title,
      bytes: html.length,
      ghost: /Access Denied/i.test(html),
    });
  } catch (e) {
    steps.push({ label, ok: false, error: String(e?.message || e).slice(0, 240) });
  }
}

await go("home", "https://www.kmart.com.au/");
await go("pdp", PDP);
// Light GraphQL probe from page context if home/pdp cleared cookies.
try {
  const gql = await page.evaluate(async () => {
    const res = await fetch("https://api.kmart.com.au/gateway/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: "https://www.kmart.com.au",
        referer: location.href,
      },
      body: JSON.stringify({
        operationName: "getMyActiveCart",
        variables: {},
        query: "query getMyActiveCart { me { activeCart { id __typename } __typename } }",
      }),
      credentials: "include",
    });
    const text = await res.text();
    return { status: res.status, bytes: text.length, head: text.slice(0, 180), ghost: /Access Denied/i.test(text) };
  });
  steps.push({ label: "graphql_from_page", ...gql, ok: gql.status < 400 && !gql.ghost });
} catch (e) {
  steps.push({ label: "graphql_from_page", ok: false, error: String(e?.message || e).slice(0, 240) });
}

await context.close();
await browser.close();
console.log(JSON.stringify({ steps, har: OUT }, null, 2));
