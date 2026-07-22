#!/usr/bin/env node
// Grind sticky list: Hyper edge → auth → tags → ATC → cart/data → GE m2m → intl-checkout.
// Env: HYPER_API_KEY, PROXY_FILE=/tmp/pc-noontide-fresh.proxies (or PROXY=single)
// Secrets via env only. Rotate sticky only on Hyper t=bv hard-block.

import fs from "node:fs";
import { createJar, makeDispatcher, makeRemoteTlsDispatcher, UA } from "../http.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { hyperConfigured, looksLikeDataDomeBlock } from "../antibot.js";
import { createPcSession } from "../adapters/pokemoncentre-session.js";
import {
  warmPokemonCentre,
  clearIncapsulaReese,
  postDataDomeTags,
  solveDatadomeCaptchaUrl,
} from "../adapters/pokemoncentre-edge.js";
import {
  PC_API_BASE,
  PC_CORTEX_SCOPE,
  getPublicToken,
  attemptGuestAtc,
  getGlobaleM2mToken,
  cortexApiHeaders,
  cartGuidFromCartData,
  cortexCartIdFromAtc,
  parseNextData,
  productFromNextData,
  cartFromNextData,
  parsePdpAvailability,
} from "../adapters/pokemoncentre-cortex.js";

const OUT = process.env.PC_CAPTURE_DIR || `/tmp/pc-grind-${Date.now()}`;
const ORIGIN = "https://www.pokemoncenter.com";
const HOME = `${ORIGIN}/en-au/`;
const PDP =
  process.env.PC_PDP ||
  `${ORIGIN}/en-au/product/10-10320-101/pokemon-tcg-mewtwo-and-mew-dna-premium-zip-binder`;
const MAX = Number(process.env.PC_GRIND_MAX || 16);
const SKU = process.env.PC_SKU || "10-10320-101";
const TRANSPORT = String(process.env.TRANSPORT || "undici").toLowerCase();

fs.mkdirSync(OUT, { recursive: true });

