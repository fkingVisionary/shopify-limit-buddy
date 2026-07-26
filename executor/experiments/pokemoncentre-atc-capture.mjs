#!/usr/bin/env node
// Warm edge via Hyper HTTP (Reese + DD view=redirect), then Playwright ATC
// network capture on the same sticky + cookies.
// Env: HYPER_API_KEY, PROXY=host:port:user:pass
// Refs: docs/POKEMON_CENTRE_MODULE.md §3.4 + Hyper DataDome getting-started.

import fs from "node:fs";
import { chromium } from "playwright";
import { createJar, makeDispatcher, request, UA } from "../http.js";
import { resolveEgressIp } from "../ip-resolve.js";
import {
  extractReeseScriptPath,
  solveIncapsulaReese84,
  looksLikeDataDomeBlock,
  parseInterstitialDeviceCheckUrl,
  solveDataDomeInterstitial,
  hyperConfigured,
} from "../antibot.js";
import {
  applyDatadomeSolveJson,
  PC_REESE_SCRIPT_PATH,
} from "../adapters/pokemoncentre-edge.js";

const OUT = process.env.PC_CAPTURE_DIR || `/tmp/pc-atc-${Date.now()}`;
const PROXY_RAW = String(process.env.PROXY || "").trim();
const ORIGIN = "https://www.pokemoncenter.com";
const HOME = `${ORIGIN}/en-au/`;
const PDP =
  process.env.PC_PDP ||
  `${ORIGIN}/en-au/product/10-10320-101/pokemon-tcg-mewtwo-and-mew-dna-premium-zip-binder`;

fs.mkdirSync(OUT, { recursive: true });

function parseProxy(raw) {
  const parts = String(raw).trim().split(":");
  if (parts.length < 4) throw new Error("PROXY must be host:port:user:pass");
  return {
    server: `http://${parts[0]}:${parts[1]}`,
    username: parts[2],
    password: parts.slice(3).join(":"),
    raw,
  };
}

async function httpWarm(proxyRaw) {
  const dispatcher = makeDispatcher(proxyRaw, { forceUndici: true });
  const jar = createJar();
  const ctx = { jar, dispatcher };
  const steps = [];
  const push = (step, extra = {}) => {
    steps.push({ step, ...extra });
    console.log("[warm]", step, extra.note || extra.status || "");
  };

  try {
    const ip = await resolveEgressIp(ctx);
    push("egress", { note: ip });

    const get = async (url, headers = {}) => {
      const res = await request(
        url,
        {
          method: "GET",
          headers: {
            "user-agent": UA,
            "accept-language": "en-AU,en;q=0.9",
            accept: "text/html,application/xhtml+xml,*/*",
            ...headers,
          },
        },
        ctx,
      );
      jar.ingest(res.headers);
      return res;
    };
    const post = async (url, body, headers = {}) => {
      const res = await request(
        url,
        {
          method: "POST",
          body,
          headers: { "user-agent": UA, "accept-language": "en-AU,en;q=0.9", ...headers },
        },
        ctx,
      );
      jar.ingest(res.headers);
      return res;
    };

    let res = await get(HOME, { "upgrade-insecure-requests": "1" });
    let html = await res.text();
    push("home0", { status: res.status, note: `${html.length}b` });

    const scriptPath = extractReeseScriptPath(html) || PC_REESE_SCRIPT_PATH;
    const scriptUrl = `${ORIGIN}${scriptPath}`;
    const script = await (await get(scriptUrl, { referer: HOME, accept: "*/*" })).text();
    const { payload } = await solveIncapsulaReese84({
      userAgent: UA,
      ip,
      acceptLanguage: "en-AU,en;q=0.9",
      pageUrl: HOME,
      scriptBody: script,
      scriptUrl,
    });
    const pr = await post(`${scriptUrl}?d=www.pokemoncenter.com`, payload, {
      referer: HOME,
      "content-type": "text/plain; charset=utf-8",
      origin: ORIGIN,
      accept: "application/json",
    });
    const pt = await pr.text();
    let token = null;
    try {
      token = JSON.parse(pt).token;
    } catch {
      /* ignore */
    }
    if (token) jar.set("reese84", token);
    push("reese", { ok: Boolean(token), note: token ? token.slice(0, 24) : pt.slice(0, 60) });

    res = await get(HOME);
    html = await res.text();
    if (looksLikeDataDomeBlock(html, res.status)) {
      const cookie = jar.get("datadome") || "";
      const deviceLink = parseInterstitialDeviceCheckUrl(html, cookie, HOME);
      const deviceHtml = await (
        await get(deviceLink, { referer: HOME, accept: "text/html" })
      ).text();
      const solved = await solveDataDomeInterstitial({
        html,
        datadomeCookie: cookie,
        referer: HOME,
        userAgent: UA,
        ip,
        acceptLanguage: "en-AU,en;q=0.9",
        deviceLinkHtml: deviceHtml,
      });
      const dd = await post(solved.postUrl, solved.payload, {
        referer: HOME,
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://geo.captcha-delivery.com",
        ...(solved.headers || {}),
      });
      const dj = JSON.parse(await dd.text());
      const applied = applyDatadomeSolveJson(jar, dj);
      push("dd", { view: dj.view, ok: applied.ok });
      if (!applied.ok) {
        throw new Error(`DD not redirect: view=${dj.view}`);
      }
    }

    res = await get(HOME);
    html = await res.text();
    push("home_clear", { status: res.status, note: `${html.length}b` });
    if (res.status !== 200 || html.length < 20_000) {
      throw new Error(`home not clear after edge: ${res.status} ${html.length}b`);
    }

    const cookies = Object.entries(jar.dump()).map(([name, value]) => ({
      name,
      value,
      domain: name === "reese84" ? "www.pokemoncenter.com" : ".pokemoncenter.com",
      path: "/",
      secure: true,
      httpOnly: false,
    }));
    return { ip, cookies, jarDump: jar.dump(), steps };
  } finally {
    await dispatcher.close?.();
  }
}

