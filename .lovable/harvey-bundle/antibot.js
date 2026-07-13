// Thin wrapper around hyper-sdk-js. Scope today: Akamai only (Kmart AU
// is the only whitelisted domain on our Hyper key).
//
// Surface:
//   solveAkamaiSensor({ jar, pageUrl, userAgent, ip, acceptLanguage,
//                       scriptUrl, scriptBody, prevContext })
//     → { payload, postUrl, context }
//
//   solveAkamaiPixel({ jar, pageUrl, html, userAgent, ip, acceptLanguage })
//     → { payload, postUrl } | null   (null when no pixel challenge present)
//
//   solveAkamaiSbsd({ jar, pageUrl, scriptBody, uuid, oCookie, index,
//                     userAgent, ip, acceptLanguage })
//     → string payload
//
// The caller is responsible for POSTing the payload back to postUrl with the
// retailer-shaped headers and ingesting the response cookies. Hyper just
// produces the body.

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
