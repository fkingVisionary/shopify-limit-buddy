#!/usr/bin/env node
// Single-page dwell capture: stay on /en-au/ for N seconds to let Reese/DD settle.
// Avoids proxy burnout from rapid navigations.
import { chromium } from "playwright";
import fs from "node:fs";

const PROXY = String(process.env.PROXY || "").trim();
const OUT = process.env.PC_CAPTURE_DIR || `/tmp/pc-dwell-${Date.now()}`;
const DWELL_MS = Number(process.env.DWELL_MS || 45000);
fs.mkdirSync(OUT, { recursive: true });

function parseProxy(raw) {
  const parts = raw.split(":");
  return {
    server: `http://${parts[0]}:${parts[1]}`,
    username: parts[2],
    password: parts.slice(3).join(":"),
  };
}

const proxy = parseProxy(PROXY);
const harPath = `${OUT}/dwell.har`;
const browser = await chromium.launch({
  headless: true,
  proxy,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  locale: "en-AU",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1360, height: 900 },
  recordHar: { path: harPath, mode: "full", content: "embed" },
});
const page = await context.newPage();
const reqs = [];
page.on("requestfinished", async (req) => {
  const u = req.url();
  if (/pokemoncenter|captcha|datadome|global-e|hcaptcha|reese|incap/i.test(u)) {
    const res = await req.response().catch(() => null);
    reqs.push({ method: req.method(), status: res?.status(), url: u.slice(0, 220) });
  }
});

await page.goto("https://api.ipify.org?format=json", { timeout: 30000 });
const ip = await page.textContent("body");
console.log("egress", ip);

await page.goto("https://www.pokemoncenter.com/en-au/", {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
console.log("landed", page.url(), "title", await page.title());
const t0 = Date.now();
while (Date.now() - t0 < DWELL_MS) {
  await page.waitForTimeout(3000);
  const html = await page.content();
  const challenged = /var dd=|_Incapsula_Resource|Please enable JS/i.test(html);
  console.log(
    "t+",
    Math.round((Date.now() - t0) / 1000),
    "bytes",
    html.length,
    challenged ? "challenged" : "CLEAR?",
    "url",
    page.url().slice(0, 80),
  );
  if (!challenged && html.length > 20000) {
    fs.writeFileSync(`${OUT}/home-clear.html`, html.slice(0, 800000));
    break;
  }
  fs.writeFileSync(`${OUT}/home-last.html`, html.slice(0, 200000));
}

const cookies = await context.cookies();
fs.writeFileSync(
  `${OUT}/cookies.json`,
  JSON.stringify(
    cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      valueLen: c.value.length,
      prefix: c.value.slice(0, 28),
    })),
    null,
    2,
  ),
);
fs.writeFileSync(`${OUT}/reqs.json`, JSON.stringify(reqs, null, 2));
await context.close();
await browser.close();
console.log("done", OUT, "reqs", reqs.length);
