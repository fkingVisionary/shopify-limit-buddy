#!/usr/bin/env node
// Pokémon Centre AU capture via Hyper Playwright handlers (Incapsula + DataDome).
// Per Hyper docs: handlers intercept interstitial/slider POSTs and inject solved payloads.
// Refs:
//   https://docs.hypersolutions.co/datadome/getting-started.md
//   https://docs.hypersolutions.co/incapsula/reese84.md
//   https://docs.hypersolutions.co/request-based-basics/header-order.md
//
// Env: HYPER_API_KEY, PROXY=host:port:user:pass
// Does not commit secrets.

import fs from "node:fs";
import { chromium } from "playwright";
import { Session } from "hyper-sdk-js";
import { generateReese84Sensor, Reese84Input } from "hyper-sdk-js/incapsula/reese";
import * as hyperPw from "hyper-sdk-playwright";

/**
 * hyper-sdk-playwright@1.0.0-beta.9 calls Reese84Input as:
 *   (ua, ip, lang, pageUrl, emptyPowSlot, scriptBody, scriptUrl)
 * but hyper-sdk-js@2.12 Reese84Input is:
 *   (ua, ip, lang, pageUrl, script, scriptUrl, pow?)
 * That swaps script/scriptUrl and yields Hyper `invalid scriptUrl` — an SDK
 * wiring bug, not a proxy failure. Patch before initialize().
 */
function patchIncapsulaReeseArgOrder(Handler) {
  if (!Handler?.prototype?.handleIncapsulaRequest || Handler.prototype.__pcReeseArgOrderFixed) {
    return;
  }
  Handler.prototype.handleIncapsulaRequest = async function handleIncapsulaRequestFixed(
    route,
    page,
    context,
    scriptPath,
    requestUrl,
  ) {
    const postData = route.request().postData();
    if (postData && postData.startsWith('"')) {
      console.log(`[IncapsulaHandler] Letting through Reese84 refresh POST for path: ${scriptPath}`);
      return route.continue();
    }
    console.log(`[IncapsulaHandler] Intercepting Incapsula POST (arg-order fixed) for path: ${scriptPath}`);
    if (!this.scriptCapture.interceptedPaths.includes(scriptPath)) {
      this.scriptCapture.interceptedPaths.push(scriptPath);
    }
    if (!this.userAgent) {
      this.userAgent = await page.evaluate(() => navigator.userAgent);
    }
    const script = this.scriptPathToScriptContent.get(scriptPath) || "";
    const scriptUrl = this.scriptPathToScriptUrl.get(scriptPath) || "";
    if (!script || !scriptUrl) {
      console.error(
        "[IncapsulaHandler] Missing script body/URL after detect — continuing original POST (impl gap, not proxy)",
      );
      return route.continue();
    }
    const result = await generateReese84Sensor(
      this.session,
      new Reese84Input(
        this.userAgent,
        this.ipAddress,
        this.acceptLanguage,
        page.url(),
        script,
        scriptUrl,
        "",
      ),
    );
    await route.continue({ postData: result });
  };
  Handler.prototype.__pcReeseArgOrderFixed = true;
}

const OUT = process.env.PC_CAPTURE_DIR || `/tmp/pc-hyper-pw-${Date.now()}`;
const PROXY_RAW = String(process.env.PROXY || "").trim();
const HOME = process.env.PC_HOME || "https://www.pokemoncenter.com/en-au/";
const PDP =
  process.env.PC_PDP ||
  "https://www.pokemoncenter.com/en-au/product/10-10186-109/pokemon-tcg-mega-evolution-phantasmal-flames-pokemon-center-elite-trainer-box";
const DWELL_MS = Number(process.env.DWELL_MS || 45000);

fs.mkdirSync(OUT, { recursive: true });

function parseProxy(raw) {
  const parts = String(raw).trim().split(":");
  if (parts.length < 4) throw new Error("PROXY must be host:port:user:pass");
  return {
    server: `http://${parts[0]}:${parts[1]}`,
    username: parts[2],
    password: parts.slice(3).join(":"),
  };
}