function loadProxies() {
  if (process.env.PROXY) return [process.env.PROXY.trim()];
  const file = process.env.PROXY_FILE || "/tmp/pc-noontide-fresh.proxies";
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function stageRank(stage) {
  return [
    "start",
    "error",
    "slider_hard_block",
    "edge",
    "auth",
    "pdp",
    "atc_hard_block",
    "atc",
    "cart",
    "ge_m2m_fail",
    "ge_m2m",
    "intl_thin",
    "intl_checkout",
  ].indexOf(stage);
}

async function runOne(proxyRaw, idx) {
  const dir = `${OUT}/try-${idx}`;
  fs.mkdirSync(dir, { recursive: true });
  const dispatcher =
    TRANSPORT === "tls-worker"
      ? await makeRemoteTlsDispatcher(proxyRaw)
      : makeDispatcher(proxyRaw, { forceUndici: true });
  const jar = createJar();
  const ctx = { jar, dispatcher };
  const session = createPcSession(ctx, { locale: "en-au", userAgent: UA });
  const summary = {
    idx,
    proxyHost: proxyRaw.split(":")[0],
    transport: TRANSPORT,
    ok: false,
    stage: "start",
  };

  try {
    let ip = "";
    try {
      ip = (await resolveEgressIp(ctx)) || "";
    } catch {
      ip = "";
    }
    summary.egress = ip;

    const edge = await warmPokemonCentre(session, ctx);
    summary.edge = edge.note || (edge.ok ? "clear" : "fail");
    if (edge.datadome?.isIpBanned || edge.isIpBanned) {
      summary.stage = "slider_hard_block";
      summary.note = edge.note;
      return summary;
    }
    if (!edge.ok) {
      summary.stage = "edge";
      summary.note = edge.note;
      return summary;
    }

    // Fresh Reese immediately before BFF auth (Incapsula incidentId fix)
    const reese = await clearIncapsulaReese(session, ctx, {
      pageUrl: HOME,
      html: edge.home?.html || "",
    });
    summary.reesePreAuth = Boolean(reese.hasToken);

    const auth = await getPublicToken(session, ctx, { locale: "en-au", scope: PC_CORTEX_SCOPE });
    if (!auth.ok) {
      summary.stage = "auth";
      summary.note = auth.note;
      summary.incapBlock = auth.incapBlock;
      return summary;
    }
    summary.stage = "auth";
    summary.authRole = auth.auth?.role;

    try {
      const tags = await postDataDomeTags(session, ctx, { pageUrl: HOME });
      summary.tags = tags.ok ? true : tags.note?.slice(0, 100);
    } catch (e) {
      summary.tags = (e.message || String(e)).slice(0, 100);
    }

    const pdpRes = await session.get(PDP, { headers: { referer: HOME } });
    const pdpHtml = await session.readText(pdpRes);
    fs.writeFileSync(`${dir}/pdp.html`, pdpHtml.slice(0, 900_000));
    if (looksLikeDataDomeBlock(pdpHtml, pdpRes.status)) {
      summary.stage = "pdp";
      summary.note = "pdp datadome block after edge clear";
      return summary;
    }
    const avail = parsePdpAvailability(pdpHtml);
    const product = avail.product || productFromNextData(parseNextData(pdpHtml));
    const epId = product?.epItemId;
    summary.product = {
      code: product?.code,
      availability: product?.availability,
      epId,
    };
    if (!epId) {
      summary.stage = "pdp";
      summary.note = "no ep item id";
      return summary;
    }

    let atc = await attemptGuestAtc(session, {
      sku: SKU,
      qty: 1,
      task: {},
      product,
      pageUrl: PDP,
    });
    fs.writeFileSync(`${dir}/atc.json`, JSON.stringify(atc.json || { note: atc.note }, null, 2).slice(0, 200_000));

    if (atc.datadomeChallenge && atc.captchaUrl) {
      const captchaHasBv = /[?&]t=bv\b/i.test(atc.captchaUrl);
      summary.atcCaptchaT = (atc.captchaUrl.match(/[?&]t=([^&]+)/i) || [])[1] || null;
      if (captchaHasBv) {
        summary.stage = "atc_hard_block";
        summary.atcStatus = atc.status;
        summary.note = "ATC captcha t=bv — Hyper hard-block; rotate sticky";
        return summary;
      }
      // Non-bv captcha → solve slider on captcha URL, tags again, retry ATC
      const solved = await solveDatadomeCaptchaUrl(session, ctx, atc.captchaUrl, { pageUrl: PDP });
      summary.atcCaptchaSolve = solved.note;
      if (solved.hardBlock || solved.isIpBanned) {
        summary.stage = "atc_hard_block";
        summary.atcStatus = atc.status;
        summary.note = solved.note;
        return summary;
      }
      if (solved.ok) {
        await postDataDomeTags(session, ctx, { pageUrl: PDP }).catch(() => null);
        atc = await attemptGuestAtc(session, {
          sku: SKU,
          qty: 1,
          task: {},
          product,
          pageUrl: PDP,
        });
        fs.writeFileSync(
          `${dir}/atc-retry.json`,
          JSON.stringify(atc.json || { note: atc.note }, null, 2).slice(0, 200_000),
        );
      }
    }

    summary.atcStatus = atc.status;
    if (!atc.ok) {
      summary.stage = atc.datadomeChallenge ? "atc" : "atc";
      summary.note = atc.note;
      return summary;
    }
    summary.stage = "atc";
    summary.lineItem = atc.json?.self?.type || true;
    summary.cortexCartId = cortexCartIdFromAtc(atc.json);
    summary.cartUri = atc.cartUri;

    const token = session.state.cortexAuth?.accessToken;
    const apiH = cortexApiHeaders({
      accessToken: token,
      locale: "en-au",
      scope: PC_CORTEX_SCOPE,
      referer: HOME,
      userAgent: UA,
    });
    const cartRes = await session.get(`${PC_API_BASE}/cart/data?type=full`, {
      api: true,
      headers: apiH,
    });
    const cartText = await session.readText(cartRes);
    fs.writeFileSync(`${dir}/cart-full.json`, cartText.slice(0, 400_000));
    let cartJson = null;
    try {
      cartJson = JSON.parse(cartText);
    } catch {
      /* ignore */
    }
    // BFF may return captcha JSON
    if (cartJson?.url && /captcha-delivery/i.test(cartJson.url)) {
      summary.stage = "cart";
      summary.cartDataStatus = cartRes.status;
      summary.note = "cart/data captcha " + (/[?&]t=bv\b/i.test(cartJson.url) ? "t=bv" : "solve?");
      if (/[?&]t=bv\b/i.test(cartJson.url)) {
        summary.stage = "atc_hard_block";
        summary.ok = true; // ATC already won
        return summary;
      }
      const solved = await solveDatadomeCaptchaUrl(session, ctx, cartJson.url, { pageUrl: HOME });
      if (solved.ok) {
        const cartRes2 = await session.get(`${PC_API_BASE}/cart/data?type=full`, {
          api: true,
          headers: apiH,
        });
        const cartText2 = await session.readText(cartRes2);
        fs.writeFileSync(`${dir}/cart-full-retry.json`, cartText2.slice(0, 400_000));
        try {
          cartJson = JSON.parse(cartText2);
        } catch {
          cartJson = null;
        }
        summary.cartDataStatus = cartRes2.status;
      } else {
        summary.ok = true;
        return summary;
      }
    } else {
      summary.cartDataStatus = cartRes.status;
    }

    let cartGuid = cartGuidFromCartData(cartJson);
    summary.cartGuid = cartGuid;
    summary.cartQty =
      cartJson?.quantity ?? cartJson?.["total-quantity"] ?? cartJson?.cart?.quantity ?? null;
    summary.cartTotal = cartJson?.total || cartJson?.cart?.total || null;
    summary.cartKeys = cartJson && !cartJson.url ? Object.keys(cartJson).slice(0, 16) : null;

    if (!cartGuid) {
      const home2 = await session.get(HOME, { headers: { referer: HOME } });
      const homeHtml = await session.readText(home2);
      const c2 = cartFromNextData(parseNextData(homeHtml));
      cartGuid = c2?.cartGuid || null;
      summary.cartGuid = cartGuid;
      summary.cartFromNext = Boolean(c2?.cartGuid);
      summary.cartQty = c2?.quantity ?? summary.cartQty;
    }

    if (!cartGuid) {
      summary.stage = "cart";
      summary.note = `ATC ok but no cartGuid keys=${summary.cartKeys || []}`;
      summary.ok = true;
      return summary;
    }
    summary.stage = "cart";

    const ge = await getGlobaleM2mToken(session, { cartGuid });
    fs.writeFileSync(`${dir}/ge-m2m.json`, JSON.stringify(ge.json || { note: ge.note }, null, 2));
    summary.geM2mStatus = ge.status;
    summary.geM2mKeys = ge.json ? Object.keys(ge.json) : null;
    summary.stage = ge.ok ? "ge_m2m" : "ge_m2m_fail";

    let intl = await session.get(`${ORIGIN}/en-au/intl-checkout`, {
      headers: { referer: HOME, accept: "text/html,application/xhtml+xml" },
    });
    let intlHtml = await session.readText(intl);
    if (intl.status >= 300 && intl.status < 400) {
      const loc = intl.headers?.get?.("location");
      if (loc) {
        const abs = loc.startsWith("http") ? loc : `${ORIGIN}${loc}`;
        intl = await session.get(abs, { headers: { referer: HOME } });
        intlHtml = await session.readText(intl);
        summary.intlRedirect = abs.slice(0, 160);
      }
    }
    fs.writeFileSync(`${dir}/intl-checkout.html`, intlHtml.slice(0, 1_200_000));
    const mid =
      (intlHtml.match(/globaleMid["']?\s*[:=]\s*["']?(\d{3,6})/i) ||
        intlHtml.match(/merchant\/clientsdk\/(\d{3,6})/i) ||
        intlHtml.match(/[?&](?:merchantId|MerchantId)=(\d{3,6})/i) ||
        [])[1] || null;
    const gem = (intlHtml.match(/(gem-[a-z0-9-]+\.global-e\.com)/i) || [])[1] || null;
    const secure = (intlHtml.match(/(secure-[a-z0-9-]+\.global-e\.com)/i) || [])[1] || null;
    const checkoutV2 = (intlHtml.match(/(https?:\/\/[^"'\\s]*Checkout\/v2[^"'\\s]*)/i) || [])[1];
    const geToken = (intlHtml.match(/MerchantCartToken=([^&"'\\s]+)/i) || [])[1] || null;
    summary.intl = {
      status: intl.status,
      bytes: intlHtml.length,
      mid,
      gem,
      secure,
      checkoutV2: checkoutV2 ? checkoutV2.slice(0, 160) : null,
      geTokenPrefix: geToken ? geToken.slice(0, 24) : null,
      title: (intlHtml.match(/<title>([^<]+)/i) || [])[1] || null,
      ddBlock: looksLikeDataDomeBlock(intlHtml, intl.status),
    };
    summary.stage = mid || gem || intlHtml.length > 5000 ? "intl_checkout" : "intl_thin";
    summary.ok = true;
    summary.note = `ATC+cartGuid + ge=${ge.status} intl=${intl.status} mid=${mid || "?"} gem=${gem || "?"}`;
    return summary;
  } catch (e) {
    summary.note = e.message || String(e);
    summary.stage = "error";
    fs.writeFileSync(`${dir}/error.txt`, String(e?.stack || e));
    return summary;
  } finally {
    await dispatcher.close?.();
    fs.writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 2));
  }
}

async function main() {
  if (!hyperConfigured()) throw new Error("HYPER_API_KEY missing");
  // Mix: fresh Noontide stickies + a few static ISP lines when PROXY_FILE not set
  let proxies = loadProxies();
  if (!process.env.PROXY && !process.env.PROXY_FILE) {
    const isp = fs
      .readFileSync(new URL("../resi.proxies", import.meta.url), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    proxies = [...proxies.slice(0, 12), ...isp.slice(0, 4)];
  }
  proxies = proxies.slice(0, MAX);
  console.log(`[grind] ${proxies.length} stickies → ${OUT}`);
  const results = [];
  let best = null;
  for (let i = 0; i < proxies.length; i++) {
    console.log(`\n[grind] === try ${i + 1}/${proxies.length} ${proxies[i].split(":")[0]} ===`);
    const s = await runOne(proxies[i], i + 1);
    results.push(s);
    console.log(
      JSON.stringify({
        idx: s.idx,
        stage: s.stage,
        ok: s.ok,
        egress: s.egress,
        tags: s.tags,
        atc: s.atcStatus,
        captchaT: s.atcCaptchaT,
        cartGuid: Boolean(s.cartGuid),
        ge: s.geM2mStatus,
        mid: s.intl?.mid,
        gem: s.intl?.gem,
        note: s.note,
      }),
    );
    if (!best || stageRank(s.stage) > stageRank(best.stage)) best = s;
    if (s.intl?.mid || s.intl?.gem || (s.cartGuid && s.geM2mStatus === 200)) {
      console.log("[grind] milestone reached — stopping early");
      break;
    }
  }
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ best, results }, null, 2));
  console.log("\n[grind] BEST", JSON.stringify(best, null, 2));
  console.log(JSON.stringify({ out: OUT, bestStage: best?.stage, bestNote: best?.note }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
