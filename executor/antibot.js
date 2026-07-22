// Thin wrapper around hyper-sdk-js.
//
// Akamai (Kmart AU — primary):
//   solveAkamaiSensor / solveAkamaiPixel / solveAkamaiSbsd
//
// Incapsula + DataDome (shared plumbing for Pokémon Centre / AusPost / HN):
//   solveIncapsulaReese84 / solveIncapsulaUtmvc
//   solveDataDomeInterstitial / solveDataDomeSlider / solveDataDomeTags
//   parse helpers: looksLikeIncapsulaChallenge, extractReeseScriptPath,
//                  looksLikeDataDomeBlock, parseDataDomeObject
//
// The caller is responsible for POSTing payloads back to the retailer with
// matching TLS/UA/IP and ingesting response cookies. Hyper just mints bodies.

import {
  Session,
  SensorInput,
  generateSensorData,
  PixelInput,
  parsePixelHtmlVar,
  parsePixelScriptUrl,
  parsePixelScriptVar,
  generatePixelData,
  SbsdInput,
  generateSbsdPayload,
  Reese84Input,
  generateReese84Sensor,
  UtmvcInput,
  generateUtmvcCookie,
  getSessionIds,
  InterstitialInput,
  generateInterstitialPayload,
  parseInterstitialDeviceCheckUrl,
  SliderInput,
  generateSliderPayload,
  parseSliderDeviceCheckUrl,
  TagsInput,
  generateTagsPayload,
} from "hyper-sdk-js";
import { request } from "./http.js";

const API_KEY = process.env.HYPER_API_KEY ?? "";

let _session = null;
function session() {
  if (!API_KEY) {
    const err = new Error("antibot_misconfigured: HYPER_API_KEY missing");
    err.code = "antibot_misconfigured";
    throw err;
  }
  if (!_session) _session = new Session(API_KEY, undefined, undefined, undefined, { timeout: 20_000 });
  return _session;
}

export function hyperConfigured() {
  return Boolean(API_KEY);
}

export function hyperSensorInputShape() {
  const sample = new SensorInput(
    "abck",
    "bmsz",
    "3",
    "https://example.com/page",
    "ua",
    "127.0.0.1",
    "en-AU,en;q=0.9",
    "ctx",
    "script",
    "https://example.com/akamai.js",
  );
  return {
    sdk: "hyper-sdk-js",
    constructorOrder: ["abck", "bmsz", "version", "pageUrl", "userAgent", "ip", "acceptLanguage", "context", "script", "scriptUrl"],
    observedFields: {
      abck: sample.abck,
      bmsz: sample.bmsz,
      version: sample.version,
      pageUrl: sample.pageUrl,
      userAgent: sample.userAgent,
      ip: sample.ip,
      acceptLanguage: sample.acceptLanguage,
      context: sample.context,
      script: sample.script,
      scriptUrl: sample.scriptUrl,
    },
  };
}

// ─── Akamai sensor ───────────────────────────────────────────────────
// abck/bmsz cookies come from the jar; if they're absent (first sensor),
// pass empty strings — Hyper handles the seeding.
export async function solveAkamaiSensor({
  jar,
  pageUrl,
  userAgent,
  ip,
  acceptLanguage,
  scriptUrl,
  scriptBody,
  prevContext,
  version = "3",
}) {
  const abck = jar.get("_abck") ?? "";
  const bmsz = jar.get("bm_sz") ?? "";
  // Per Hyper docs: include `script` only on the first sensor; subsequent
  // sensors carry `context` instead. They're mutually exclusive.
  const ctx = prevContext ?? "";
  const scr = prevContext ? "" : scriptBody ?? "";
  const input = new SensorInput(
    abck,
    bmsz,
    version,
    pageUrl,
    userAgent,
    ip ?? "",
    acceptLanguage,
    ctx,
    scr,
    scriptUrl ?? "",
  );
  const { payload, context } = await generateSensorData(session(), input);
  return {
    payload,
    postUrl: scriptUrl, // sensor posts back to the same script URL the retailer served
    context,
  };
}

// ─── Akamai pixel ────────────────────────────────────────────────────
// Returns null when the page isn't carrying a pixel challenge (most PDPs
// don't). When present, we still need to fetch the script body to extract
// the dynamic var.
export async function solveAkamaiPixel({ jar, pageUrl, html, userAgent, ip, acceptLanguage, ctx }) {
  const htmlVar = parsePixelHtmlVar(html);
  const urls = parsePixelScriptUrl(html);
  if (htmlVar === null || !urls) return null;

  const scriptRes = await request(urls.scriptUrl, { method: "GET", headers: { referer: pageUrl } }, ctx);
  const scriptBody = await scriptRes.text();
  const scriptVar = parsePixelScriptVar(scriptBody);
  if (!scriptVar) return null;

  const payload = await generatePixelData(
    session(),
    new PixelInput(userAgent, String(htmlVar), scriptVar, ip ?? "", acceptLanguage),
  );
  return { payload, postUrl: urls.postUrl };
}