function classifyDd(html) {
  const h = String(html || "");
  const rt = (h.match(/['"]rt['"]\s*:\s*['"]([^'"]+)/) || [])[1] || null;
  const t = (h.match(/['"]t['"]\s*:\s*['"]([^'"]+)/) || [])[1] || null;
  // Hyper DataDome slider docs: t=bv on slider block page => hard IP block
  // (solving will not help). Interstitial uses rt=i + i.js — different path.
  return {
    bytes: h.length,
    rt,
    t,
    interstitial: /ct\.captcha-delivery\.com\/i\.js/i.test(h) || rt === "i",
    slider: /ct\.captcha-delivery\.com\/c\.js/i.test(h) || rt === "c",
    hardBlockPerHyperDocs: t === "bv",
    clear: h.length > 20_000 && !/var\s+dd\s*=/i.test(h) && !/Please enable JS/i.test(h),
    title: (h.match(/<title>([^<]+)/i) || [])[1] || null,
    atc: /add to (bag|cart)/i.test(h),
    globaleMid:
      (h.match(/globaleMid["']?\s*[:=]\s*["']?(\d{3,6})/i) ||
        h.match(/clientsdk\/(\d{3,6})/i) ||
        [])[1] || null,
    gemHost: (h.match(/(gem-[a-z0-9-]+\.global-e\.com)/i) || [])[1] || null,
  };
}

const steps = [];
const push = (step, extra = {}) => {
  const row = { step, at: new Date().toISOString(), ...extra };
  steps.push(row);
  console.log("[pw]", step, extra.note || JSON.stringify(extra).slice(0, 160));
};

async function main() {
  const apiKey = String(process.env.HYPER_API_KEY || "").trim();
  if (!apiKey) throw new Error("HYPER_API_KEY missing");
  if (!PROXY_RAW) throw new Error("PROXY missing");

  const proxy = parseProxy(PROXY_RAW);
  const userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const acceptLanguage = "en-AU,en;q=0.9";

  const browser = await chromium.launch({
    headless: true,
    proxy,
  });
  const context = await browser.newContext({
    userAgent,
    locale: "en-AU",
    viewport: { width: 1360, height: 900 },
    recordHar: { path: `${OUT}/capture.har`, mode: "full", content: "embed" },
  });

  // Resolve egress IP (Hyper APIs need the IP the target sees).
  // Connection errors here are often transient / TLS path flakes — retry before
  // condemning the sticky (Hyper TLS docs; see POKEMON_CENTRE_MODULE.md §3.4).
  let ipAddress = "0.0.0.0";
  const ipPage = await context.newPage();
  const ipUrls = [
    "https://api.ipify.org?format=json",
    "https://icanhazip.com",
    "https://ifconfig.me/ip",
  ];
  let ipErr = null;
  for (const ipUrl of ipUrls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ipPage.goto(ipUrl, { timeout: 30_000, waitUntil: "domcontentloaded" });
        const body = (await ipPage.textContent("body"))?.trim() || "";
        try {
          ipAddress = JSON.parse(body).ip || ipAddress;
        } catch {
          const m = body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
          if (m) ipAddress = m[0];
        }
        if (ipAddress && ipAddress !== "0.0.0.0") {
          ipErr = null;
          break;
        }
      } catch (e) {
        ipErr = e;
        push("egress_retry", {
          note: `${ipUrl} attempt ${attempt + 1}: ${e.message?.split("\n")[0]}`,
          hint: "Nav/TLS flake ≠ automatic burnt proxy — retrying alternate IP endpoint",
        });
      }
    }
    if (ipAddress && ipAddress !== "0.0.0.0") break;
  }
  await ipPage.close();
  if (!ipAddress || ipAddress === "0.0.0.0") {
    throw ipErr || new Error("egress IP resolve failed after retries");
  }
  push("egress", { note: ipAddress });

  const session = new Session(apiKey, undefined, undefined, undefined, { timeout: 25_000 });
  const page = await context.newPage();
  const handlerConfigs = { session, ipAddress, acceptLanguage, userAgent };
  if (typeof hyperPw.IncapsulaHandler === "function") {
    patchIncapsulaReeseArgOrder(hyperPw.IncapsulaHandler);
    push("incapsula_patch", {
      note: "Reese84Input arg order fixed (beta.9 vs sdk-js 2.12) — was invalid scriptUrl",
      ref: "https://docs.hypersolutions.co/incapsula/reese84.md",
    });
  }
  const handlers = [
    ["incapsula", hyperPw.IncapsulaHandler],
    ["datadome", hyperPw.DataDomeHandler],
  ]
    .filter(([, H]) => typeof H === "function")
    .map(([name, Handler]) => ({ name, handler: new Handler(handlerConfigs) }));

  await Promise.all(handlers.map(({ handler }) => handler.initialize(page, context)));
  push("handlers", { note: handlers.map((h) => h.name).join("+") });

  // Navigate home — handlers intercept Reese POST + DD interstitial/slider
  let homeRes;
  try {
    homeRes = await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 90_000 });
  } catch (e) {
    push("home_goto", {
      ok: false,
      note: e.message?.split("\n")[0],
      // Connection errors are often TLS/handshake/order issues per Hyper TLS docs —
      // do not classify as "bad proxy" without confirming egress + retry.
      hint: "Check Hyper TLS fingerprinting + header-order docs before blaming proxy",
    });
    throw e;
  }
  push("home_nav", { status: homeRes?.status(), url: page.url() });

  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < DWELL_MS) {
    await page.waitForTimeout(2500);
    const html = await page.content();
    last = classifyDd(html);
    const st = Object.fromEntries(handlers.map(({ name, handler }) => [name, handler.getStatus?.() ?? null]));
    push("dwell", {
      t: Math.round((Date.now() - t0) / 1000),
      ...last,
      hyper: {
        incapPaths: st.incapsula?.interceptedPaths?.length ?? null,
        ddProcessing: st.datadome?.isProcessing ?? null,
        ddCaptcha: Boolean(st.datadome?.captchaPageUrl),
        ddInterstitial: Boolean(st.datadome?.interstitialPageUrl),
      },
    });
    fs.writeFileSync(`${OUT}/home-last.html`, html.slice(0, 800_000));
    if (last.clear) {
      fs.writeFileSync(`${OUT}/home-clear.html`, html.slice(0, 1_200_000));
      break;
    }
    // Hyper slider docs: t=bv => hard block; solving will not help — rotate session.
    if (last.hardBlockPerHyperDocs && last.slider) {
      push("hyper_slider_hard_block", {
        ok: false,
        note: "DataDome slider t=bv — Hyper docs: hard IP block; solving has no effect. Rotate sticky session (only this signal).",
        ref: "https://docs.hypersolutions.co/datadome/getting-started.md#slider",
      });
      break;
    }
  }

  // PDP attempt if home cleared or still trying
  if (last?.clear || !last?.hardBlockPerHyperDocs) {
    try {
      const pdpRes = await page.goto(PDP, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForTimeout(12000);
      const pdpHtml = await page.content();
      const pdp = classifyDd(pdpHtml);
      fs.writeFileSync(`${OUT}/pdp.html`, pdpHtml.slice(0, 1_200_000));
      push("pdp", { status: pdpRes?.status(), ...pdp });

      // Soft cortex probes in-page fetch (shares cookies)
      const probes = await page.evaluate(async () => {
        const paths = [
          "/cortex",
          "/carts",
          "/extcarts",
          "/items",
          "/minicarts",
          "/intl-checkout",
          "/checkout",
        ];
        const out = {};
        for (const p of paths) {
          try {
            const r = await fetch(p, { credentials: "include", headers: { accept: "application/json,text/html,*/*" } });
            const t = await r.text();
            let keys = null;
            try {
              keys = Object.keys(JSON.parse(t)).slice(0, 12);
            } catch {
              /* ignore */
            }
            out[p] = { status: r.status, bytes: t.length, keys, snippet: t.slice(0, 100) };
          } catch (e) {
            out[p] = { error: String(e?.message || e) };
          }
        }
        return out;
      });
      push("cortex_probes", { probes });
      fs.writeFileSync(`${OUT}/cortex-probes.json`, JSON.stringify(probes, null, 2));
    } catch (e) {
      push("pdp_fail", {
        note: e.message?.split("\n")[0],
        hint: "Nav error ≠ proxy guilt; confirm handler status + DD view=redirect first",
      });
    }
  }

  const cookies = await context.cookies();
  const findings = {
    egressIp: ipAddress,
    home: last,
    handlers: Object.fromEntries(handlers.map(({ name, handler }) => [name, handler.getStatus?.() ?? null])),
    cookies: cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      len: c.value.length,
      prefix: c.value.slice(0, 12),
    })),
    steps,
    refs: [
      "https://docs.hypersolutions.co/datadome/getting-started.md",
      "https://docs.hypersolutions.co/incapsula/reese84.md",
      "https://docs.hypersolutions.co/request-based-basics/header-order.md",
    ],
  };
  fs.writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));
  fs.writeFileSync(`${OUT}/steps.json`, JSON.stringify(steps, null, 2));

  await context.close();
  await browser.close();
  console.log(
    JSON.stringify(
      {
        out: OUT,
        egress: ipAddress,
        clear: Boolean(last?.clear),
        homeBytes: last?.bytes,
        rt: last?.rt,
        t: last?.t,
        hardBlockPerHyperDocs: last?.hardBlockPerHyperDocs,
        globaleMid: last?.globaleMid || null,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${OUT}/error.txt`, String(e?.stack || e));
  process.exit(1);
});
