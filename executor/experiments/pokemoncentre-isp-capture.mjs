#!/usr/bin/env node
// Pokémon Centre AU ISP capture — Playwright HAR + network summary.
// Usage:
//   PROXY='host:port:user:pass' node experiments/pokemoncentre-isp-capture.mjs
// Never commits proxy credentials. Writes under /tmp/pc-capture-* and
// optionally copies a sanitized summary into executor/har/.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.PC_CAPTURE_DIR || `/tmp/pc-capture-${Date.now()}`;
const PROXY_RAW = String(process.env.PROXY || process.env.PROXY_URL || "").trim();
const LOCALE = process.env.PC_LOCALE || "en-au";
const ORIGIN = "https://www.pokemoncenter.com";
const HOME = `${ORIGIN}/${LOCALE}/`;
const PRODUCT =
  process.env.PC_PDP ||
  `${ORIGIN}/${LOCALE}/product/10-10186-109/pokemon-tcg-scarlet-violet-prismatic-evolutions-elite-trainer-box`;

function parseProxy(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    return {
      server: `${u.protocol}//${u.hostname}:${u.port || "80"}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  }
  const parts = s.split(":");
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    return {
      server: `http://${parts[0]}:${parts[1]}`,
      username: parts[2],
      password: parts.slice(3).join(":"),
    };
  }
  return null;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function summarizeHar(harPath) {
  const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
  const entries = har?.log?.entries || [];
  const urls = [];
  const hosts = new Set();
  const interesting = [];
  const cookieNames = new Set();
  let globaleMid = null;
  let gemHost = null;
  let secureHost = null;
  let hcaptchaSitekey = null;
  let reesePath = null;
  let cortexHits = [];

  for (const e of entries) {
    const url = e.request?.url || "";
    const status = e.response?.status;
    const method = e.request?.method;
    urls.push({ method, status, url: url.slice(0, 260) });
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      /* ignore */
    }
    for (const c of e.response?.cookies || []) {
      if (c?.name) cookieNames.add(c.name);
    }
    // Also Set-Cookie headers
    for (const h of e.response?.headers || []) {
      if (String(h.name).toLowerCase() === "set-cookie") {
        const name = String(h.value || "").split("=")[0];
        if (name) cookieNames.add(name);
      }
      if (String(h.name).toLowerCase() === "content-security-policy") {
        const csp = String(h.value || "");
        const gem = csp.match(/https?:\/\/(gem-[a-z0-9-]+\.global-e\.com)/i);
        const sec = csp.match(/https?:\/\/(secure-[a-z0-9-]+\.global-e\.com)/i);
        if (gem) gemHost = gem[1];
        if (sec) secureHost = sec[1];
      }
    }

    if (/_Incapsula_Resource|vice-come-|reese84|incap_/i.test(url)) {
      interesting.push({ kind: "incapsula", method, status, url: url.slice(0, 220) });
      const m = url.match(/https?:\/\/[^/]+(\/[^?]+)/);
      if (m && !/_Incapsula_Resource/i.test(m[1])) reesePath = m[1];
    }
    if (/datadome|captcha-delivery|dd\.pokemoncenter/i.test(url)) {
      interesting.push({ kind: "datadome", method, status, url: url.slice(0, 220) });
    }
    if (/hcaptcha|h-captcha/i.test(url)) {
      interesting.push({ kind: "hcaptcha", method, status, url: url.slice(0, 220) });
      const sk = url.match(/sitekey=([^&]+)/i);
      if (sk) hcaptchaSitekey = decodeURIComponent(sk[1]);
    }
    if (/global-e\.com|globale|bglobale/i.test(url)) {
      interesting.push({ kind: "globale", method, status, url: url.slice(0, 220) });
      const mid = url.match(/\/(?:js|merchant|clientsdk)\/(\d{3,6})/i) || url.match(/[?&]mid=(\d+)/i);
      if (mid) globaleMid = mid[1];
      try {
        const host = new URL(url).hostname;
        if (/^gem-/i.test(host)) gemHost = host;
        if (/^secure-/i.test(host)) secureHost = host;
      } catch {
        /* ignore */
      }
    }
    if (/\/cortex|\/carts|\/extcarts|\/items|\/availabilities|\/minicarts|\/intl-checkout|\/checkout/i.test(url)) {
      cortexHits.push({ method, status, url: url.slice(0, 260) });
      interesting.push({ kind: "cortex", method, status, url: url.slice(0, 220) });
    }
  }

  // Scan response bodies (truncated in HAR) for sitekeys / mid
  for (const e of entries) {
    const text = e.response?.content?.text || "";
    if (!text || text.length > 2_000_000) continue;
    if (!hcaptchaSitekey) {
      const m = text.match(/data-sitekey=["']([^"']+)["']/i) || text.match(/sitekey["']?\s*[:=]\s*["']([^"']+)["']/i);
      if (m?.[1]?.length > 10) hcaptchaSitekey = m[1];
    }
    if (!globaleMid) {
      const m =
        text.match(/globaleMid["']?\s*[:=]\s*["']?(\d{3,6})/i) ||
        text.match(/merchantId["']?\s*[:=]\s*["']?(\d{3,6})/i) ||
        text.match(/web\.global-e\.com\/merchant\/clientsdk\/(\d{3,6})/i);
      if (m) globaleMid = m[1];
    }
    if (!reesePath) {
      const m = text.match(/<script[^>]+src=["'](\/[^"'?][^"']*)["'][^>]*async/i);
      if (m && !/_Incapsula/i.test(m[1])) reesePath = m[1];
    }
  }

  return {
    entryCount: entries.length,
    hosts: [...hosts].sort(),
    cookieNames: [...cookieNames].sort(),
    globaleMid,
    gemHost,
    secureHost,
    hcaptchaSitekey,
    reesePath,
    cortexHits: cortexHits.slice(0, 80),
    interesting: interesting.slice(0, 120),
    sampleUrls: urls.slice(0, 40),
  };
}

async function main() {
  ensureDir(OUT_DIR);
  const proxy = parseProxy(PROXY_RAW);
  if (!proxy) {
    console.error("Set PROXY=host:port:user:pass");
    process.exit(2);
  }
  console.log("[pc-capture] out=", OUT_DIR);
  console.log("[pc-capture] proxy server=", proxy.server, "user=", proxy.username ? "***" : "(none)");
  console.log("[pc-capture] home=", HOME);

  const harPath = path.join(OUT_DIR, "pokemoncentre-en-au.har");
  const browser = await chromium.launch({
    headless: true,
    proxy: {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    },
  });

  const context = await browser.newContext({
    locale: "en-AU",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1360, height: 900 },
    recordHar: { path: harPath, mode: "full", content: "embed" },
  });

  const page = await context.newPage();
  const netLog = [];
  page.on("response", async (res) => {
    const url = res.url();
    if (!/pokemoncenter|global-e|captcha-delivery|datadome|hcaptcha|cortex|incap/i.test(url)) return;
    netLog.push({
      status: res.status(),
      url: url.slice(0, 240),
      ct: res.headers()["content-type"] || "",
    });
  });

  const steps = [];
  const push = (name, extra = {}) => {
    const row = { step: name, at: new Date().toISOString(), ...extra };
    steps.push(row);
    console.log("[step]", name, extra.note || extra.url || "");
  };

  try {
    // Egress check
    await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 45_000 });
    const ipText = await page.textContent("body");
    push("egress_ip", { note: ipText?.trim() });

    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(8000);
    // Dismiss CMP if any
    for (const sel of ["#onetrust-accept-btn-handler", "button:has-text('Accept All')", "button:has-text('Accept')"]) {
      const el = page.locator(sel).first();
      if (await el.count().catch(() => 0)) {
        await el.click({ timeout: 3000 }).catch(() => {});
        push("cmp_dismiss", { note: sel });
        break;
      }
    }
    await page.waitForTimeout(10000);
    const homeHtml = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, "home.html"), homeHtml.slice(0, 500_000));
    push("home", {
      url: page.url(),
      title: await page.title(),
      bytes: homeHtml.length,
      note: /Incapsula|main-iframe|var dd=/i.test(homeHtml)
        ? "still challenged"
        : homeHtml.length > 20_000
          ? "likely clear"
          : "short body",
    });

    // Try sitemap / category soft
    for (const pathTry of [
      `/${LOCALE}/category/trading-card-game`,
      "/sitemap.xml",
      "/robots.txt",
    ]) {
      try {
        const res = await page.goto(`${ORIGIN}${pathTry}`, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await page.waitForTimeout(2000);
        push("nav", {
          url: pathTry,
          status: res?.status(),
          note: `title=${await page.title()}`,
        });
      } catch (e) {
        push("nav_fail", { url: pathTry, note: e.message });
      }
    }

    // PDP
    try {
      const res = await page.goto(PRODUCT, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForTimeout(12000);
      const pdpHtml = await page.content();
      fs.writeFileSync(path.join(OUT_DIR, "pdp.html"), pdpHtml.slice(0, 800_000));
      push("pdp", {
        status: res?.status(),
        url: page.url(),
        bytes: pdpHtml.length,
        note: /Incapsula|var dd=|Pardon Our Interruption/i.test(pdpHtml)
          ? "blocked"
          : /add to (bag|cart)/i.test(pdpHtml)
            ? "atc_visible"
            : "loaded",
      });

      // Try click ATC if present
      const atc = page
        .locator(
          'button:has-text("Add to Cart"), button:has-text("Add to Bag"), [data-testid*="add-to-cart" i], button[name*="add" i]',
        )
        .first();
      if (await atc.count().catch(() => 0)) {
        await atc.click({ timeout: 8000 }).catch((e) => push("atc_click_fail", { note: e.message }));
        await page.waitForTimeout(8000);
        push("atc_click", { note: page.url() });
      } else {
        push("atc_missing", { note: "no ATC button" });
      }
    } catch (e) {
      push("pdp_fail", { note: e.message });
    }

    // Try intl-checkout / cart URLs
    for (const pathTry of ["/carts", "/minicarts", "/intl-checkout", "/checkout", `/${LOCALE}/cart`]) {
      try {
        const res = await page.goto(`${ORIGIN}${pathTry}`, {
          waitUntil: "domcontentloaded",
          timeout: 40_000,
        });
        await page.waitForTimeout(3000);
        push("checkout_nav", {
          url: pathTry,
          status: res?.status(),
          final: page.url(),
          note: (await page.title()).slice(0, 80),
        });
      } catch (e) {
        push("checkout_nav_fail", { url: pathTry, note: e.message });
      }
    }

    const cookies = await context.cookies();
    fs.writeFileSync(
      path.join(OUT_DIR, "cookies.json"),
      JSON.stringify(
        cookies.map((c) => ({
          name: c.name,
          domain: c.domain,
          path: c.path,
          valueLen: String(c.value || "").length,
          // redact values — keep only prefixes for known antibot cookies
          valuePrefix: ["reese84", "datadome", "visid_incap", "incap_ses", "nlbi_"].some((p) =>
            c.name.startsWith(p) || c.name === p,
          )
            ? String(c.value).slice(0, 24)
            : undefined,
        })),
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(OUT_DIR, "steps.json"), JSON.stringify(steps, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, "netlog.json"), JSON.stringify(netLog.slice(0, 400), null, 2));
  } finally {
    await context.close(); // flushes HAR
    await browser.close();
  }

  let summary = { steps };
  if (fs.existsSync(harPath)) {
    summary = { ...summarizeHar(harPath), steps };
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
    console.log("[pc-capture] summary hosts=", summary.hosts?.length, "entries=", summary.entryCount);
    console.log("[pc-capture] globaleMid=", summary.globaleMid, "gem=", summary.gemHost, "secure=", summary.secureHost);
    console.log("[pc-capture] reesePath=", summary.reesePath, "hcaptcha=", summary.hcaptchaSitekey);
    console.log("[pc-capture] cookies=", summary.cookieNames?.join(", "));
  }
  console.log("[pc-capture] done", OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
