#!/usr/bin/env node
// Full PC AU capture: sticky resi + Hyper Reese84 + DataDome interstitial → PDP/Cortex probe.
// Secrets via env only:
//   HYPER_API_KEY=… PROXY='host:port:user:pass' node experiments/pokemoncentre-hyper-capture.mjs
// Never commits credentials.
//
// Failure triage (Hyper — do not over-blame proxies):
//   https://docs.hypersolutions.co/datadome/getting-started.md
//   https://docs.hypersolutions.co/request-based-basics/header-order.md
//   https://docs.hypersolutions.co/request-based-basics/tls-fingerprinting.md
//   docs/POKEMON_CENTRE_MODULE.md §3.4

import fs from "node:fs";
import { createJar, makeDispatcher, request, UA } from "../http.js";
import { resolveEgressIp } from "../ip-resolve.js";
import {
  looksLikeIncapsulaChallenge,
  extractReeseScriptPath,
  solveIncapsulaReese84,
  looksLikeDataDomeBlock,
  parseDataDomeObject,
  solveDataDomeInterstitial,
  parseInterstitialDeviceCheckUrl,
  parseSliderDeviceCheckUrl,
  solveDataDomeSlider,
  hyperConfigured,
} from "../antibot.js";
import {
  PC_REESE_SCRIPT_PATH,
  applyDatadomeSolveJson,
  parseDatadomeSetCookie,
} from "../adapters/pokemoncentre-edge.js";

const OUT = process.env.PC_CAPTURE_DIR || `/tmp/pc-hyper-capture-${Date.now()}`;
const PROXY_RAW = String(process.env.PROXY || "").trim();
const LOCALE = process.env.PC_LOCALE || "en-au";
const ORIGIN = "https://www.pokemoncenter.com";
const HOME = `${ORIGIN}/${LOCALE}/`;
const PDP =
  process.env.PC_PDP ||
  `${ORIGIN}/${LOCALE}/product/10-10186-109/pokemon-tcg-mega-evolution-phantasmal-flames-pokemon-center-elite-trainer-box`;

fs.mkdirSync(OUT, { recursive: true });

const steps = [];
function push(step, extra = {}) {
  const row = { step, at: new Date().toISOString(), ...extra };
  steps.push(row);
  console.log("[cap]", step, extra.note || extra.status || "");
  return row;
}

async function readText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function get(ctx, url, headers = {}) {
  const res = await request(
    url,
    {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-AU,en;q=0.9",
        "user-agent": UA,
        ...headers,
      },
    },
    ctx,
  );
  ctx.jar.ingest(res.headers);
  return res;
}

async function post(ctx, url, body, headers = {}) {
  const res = await request(
    url,
    {
      method: "POST",
      headers: {
        "user-agent": UA,
        "accept-language": "en-AU,en;q=0.9",
        ...headers,
      },
      body,
    },
    ctx,
  );
  ctx.jar.ingest(res.headers);
  return res;
}

async function clearReese(ctx, pageUrl, html) {
  const scriptPath = extractReeseScriptPath(html) || PC_REESE_SCRIPT_PATH;
  const scriptUrl = `${ORIGIN}${scriptPath}`;
  const scriptRes = await get(ctx, scriptUrl, {
    referer: pageUrl,
    accept: "*/*",
    "sec-fetch-dest": "script",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "same-origin",
  });
  const scriptBody = await readText(scriptRes);
  if (scriptBody.length < 1000) {
    return { ok: false, note: `script ${scriptRes.status} ${scriptBody.length}b` };
  }
  const ip = await resolveEgressIp(ctx).catch(() => "");
  const { payload } = await solveIncapsulaReese84({
    userAgent: UA,
    ip,
    acceptLanguage: "en-AU,en;q=0.9",
    pageUrl,
    scriptBody,
    scriptUrl,
  });
  const postUrl = `${scriptUrl}?d=www.pokemoncenter.com`;
  const postRes = await post(ctx, postUrl, payload, {
    referer: pageUrl,
    "content-type": "text/plain; charset=utf-8",
    accept: "application/json, text/plain, */*",
    origin: ORIGIN,
  });
  const postText = await readText(postRes);
  let token = null;
  try {
    token = JSON.parse(postText)?.token || null;
  } catch {
    /* ignore */
  }
  if (token) ctx.jar.set("reese84", token);
  return {
    ok: Boolean(token),
    note: token ? `reese84 ${token.slice(0, 20)}…` : `post ${postRes.status} ${postText.slice(0, 80)}`,
    scriptPath,
    tokenLen: token?.length || 0,
  };
}