// ─── Akamai SBSD ─────────────────────────────────────────────────────
export async function solveAkamaiSbsd({
  jar,
  pageUrl,
  scriptBody,
  uuid,
  oCookie,
  index,
  userAgent,
  ip,
  acceptLanguage,
}) {
  return generateSbsdPayload(
    session(),
    new SbsdInput(index, uuid, oCookie ?? jar.get("sbsd_o") ?? "", pageUrl, userAgent, scriptBody, ip ?? "", acceptLanguage),
  );
}

// ─── Incapsula / Imperva ─────────────────────────────────────────────

/** True when HTML is an Incapsula iframe / interruption shell (HTTP 200 ≠ clear). */
export function looksLikeIncapsulaChallenge(html, status) {
  const h = String(html || "");
  if (!h) return false;
  if (/Pardon Our Interruption/i.test(h)) return true;
  if (/_Incapsula_Resource|incapsula incident|main-iframe/i.test(h)) return true;
  if (/distil_referrer|visid_incap_/i.test(h) && h.length < 8_000) return true;
  // Short 200/403 shells with the Reese script tag but no real app markup.
  if (
    (status === 200 || status === 403) &&
    h.length < 8_000 &&
    /<script[^>]+src=["']\/[^"']+["'][^>]*async/i.test(h) &&
    !/<div[^>]+id=["']root["']/i.test(h) &&
    !/<div[^>]+id=["']app["']/i.test(h)
  ) {
    return /Incapsula|incap_|ROBOTS.*NOINDEX/i.test(h);
  }
  return false;
}

/** Extract same-origin Reese84 script path from challenge HTML (`/obscure-path`). */
export function extractReeseScriptPath(html) {
  const h = String(html || "");
  const m =
    h.match(/<script[^>]+src=["'](\/[^"'?][^"']*)["'][^>]*(?:async|defer)/i) ||
    h.match(/<script[^>]+src=["'](\/[^"']+)["']/i);
  if (!m?.[1]) return null;
  const path = m[1];
  // Prefer non-Incapsula_Resource script tags (Reese lives on obscure paths).
  if (/_Incapsula_Resource/i.test(path)) return null;
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Mint Reese84 sensor payload (string). Caller POSTs to
 * `${origin}${scriptPath}?d=${hostname}` as text/plain, then sets `reese84`
 * cookie from JSON `{ token }`.
 */
export async function solveIncapsulaReese84({
  userAgent,
  ip,
  acceptLanguage,
  pageUrl,
  scriptBody,
  scriptUrl,
  pow = "",
}) {
  const payload = await generateReese84Sensor(
    session(),
    new Reese84Input(
      userAgent,
      ip ?? "",
      acceptLanguage || "en-AU,en;q=0.9",
      pageUrl,
      scriptBody ?? "",
      scriptUrl ?? "",
      pow || "",
    ),
  );
  return { payload };
}

/**
 * Mint `___utmvc` cookie from Incapsula UTMVC script + incap_ses_* values.
 * `sessionCookies` = array of `{name,value}` or a jar with `.dump()`.
 */
export async function solveIncapsulaUtmvc({ userAgent, scriptBody, sessionCookies }) {
  let cookies = sessionCookies;
  if (cookies && typeof cookies.dump === "function") {
    const dumped = cookies.dump() || {};
    cookies = Object.entries(dumped).map(([name, value]) => ({ name, value }));
  }
  if (!Array.isArray(cookies)) cookies = [];
  const sessionIds = getSessionIds(cookies);
  const { payload, swhanedl } = await generateUtmvcCookie(
    session(),
    new UtmvcInput(userAgent, scriptBody ?? "", sessionIds),
  );
  return { payload, swhanedl, sessionIds };
}

// ─── DataDome ────────────────────────────────────────────────────────

/** Parse inline `var dd={…}` object from a DataDome block page. */
export function parseDataDomeObject(html) {
  const h = String(html || "");
  const m = h.match(/var\s+dd\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i) || h.match(/var\s+dd\s*=\s*(\{[\s\S]*?\})/);
  if (!m?.[1]) return null;
  try {
    // DD object uses single-quoted JS literals — normalize lightly.
    const raw = m[1]
      .replace(/'/g, '"')
      .replace(/([,{]\s*)(\w+)\s*:/g, '$1"$2":');
    return JSON.parse(raw);
  } catch {
    // Fallback: extract key fields with regex.
    const get = (k) => {
      const mm = h.match(new RegExp(`['"]?${k}['"]?\\s*:\\s*['"]([^'"]*)['"]`, "i"));
      return mm?.[1] ?? null;
    };
    const getNum = (k) => {
      const mm = h.match(new RegExp(`['"]?${k}['"]?\\s*:\\s*(-?\\d+)`, "i"));
      return mm ? Number(mm[1]) : null;
    };
    return {
      rt: get("rt"),
      cid: get("cid"),
      hsh: get("hsh"),
      t: get("t"),
      s: getNum("s") ?? get("s"),
      e: get("e"),
      host: get("host"),
      cookie: get("cookie"),
      b: getNum("b") ?? get("b"),
    };
  }
}

export function looksLikeDataDomeBlock(html, status, headers) {
  const h = String(html || "");
  const hdr =
    headers?.get?.("x-datadome") ||
    headers?.["x-datadome"] ||
    headers?.get?.("X-DataDome") ||
    "";
  if (String(hdr).toLowerCase() === "protected") return true;
  if (/geo\.captcha-delivery\.com|ct\.captcha-delivery\.com|var\s+dd\s*=/i.test(h)) return true;
  if ((status === 403 || status === 401) && /datadome|captcha-delivery/i.test(h)) return true;
  return false;
}

/**
 * Solve DataDome interstitial (`rt` interstitial / i.js).
 * Returns `{ payload, headers, postUrl }` — POST payload to postUrl, ingest `datadome` cookie.
 */
export async function solveDataDomeInterstitial({
  html,
  datadomeCookie,
  referer,
  userAgent,
  ip,
  acceptLanguage,
  deviceLinkHtml,
}) {
  const deviceLink =
    parseInterstitialDeviceCheckUrl(html, datadomeCookie || "", referer || "") || null;
  if (!deviceLink) {
    const err = new Error("datadome_interstitial: deviceLink parse failed");
    err.code = "datadome_parse";
    throw err;
  }
  let deviceHtml = deviceLinkHtml;
  if (!deviceHtml) {
    // Caller should prefer fetching via their sticky proxy; this is a last resort.
    const res = await fetch(deviceLink, {
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml",
        referer: referer || "",
      },
    });
    deviceHtml = await res.text();
  }
  const { payload, headers } = await generateInterstitialPayload(
    session(),
    new InterstitialInput(
      userAgent,
      deviceLink,
      deviceHtml,
      ip ?? "",
      acceptLanguage || "en-AU,en;q=0.9",
    ),
  );
  return {
    payload,
    headers: headers || {},
    postUrl: "https://geo.captcha-delivery.com/interstitial/",
    deviceLink,
  };
}

/**
 * Solve DataDome slider captcha.
 * `puzzleB64` / `pieceB64` = base64 image bytes from `.jpg` / `.frag.png`.
 * Returns `{ payload, headers, isIpBanned }` — payload is a verification URL to GET.
 */
export async function solveDataDomeSlider({
  html,
  datadomeCookie,
  referer,
  parentUrl,
  userAgent,
  ip,
  acceptLanguage,
  deviceLinkHtml,
  puzzleB64,
  pieceB64,
}) {
  const parsed = parseSliderDeviceCheckUrl(html, datadomeCookie || "", referer || "");
  if (parsed?.isIpBanned) {
    return { isIpBanned: true, payload: null, headers: {}, deviceLink: null };
  }
  const deviceLink = parsed?.url || parsed?.deviceCheckUrl || null;
  if (!deviceLink) {
    const err = new Error("datadome_slider: deviceLink parse failed");
    err.code = "datadome_parse";
    throw err;
  }
  let deviceHtml = deviceLinkHtml;
  if (!deviceHtml) {
    const res = await fetch(deviceLink, {
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml",
        referer: referer || "",
      },
    });
    deviceHtml = await res.text();
  }
  if (!puzzleB64 || !pieceB64) {
    const err = new Error("datadome_slider: puzzle/piece base64 required");
    err.code = "datadome_slider_images";
    throw err;
  }
  const { payload, headers } = await generateSliderPayload(
    session(),
    new SliderInput(
      userAgent,
      deviceLink,
      deviceHtml,
      puzzleB64,
      pieceB64,
      parentUrl || referer || "",
      ip ?? "",
      acceptLanguage || "en-AU,en;q=0.9",
    ),
  );
  return {
    payload,
    headers: headers || {},
    isIpBanned: false,
    deviceLink,
  };
}

/** Background DataDome tags payload (`type` = 'ch' then 'le'). */
export async function solveDataDomeTags({
  userAgent,
  ddk,
  referer,
  type = "ch",
  ip,
  acceptLanguage,
  version,
  cid = "",
}) {
  const payload = await generateTagsPayload(
    session(),
    new TagsInput(
      userAgent,
      ddk,
      referer,
      type,
      ip ?? "",
      acceptLanguage || "en-AU,en;q=0.9",
      version || "5.1.6",
      cid || "",
    ),
  );
  return { payload };
}

export {
  parseInterstitialDeviceCheckUrl,
  parseSliderDeviceCheckUrl,
};