async function pwAtc(proxy, cookies) {
  const browser = await chromium.launch({
    headless: true,
    proxy: {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    },
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-AU",
    viewport: { width: 1360, height: 900 },
    recordHar: { path: `${OUT}/atc.har`, mode: "full", content: "embed" },
  });
  await context.addCookies(cookies);

  const interesting = [];
  const page = await context.newPage();
  page.on("request", (req) => {
    const u = req.url();
    if (/auth|cortex|carts|oauth|execute-api|global-e|extcarts|get-public|get-globale/i.test(u)) {
      interesting.push({
        type: "req",
        method: req.method(),
        url: u,
        headers: req.headers(),
        postData: req.postData()?.slice(0, 500) || null,
      });
    }
  });
  page.on("response", async (res) => {
    const u = res.url();
    if (/auth|cortex|carts|oauth|execute-api|global-e|extcarts|get-public|get-globale/i.test(u)) {
      let body = null;
      try {
        body = (await res.text()).slice(0, 800);
      } catch {
        /* ignore */
      }
      interesting.push({
        type: "res",
        status: res.status(),
        url: u,
        body,
      });
    }
  });

  const steps = [];
  const push = (step, extra = {}) => {
    steps.push({ step, ...extra });
    console.log("[atc]", step, extra.note || "");
  };

  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(4000);
  const homeHtml = await page.content();
  fs.writeFileSync(`${OUT}/pw-home.html`, homeHtml.slice(0, 400_000));
  push("pw_home", {
    note: `${page.url()} ${homeHtml.length}b clear=${homeHtml.length > 20_000 && !/var\s+dd\s*=/.test(homeHtml)}`,
  });

  await page.goto(PDP, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(6000);
  const pdpHtml = await page.content();
  fs.writeFileSync(`${OUT}/pw-pdp.html`, pdpHtml.slice(0, 900_000));
  push("pw_pdp", { note: `${page.url()} ${(await page.title())}` });

  // Prefer product ATC button
  const selectors = [
    'button:has-text("Add to Cart")',
    'button:has-text("ADD TO CART")',
    'button:has-text("Add to Bag")',
    'button:has-text("ADD THIS ITEM")',
    '[data-test*="add-to-cart"]',
    '[data-testid*="add-to-cart"]',
    'button[aria-label*="Add to"]',
  ];
  let clicked = false;
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      try {
        await loc.click({ timeout: 5000 });
        clicked = true;
        push("click", { note: sel });
        break;
      } catch (e) {
        push("click_fail", { note: `${sel}: ${e.message?.split("\n")[0]}` });
      }
    }
  }
  if (!clicked) {
    // dump buttons
    const buttons = await page.$$eval("button", (els) =>
      els.slice(0, 40).map((e) => ({
        text: (e.textContent || "").trim().slice(0, 80),
        aria: e.getAttribute("aria-label"),
        disabled: e.disabled,
      })),
    );
    fs.writeFileSync(`${OUT}/buttons.json`, JSON.stringify(buttons, null, 2));
    push("no_atc_button", { note: `buttons=${buttons.length}` });
  }

  await page.waitForTimeout(10000);
  const cookiesAfter = await context.cookies();
  fs.writeFileSync(`${OUT}/network.json`, JSON.stringify(interesting, null, 2));
  fs.writeFileSync(
    `${OUT}/cookies-after.json`,
    JSON.stringify(
      cookiesAfter.map((c) => ({
        name: c.name,
        domain: c.domain,
        len: c.value.length,
        prefix: c.value.slice(0, 16),
      })),
      null,
      2,
    ),
  );
  fs.writeFileSync(`${OUT}/pw-steps.json`, JSON.stringify(steps, null, 2));

  await context.close();
  await browser.close();
  return { steps, interesting, clicked };
}

async function main() {
  if (!hyperConfigured()) throw new Error("HYPER_API_KEY missing");
  if (!PROXY_RAW) throw new Error("PROXY missing");
  const proxy = parseProxy(PROXY_RAW);
  const warm = await httpWarm(proxy.raw);
  fs.writeFileSync(`${OUT}/warm.json`, JSON.stringify({ ip: warm.ip, steps: warm.steps, cookies: Object.keys(warm.jarDump) }, null, 2));

  const atc = await pwAtc(proxy, warm.cookies);
  const authish = atc.interesting.filter((x) =>
    /auth|get-public|token|Authorization|cortex|carts\/items/i.test(
      JSON.stringify(x),
    ),
  );
  const summary = {
    out: OUT,
    egress: warm.ip,
    clicked: atc.clicked,
    networkEvents: atc.interesting.length,
    authish: authish.slice(0, 40),
    urls: [...new Set(atc.interesting.map((x) => x.url))].slice(0, 40),
  };
  fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${OUT}/error.txt`, String(e?.stack || e));
  process.exit(1);
});