async function clearDd(ctx, pageUrl, html) {
  const dd = parseDataDomeObject(html) || {};
  const cookie = ctx.jar.get("datadome") || dd.cookie || "";
  const htmlStr = String(html || "");
  const isInterstitial =
    dd.rt === "i" || /ct\.captcha-delivery\.com\/i\.js/i.test(htmlStr);
  const isSlider = dd.rt === "c" || /ct\.captcha-delivery\.com\/c\.js/i.test(htmlStr);
  const slider = isSlider ? parseSliderDeviceCheckUrl(html, cookie, pageUrl) : null;

  // Hyper slider docs: t=bv only means hard IP block on a *slider* block page.
  // Do not treat interstitial rt=i (or random connection errors) as proxy guilt.
  if (isSlider && (slider?.isIpBanned || dd.t === "bv")) {
    return {
      ok: false,
      isIpBanned: true,
      kind: "slider_hard_block",
      note: "DataDome slider t=bv — Hyper docs: hard IP block; solving has no effect",
      ref: "https://docs.hypersolutions.co/datadome/getting-started.md#slider",
      dd,
    };
  }

  const ip = await resolveEgressIp(ctx).catch(() => "");

  if (isInterstitial || (!isSlider && dd.rt !== "c")) {
    const deviceLink = parseInterstitialDeviceCheckUrl(html, cookie, pageUrl);
    if (!deviceLink) return { ok: false, note: "no interstitial deviceLink", dd };
    const deviceRes = await get(ctx, deviceLink, { referer: pageUrl, accept: "text/html" });
    const deviceHtml = await readText(deviceRes);
    fs.writeFileSync(`${OUT}/dd-device.html`, deviceHtml.slice(0, 400_000));
    const solved = await solveDataDomeInterstitial({
      html,
      datadomeCookie: cookie,
      referer: pageUrl,
      userAgent: UA,
      ip,
      acceptLanguage: "en-AU,en;q=0.9",
      deviceLinkHtml: deviceHtml,
    });
    const postRes = await post(ctx, solved.postUrl, solved.payload, {
      referer: pageUrl,
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://geo.captcha-delivery.com",
      ...(solved.headers || {}),
    });
    const postText = await readText(postRes);
    fs.writeFileSync(`${OUT}/dd-interstitial-resp.txt`, postText.slice(0, 50_000));
    let json = null;
    try {
      json = JSON.parse(postText);
    } catch {
      return {
        ok: false,
        kind: "interstitial",
        status: postRes.status,
        note: `interstitial POST non-JSON ${postRes.status} — check TLS/header path before blaming proxy`,
        refs: [
          "https://docs.hypersolutions.co/request-based-basics/tls-fingerprinting.md",
          "https://docs.hypersolutions.co/request-based-basics/header-order.md",
        ],
        dd,
      };
    }
    const applied = applyDatadomeSolveJson(ctx.jar, json);
    const view = json.view || null;
    const captchaUrl = json.url || null;

    // Hyper success: view === "redirect" (+ cookie). Cookie rotation alone is not success.
    if (view === "redirect" && applied.cookie) {
      return {
        ok: true,
        kind: "interstitial",
        status: postRes.status,
        view,
        note: "datadome interstitial view=redirect (Hyper success)",
        ref: "https://docs.hypersolutions.co/datadome/getting-started.md",
        dd,
      };
    }

    if (view === "captcha") {
      const captchaHasBv = captchaUrl && /[?&]t=bv\b/i.test(captchaUrl);
      // Escalation is usually TLS/header fingerprint on HTTP clients. Prefer Hyper PW handlers.
      // Only when the escalated captcha URL carries t=bv do we cite Hyper hard-block.
      return {
        ok: false,
        isIpBanned: Boolean(captchaHasBv),
        kind: captchaHasBv ? "interstitial_escalated_hard_block" : "interstitial_escalated",
        status: postRes.status,
        view,
        captchaUrl: captchaUrl ? captchaUrl.slice(0, 180) : null,
        note: captchaHasBv
          ? "interstitial→captcha with t=bv — Hyper hard-block hint; confirm TLS client first, then rotate sticky"
          : "interstitial view=captcha (not redirect) — fix header-order/TLS (Hyper docs); do not spray proxies",
        refs: [
          "https://docs.hypersolutions.co/datadome/getting-started.md#posting-payload-solving-challenge",
          "https://docs.hypersolutions.co/request-based-basics/header-order.md",
          "https://docs.hypersolutions.co/request-based-basics/tls-fingerprinting.md",
        ],
        dd,
        cookieParsed: Boolean(parseDatadomeSetCookie(json.cookie)),
      };
    }

    return {
      ok: false,
      kind: "interstitial",
      status: postRes.status,
      view,
      note: `interstitial unexpected view=${view || "?"} cookie=${Boolean(applied.cookie)}`,
      dd,
    };
  }

  // Slider path
  const deviceLink = slider?.url;
  if (!deviceLink) return { ok: false, note: "no slider deviceLink", dd };
  const deviceRes = await get(ctx, deviceLink, { referer: pageUrl });
  const deviceHtml = await readText(deviceRes);
  fs.writeFileSync(`${OUT}/dd-slider-device.html`, deviceHtml.slice(0, 400_000));
  const puzzleUrl =
    (deviceHtml.match(/https?:\/\/[^"' ]+\.jpg/i) || [])[0] ||
    (deviceHtml.match(/\/image\/[^"' ]+\.jpg/i) || [])[0];
  const pieceUrl =
    (deviceHtml.match(/https?:\/\/[^"' ]+\.frag\.png/i) || [])[0] ||
    (deviceHtml.match(/\/image\/[^"' ]+\.frag\.png/i) || [])[0];
  if (!puzzleUrl || !pieceUrl) {
    return { ok: false, note: "slider images missing", needsHcaptcha: /hcaptcha/i.test(deviceHtml), dd };
  }
  const abs = (u) => (u.startsWith("http") ? u : `https://dd.prod.captcha-delivery.com${u}`);
  const puzzleRes = await get(ctx, abs(puzzleUrl), { referer: deviceLink });
  const pieceRes = await get(ctx, abs(pieceUrl), { referer: deviceLink });
  const puzzleB64 = Buffer.from(await puzzleRes.arrayBuffer()).toString("base64");
  const pieceB64 = Buffer.from(await pieceRes.arrayBuffer()).toString("base64");
  const solved = await solveDataDomeSlider({
    html,
    datadomeCookie: cookie,
    referer: pageUrl,
    parentUrl: pageUrl,
    userAgent: UA,
    ip,
    acceptLanguage: "en-AU,en;q=0.9",
    deviceLinkHtml: deviceHtml,
    puzzleB64,
    pieceB64,
  });
  if (solved.isIpBanned) return { ok: false, isIpBanned: true, note: "slider IP ban", dd };
  const verify = await get(ctx, solved.payload, { referer: pageUrl, ...(solved.headers || {}) });
  await readText(verify);
  return {
    ok: Boolean(ctx.jar.get("datadome")),
    note: `slider verify ${verify.status}`,
    kind: "slider",
    dd,
  };
}

function summarizeHtml(html, status) {
  const dd = parseDataDomeObject(html);
  return {
    status,
    bytes: html.length,
    incap: looksLikeIncapsulaChallenge(html, status),
    ddBlock: looksLikeDataDomeBlock(html, status),
    ddT: dd?.t || null,
    ddRt: dd?.rt || null,
    title: (html.match(/<title>([^<]+)/i) || [])[1] || null,
    h1: (html.match(/<h1[^>]*>([^<]+)/i) || [])[1] || null,
    atc: /add to (bag|cart)/i.test(html),
    globale: /global-e|globaleMid|gem-[a-z0-9-]+\.global-e/i.test(html),
    globaleMid:
      (html.match(/globaleMid["']?\s*[:=]\s*["']?(\d{3,6})/i) ||
        html.match(/clientsdk\/(\d{3,6})/i) ||
        [])[1] || null,
    gemHost: (html.match(/(gem-[a-z0-9-]+\.global-e\.com)/i) || [])[1] || null,
    secureHost: (html.match(/(secure-[a-z0-9-]+\.global-e\.com)/i) || [])[1] || null,
    hcaptcha: (html.match(/data-sitekey=["']([^"']+)["']/i) || [])[1] || null,
    cortexHints: [...html.matchAll(/\/(?:cortex|carts|extcarts|items|availabilities|minicarts)[^"'\\s]*/gi)]
      .map((m) => m[0])
      .slice(0, 20),
  };
}

async function main() {
  if (!hyperConfigured()) throw new Error("HYPER_API_KEY missing");
  if (!PROXY_RAW) throw new Error("PROXY missing");

  const dispatcher = makeDispatcher(PROXY_RAW, { forceUndici: true });
  const jar = createJar();
  const ctx = { jar, dispatcher };
  const findings = { locale: LOCALE, proxyHost: PROXY_RAW.split(":")[0] };

  try {
    const ip = await resolveEgressIp(ctx);
    findings.egressIp = ip;
    push("egress", { note: ip });

    let homeRes = await get(ctx, HOME, { "upgrade-insecure-requests": "1" });
    let homeHtml = await readText(homeRes);
    fs.writeFileSync(`${OUT}/home-0.html`, homeHtml.slice(0, 500_000));
    let sum = summarizeHtml(homeHtml, homeRes.status);
    push("home_0", sum);

    if (sum.incap || extractReeseScriptPath(homeHtml) || /vice-come-/i.test(homeHtml)) {
      const reese = await clearReese(ctx, HOME, homeHtml);
      push("reese", reese);
      homeRes = await get(ctx, HOME);
      homeHtml = await readText(homeRes);
      fs.writeFileSync(`${OUT}/home-1.html`, homeHtml.slice(0, 500_000));
      sum = summarizeHtml(homeHtml, homeRes.status);
      push("home_1", sum);
    }

    if (sum.ddBlock || sum.ddRt) {
      const dd = await clearDd(ctx, HOME, homeHtml);
      push("datadome", dd);
      findings.datadome = {
        kind: dd.kind || null,
        view: dd.view || null,
        isIpBanned: Boolean(dd.isIpBanned),
        note: dd.note || null,
        refs: dd.refs || (dd.ref ? [dd.ref] : null),
      };
      if (dd.isIpBanned) {
        // Hyper-documented hard block only — not a generic proxy condemnation.
        findings.blocker = dd.kind || "datadome_hard_block";
      } else if (!dd.ok) {
        findings.blocker = dd.kind || "datadome_impl_or_tls";
        homeRes = await get(ctx, HOME);
        homeHtml = await readText(homeRes);
        fs.writeFileSync(`${OUT}/home-2.html`, homeHtml.slice(0, 800_000));
        sum = summarizeHtml(homeHtml, homeRes.status);
        push("home_2", sum);
      } else {
        homeRes = await get(ctx, HOME);
        homeHtml = await readText(homeRes);
        fs.writeFileSync(`${OUT}/home-2.html`, homeHtml.slice(0, 800_000));
        sum = summarizeHtml(homeHtml, homeRes.status);
        push("home_2", sum);
      }
    }

    findings.home = sum;
    findings.cookies = Object.fromEntries(
      Object.entries(jar.dump()).map(([k, v]) => [k, { len: String(v).length, prefix: String(v).slice(0, 12) }]),
    );

    // PDP
    const pdpRes = await get(ctx, PDP, { referer: HOME });
    let pdpHtml = await readText(pdpRes);
    let pdpSum = summarizeHtml(pdpHtml, pdpRes.status);
    push("pdp_0", pdpSum);
    if (pdpSum.ddBlock || pdpSum.incap) {
      if (pdpSum.incap) push("pdp_reese", await clearReese(ctx, PDP, pdpHtml));
      if (pdpSum.ddBlock) push("pdp_dd", await clearDd(ctx, PDP, pdpHtml));
      const pdp2 = await get(ctx, PDP, { referer: HOME });
      pdpHtml = await readText(pdp2);
      pdpSum = summarizeHtml(pdpHtml, pdp2.status);
      push("pdp_1", pdpSum);
    }
    fs.writeFileSync(`${OUT}/pdp.html`, pdpHtml.slice(0, 1_200_000));
    findings.pdp = pdpSum;
    if (pdpSum.globaleMid) findings.globaleMid = pdpSum.globaleMid;
    if (pdpSum.gemHost) findings.gemHost = pdpSum.gemHost;

    // Cortex / cart soft probes
    const probes = {};
    for (const [name, path] of [
      ["robots", "/robots.txt"],
      ["cortex", "/cortex"],
      ["carts", "/carts"],
      ["extcarts", "/extcarts"],
      ["items", "/items"],
      ["minicarts", "/minicarts"],
      ["availabilities", "/availabilities"],
      ["intl", "/intl-checkout"],
      ["checkout", "/checkout"],
    ]) {
      try {
        const res = await get(ctx, `${ORIGIN}${path}`, {
          referer: HOME,
          accept: name === "robots" ? "text/plain,*/*" : "application/json,text/html,*/*",
        });
        const text = await readText(res);
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* ignore */
        }
        probes[name] = {
          status: res.status,
          bytes: text.length,
          json: Boolean(json),
          keys: json ? Object.keys(json).slice(0, 12) : null,
          ct: res.headers?.get?.("content-type") || null,
          snippet: text.slice(0, 120).replace(/\s+/g, " "),
          dd: looksLikeDataDomeBlock(text, res.status),
          incap: looksLikeIncapsulaChallenge(text, res.status),
        };
        if (json) fs.writeFileSync(`${OUT}/probe-${name}.json`, JSON.stringify(json, null, 2).slice(0, 200_000));
        else fs.writeFileSync(`${OUT}/probe-${name}.txt`, text.slice(0, 80_000));
        push(`probe_${name}`, probes[name]);
      } catch (e) {
        probes[name] = { error: e.message };
        push(`probe_${name}`, { note: e.message, ok: false });
      }
    }
    findings.probes = probes;

    // Extract JS bundle URLs from clear home for GE mid scrape
    if (findings.home?.bytes > 20000) {
      const bundles = [...homeHtml.matchAll(/src=["']([^"']+\.js[^"']*)["']/gi)].map((m) => m[1]).slice(0, 40);
      findings.scriptSrcs = bundles.slice(0, 20);
      for (const src of bundles) {
        if (!/main|app|checkout|globale|vendor|chunk/i.test(src)) continue;
        const url = src.startsWith("http") ? src : `${ORIGIN}${src.startsWith("/") ? "" : "/"}${src}`;
        try {
          const res = await get(ctx, url, { referer: HOME, accept: "*/*" });
          const js = await readText(res);
          const mid =
            (js.match(/globaleMid["']?\s*[:=]\s*["']?(\d{3,6})/i) ||
              js.match(/web\.global-e\.com\/merchant\/clientsdk\/(\d{3,6})/i) ||
              js.match(/gem-[a-z0-9-]+\.global-e\.com\/includes\/js\/(\d{3,6})/i) ||
              [])[1] || null;
          const gem = (js.match(/(gem-[a-z0-9-]+\.global-e\.com)/i) || [])[1];
          const secure = (js.match(/(secure-[a-z0-9-]+\.global-e\.com)/i) || [])[1];
          if (mid || gem) {
            findings.globaleMid = findings.globaleMid || mid;
            findings.gemHost = findings.gemHost || gem;
            findings.secureHost = findings.secureHost || secure;
            findings.globaleFrom = url;
            push("globale_js", { note: `mid=${mid} gem=${gem} from ${url.slice(0, 80)}` });
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }

    fs.writeFileSync(`${OUT}/steps.json`, JSON.stringify(steps, null, 2));
    fs.writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));
    console.log(
      JSON.stringify(
        {
          out: OUT,
          egress: findings.egressIp,
          homeBytes: findings.home?.bytes,
          homeClear: findings.home?.bytes > 20000 && !findings.home?.ddBlock && !findings.home?.incap,
          pdpBytes: findings.pdp?.bytes,
          globaleMid: findings.globaleMid || null,
          gemHost: findings.gemHost || null,
          probes: Object.fromEntries(
            Object.entries(probes).map(([k, v]) => [k, v.status || v.error]),
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    await dispatcher.close?.();
  }
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${OUT}/error.txt`, String(e?.stack || e));
  process.exit(1);
});
