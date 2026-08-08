// Pokémon Centre edge clear: Imperva Reese84 → DataDome interstitial/slider.
// HTTP-first. Prefer sticky AU residential/ISP for session affinity — but do not
// treat every 403 / CONNECT flake / view=captcha as “proxy dead”. Classify with
// Hyper DataDome + header-order + TLS docs (see docs/POKEMON_CENTRE_MODULE.md §3.4).
// hCaptcha (CapSolver) is separate — see pokemoncentre-hcaptcha.js.

import {
  hyperConfigured,
  looksLikeIncapsulaChallenge,
  extractReeseScriptPath,
  solveIncapsulaReese84,
  looksLikeDataDomeBlock,
  parseDataDomeObject,
  solveDataDomeInterstitial,
  solveDataDomeSlider,
  solveDataDomeTags,
  parseSliderDeviceCheckUrl,
  parseInterstitialDeviceCheckUrl,
} from "../antibot.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { PC_ORIGIN } from "./pokemoncentre-session.js";

/** Confirmed 2026-07-22 ISP HAR (45.42.47.34) — static per site until Imperva rotates. */
export const PC_REESE_SCRIPT_PATH = "/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C";
/** Incapsula account/site id from visid_incap_* / incap_ses_* cookie names. */
export const PC_INCAP_SITE_ID = "2682446";
/** DataDome hsh / ddjskey observed on AU (tags + block pages). */
export const PC_DATADOME_HSH = "5B45875B653A484CC79E57036CE9FC";
/** First-party tags endpoint from home inline ddoptions. */
export const PC_DATADOME_TAGS_URL = "https://dd.pokemoncenter.com/js/";

function bufferToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

async function readArrayBuffer(res) {
  if (typeof res.arrayBuffer === "function") {
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }
  // undici wrap in http.js exposes text() only — binary via base64 roundtrip is lossy for
  // puzzle images; prefer fetching image URLs with plain fetch (Hyper docs: image GETs
  // need not share the TLS client).
  const t = await res.text();
  return Buffer.from(t, "binary");
}

/** Parse `datadome=VALUE; Max-Age=…` from Hyper/DataDome JSON cookie field. */
export function parseDatadomeSetCookie(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(/^(?:datadome=)?([^;]+)/i);
  return m?.[1] || null;
}

/**
 * Apply interstitial/slider JSON result to jar.
 * Hyper success shapes:
 *   interstitial → { cookie, view:"redirect", url }
 *   slider check → { cookie }
 * @see https://docs.hypersolutions.co/datadome/getting-started.md
 */
export function applyDatadomeSolveJson(jar, json) {
  const value = parseDatadomeSetCookie(json?.cookie);
  if (value && jar?.set) jar.set("datadome", value);
  return {
    cookie: value,
    view: json?.view || null,
    url: json?.url || null,
    // Interstitial solved only when view === redirect (Hyper docs).
    ok: Boolean(value) && (json?.view == null || json.view === "redirect"),
  };
}

/**
 * Clear Incapsula Reese84 on a challenge HTML response.
 */
export async function clearIncapsulaReese(session, ctx, { pageUrl, html } = {}) {
  if (!hyperConfigured()) {
    return { ok: false, note: "HYPER_API_KEY missing — cannot solve Incapsula Reese84" };
  }
  const scriptPath = extractReeseScriptPath(html) || PC_REESE_SCRIPT_PATH;
  if (!scriptPath) {
    return { ok: false, note: "reese script path not found in challenge HTML" };
  }
  const scriptUrl = `${PC_ORIGIN}${scriptPath}`;
  const scriptRes = await session.get(scriptUrl, {
    headers: {
      referer: pageUrl,
      accept: "*/*",
      "sec-fetch-dest": "script",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "same-origin",
    },
  });
  const scriptBody = await session.readText(scriptRes);
  if (!scriptBody || scriptBody.length < 1000) {
    return {
      ok: false,
      status: scriptRes.status,
      note: `reese script fetch failed (${scriptRes.status}, ${scriptBody?.length || 0}b)`,
    };
  }

  let ip = "";
  try {
    ip = (await resolveEgressIp(ctx)) || "";
  } catch {
    ip = "";
  }

  const { payload } = await solveIncapsulaReese84({
    userAgent: session.state.userAgent,
    ip,
    acceptLanguage: session.state.acceptLanguage,
    pageUrl,
    scriptBody,
    scriptUrl,
  });

  const hostname = new URL(PC_ORIGIN).hostname;
  const postUrl = `${scriptUrl}${scriptUrl.includes("?") ? "&" : "?"}d=${hostname}`;
  const postRes = await session.post(postUrl, {
    body: payload,
    headers: {
      referer: pageUrl,
      "content-type": "text/plain; charset=utf-8",
      accept: "application/json, text/plain, */*",
      origin: PC_ORIGIN,
    },
  });
  const postText = await session.readText(postRes);
  let token = null;
  try {
    const j = JSON.parse(postText);
    token = j?.token || null;
  } catch {
    /* ignore */
  }
  if (token) {
    ctx.jar?.set?.("reese84", token);
    session.state.reeseCleared = true;
  }
  return {
    ok: Boolean(token) || postRes.status === 200 || postRes.status === 201,
    status: postRes.status,
    note: token
      ? `reese84 minted (${String(token).slice(0, 24)}…)`
      : `reese POST ${postRes.status} body=${postText.slice(0, 80)}`,
    scriptPath,
    hasToken: Boolean(token),
  };
}

async function fetchDeviceHtml(session, deviceLink, referer) {
  const res = await session.get(deviceLink, {
    headers: {
      referer: referer || `${PC_ORIGIN}/`,
      accept: "text/html,application/xhtml+xml",
    },
  });
  return session.readText(res);
}

/**
 * Pull DataDome slider puzzle (.jpg) + piece (.frag.png) URLs from device HTML.
 * Hyper docs: prefer `captchaChallengePath: '…jpg'`, then derive piece by
 * replacing `.jpg` → `.frag.png` (piece often is NOT present as a separate URL).
 * @see https://docs.hypersolutions.co/datadome/slider-captcha.md
 */
export function extractDdSliderImages(html) {
  const raw = String(html || "");
  const unescaped = raw
    .replace(/\\u002f/gi, "/")
    .replace(/\\x2f/gi, "/")
    .replace(/\\\//g, "/");

  // Official Hyper parse path
  const fromKey =
    (unescaped.match(/captchaChallengePath\s*[=:]\s*['"]([^'"]+\.jpe?g(?:\?[^'"]*)?)['"]/i) ||
      [])[1] ||
    (unescaped.match(/["']captchaChallengePath["']\s*[=:]\s*['"]([^'"]+\.jpe?g(?:\?[^'"]*)?)['"]/i) ||
      [])[1] ||
    null;

  let puzzle =
    fromKey ||
    (unescaped.match(
      /https:\/\/dd\.prod\.captcha-delivery\.com\/image\/[A-Za-z0-9._/-]+\.jpe?g(?:\?[^\s"'\\]*)?/i,
    ) || [])[0] ||
    (unescaped.match(
      /https:\/\/[^"'\\\s>]*captcha-delivery\.com\/image\/[A-Za-z0-9._/-]+\.jpe?g(?:\?[^\s"'\\]*)?/i,
    ) || [])[0] ||
    (unescaped.match(/\/image\/\d{4}-\d{2}-\d{2}\/[a-f0-9]+\.jpe?g/i) || [])[0] ||
    null;

  if (puzzle && puzzle.startsWith("/")) {
    puzzle = `https://dd.prod.captcha-delivery.com${puzzle}`;
  }
  if (puzzle) {
    // Strip trailing punctuation accidentally captured from JSON/JS
    puzzle = puzzle.replace(/[,;]+$/, "");
  }

  // Hyper: piece URL = puzzle with .jpg → .frag.png (do not require piece in HTML).
  let piece = null;
  if (puzzle) {
    piece = puzzle.replace(/\.jpe?g(\?[^#]*)?$/i, ".frag.png$1");
  } else {
    piece =
      (unescaped.match(
        /https:\/\/[^"'\\\s>]*captcha-delivery\.com\/image\/[A-Za-z0-9._/-]+\.frag\.png(?:\?[^\s"'\\]*)?/i,
      ) || [])[0] || null;
  }

  const needsHcaptcha = /hcaptcha\.com|h-captcha|data-sitekey/i.test(unescaped);
  const hasCaptchaHost = /captcha-delivery\.com/i.test(unescaped);
  const looksLikeStorefront =
    /pokemoncenter\.com/i.test(unescaped) && /<html/i.test(unescaped) && !/captchaChallengePath/i.test(unescaped);

  return {
    puzzleUrl: puzzle,
    pieceUrl: piece,
    needsHcaptcha,
    bytes: raw.length,
    fromChallengePath: Boolean(fromKey),
    hasCaptchaHost,
    looksLikeStorefront,
  };
}

/**
 * Clear DataDome block page (interstitial or slider).
 *
 * Hyper DataDome getting-started:
 * - Interstitial: rt=i + i.js → deviceLink → POST geo…/interstitial/ →
 *   success JSON is { cookie, view:"redirect", url }. Anything else (e.g. view:"captcha")
 *   is not a solved interstitial — usually header-order / TLS mismatch, not “dead proxy”.
 * - Slider: rt=c + c.js → if t=bv, Hyper documents a hard IP block (solving has no effect).
 * - Always parse `datadome=VALUE` out of the JSON cookie field (not the whole Set-Cookie).
 *
 * @see https://docs.hypersolutions.co/datadome/getting-started.md
 * @see https://docs.hypersolutions.co/request-based-basics/header-order.md
 */
export async function clearDataDome(session, ctx, { pageUrl, html, headers, light = false } = {}) {
  if (!hyperConfigured()) {
    return { ok: false, note: "HYPER_API_KEY missing — cannot solve DataDome" };
  }
  const dd = parseDataDomeObject(html) || {};
  const datadomeCookie = ctx.jar?.get?.("datadome") || dd.cookie || "";
  const htmlStr = String(html || "");
  const isInterstitial =
    dd.rt === "i" || /ct\.captcha-delivery\.com\/i\.js/i.test(htmlStr);
  const isSlider = dd.rt === "c" || /ct\.captcha-delivery\.com\/c\.js/i.test(htmlStr);

  // Hyper: t=bv is meaningful on slider block pages. Do not treat interstitial rt=i as ban.
  const sliderProbe = isSlider
    ? parseSliderDeviceCheckUrl(html, datadomeCookie, pageUrl || "")
    : null;
  if (isSlider && (sliderProbe?.isIpBanned || dd.t === "bv")) {
    return {
      ok: false,
      isIpBanned: true,
      kind: "slider_hard_block",
      note: "DataDome slider t=bv — Hyper docs: hard IP block; rotate sticky session (solving has no effect)",
      ref: "https://docs.hypersolutions.co/datadome/getting-started.md#slider",
      dd,
    };
  }
  if (isSlider && light) {
    return {
      ok: false,
      kind: "slider_light_skip",
      note: "DataDome slider — rotate sticky (monitor light; skip slow Hyper slider)",
      dd,
    };
  }

  let ip = "";
  try {
    ip = (await resolveEgressIp(ctx)) || "";
  } catch {
    ip = "";
  }

  if (isInterstitial) {
    const deviceLink = parseInterstitialDeviceCheckUrl(html, datadomeCookie, pageUrl || "");
    if (!deviceLink) {
      return { ok: false, kind: "interstitial", note: "DataDome interstitial deviceLink missing", dd };
    }
    const deviceHtml = await fetchDeviceHtml(session, deviceLink, pageUrl);
    const solved = await solveDataDomeInterstitial({
      html,
      datadomeCookie,
      referer: pageUrl,
      userAgent: session.state.userAgent,
      ip,
      acceptLanguage: session.state.acceptLanguage,
      deviceLinkHtml: deviceHtml,
    });
    // Hyper returns sec-ch-* headers that must be used on the POST (never hardcode).
    const postRes = await session.post(solved.postUrl, {
      body: solved.payload,
      headers: {
        referer: pageUrl,
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://geo.captcha-delivery.com",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        ...(solved.headers || {}),
      },
    });
    ctx.jar?.ingest?.(postRes.headers);
    const postText = await session.readText(postRes);
    let json = null;
    try {
      json = JSON.parse(postText);
    } catch {
      return {
        ok: false,
        kind: "interstitial",
        status: postRes.status,
        note: `interstitial POST non-JSON ${postRes.status}`,
        dd,
      };
    }
    const applied = applyDatadomeSolveJson(ctx.jar, json);
    if (json.view === "redirect" && applied.cookie) {
      session.state.datadomeCleared = true;
      return {
        ok: true,
        status: postRes.status,
        kind: "interstitial",
        view: "redirect",
        redirectUrl: applied.url,
        note: "datadome interstitial view=redirect (Hyper success)",
        dd,
      };
    }
    if (json.view === "captcha") {
      const captchaUrl = json.url || null;
      // Escalation: interstitial → captcha. t=bv on that URL = Hyper hard-block signal for
      // *this sticky* — rotate. Often undici TLS fingerprint (Bandai Akamai can still work).
      if (captchaUrl && /[?&]t=bv\b/i.test(captchaUrl)) {
        return {
          ok: false,
          isIpBanned: true,
          kind: "interstitial_escalated_hard_block",
          view: json.view,
          captchaUrl,
          status: postRes.status,
          note:
            "pc_edge_tbv: interstitial→captcha t=bv — rotate sticky (DataDome; Bandai-ok ≠ PKC). Solving has no effect on t=bv.",
          refs: [
            "https://docs.hypersolutions.co/datadome/getting-started.md#slider",
            "https://docs.hypersolutions.co/request-based-basics/tls-fingerprinting.md",
          ],
          dd,
        };
      }
      // Escalation without t=bv: slider solve (slow). Monitor light mode rotates instead.
      if (captchaUrl && /captcha-delivery\.com\/captcha/i.test(captchaUrl)) {
        if (light) {
          return {
            ok: false,
            kind: "interstitial_escalated_light",
            view: json.view,
            captchaUrl,
            status: postRes.status,
            note: "interstitial→captcha — rotate sticky (monitor light; skip slider)",
            dd,
          };
        }
        try {
          const escalated = await solveDatadomeCaptchaUrl(session, ctx, captchaUrl, {
            pageUrl,
          });
          if (escalated.ok) {
            if (session?.state) session.state.datadomeCleared = true;
            return {
              ok: true,
              kind: "interstitial_captcha",
              view: "captcha",
              captchaUrl,
              note: escalated.note || "interstitial→captcha slider solved",
              dd,
            };
          }
          return {
            ok: false,
            kind: "interstitial_escalated",
            view: json.view,
            captchaUrl,
            status: postRes.status,
            needsHcaptcha: Boolean(escalated.needsHcaptcha),
            isIpBanned: Boolean(escalated.isIpBanned),
            note: escalated.isIpBanned
              ? `pc_edge_tbv: ${escalated.note || "captcha t=bv — rotate sticky"}`
              : escalated.note ||
                "interstitial→captcha solve failed — rotate AU ISP sticky / check Hyper TLS",
            dd,
          };
        } catch (e) {
          return {
            ok: false,
            kind: "interstitial_escalated",
            view: json.view,
            captchaUrl,
            status: postRes.status,
            note: e?.message || "interstitial→captcha threw",
            dd,
          };
        }
      }
      return {
        ok: false,
        kind: "interstitial_escalated",
        view: json.view,
        captchaUrl,
        status: postRes.status,
        note: "interstitial view=captcha (no URL) — Hyper TLS/header-order; rotate sticky",
        refs: [
          "https://docs.hypersolutions.co/datadome/getting-started.md#posting-payload-solving-challenge",
          "https://docs.hypersolutions.co/request-based-basics/header-order.md",
        ],
        dd,
      };
    }
    return {
      ok: false,
      kind: "interstitial",
      view: json.view || null,
      status: postRes.status,
      note: `interstitial unexpected view=${json.view || "?"} cookie=${Boolean(applied.cookie)}`,
      dd,
    };
  }

  // Slider / captcha (rt:'c' + c.js)
  const deviceLink = sliderProbe?.url;
  if (!deviceLink) {
    return { ok: false, kind: "slider", note: "DataDome slider deviceLink missing", dd };
  }
  const deviceHtml = await fetchDeviceHtml(session, deviceLink, pageUrl);
  const imgs = extractDdSliderImages(deviceHtml);
  const { puzzleUrl, pieceUrl } = imgs;
  if (!puzzleUrl || !pieceUrl) {
    let note = `DataDome slider captchaChallengePath missing (${imgs.bytes}b device HTML)`;
    if (imgs.needsHcaptcha) {
      note =
        "DataDome escalated to hCaptcha (no slider images) — rotate AU ISP sticky; CapSolver is for checkout Imperva, not this monitor warm";
    } else if (imgs.looksLikeStorefront) {
      note =
        "DataDome deviceLink returned storefront HTML (not captcha) — sticky TLS/fingerprint mismatch; rotate AU ISP";
    } else if (!imgs.hasCaptchaHost) {
      note = `${note} — no captcha-delivery host in body; rotate sticky / check Hyper TLS`;
    } else {
      note = `${note} — rotate sticky / check Hyper TLS`;
    }
    return {
      ok: false,
      kind: "slider",
      note,
      needsHcaptcha: imgs.needsHcaptcha,
      dd,
    };
  }
  // Hyper: image GETs need not use the TLS client.
  const [puzzleB64, pieceB64] = await Promise.all([
    fetch(puzzleUrl).then(async (r) => bufferToB64(Buffer.from(await r.arrayBuffer()))),
    fetch(pieceUrl).then(async (r) => bufferToB64(Buffer.from(await r.arrayBuffer()))),
  ]);

  const solved = await solveDataDomeSlider({
    html,
    datadomeCookie: ctx.jar?.get?.("datadome") || datadomeCookie,
    referer: pageUrl,
    parentUrl: pageUrl,
    userAgent: session.state.userAgent,
    ip,
    acceptLanguage: session.state.acceptLanguage,
    deviceLinkHtml: deviceHtml,
    puzzleB64,
    pieceB64,
  });
  if (solved.isIpBanned) {
    return {
      ok: false,
      isIpBanned: true,
      kind: "slider_hard_block",
      note: "DataDome slider t=bv — Hyper docs: hard IP block",
      ref: "https://docs.hypersolutions.co/datadome/getting-started.md#slider",
      dd,
    };
  }
  // Slider payload is a captcha/check URL — GET it, parse JSON cookie.
  const verifyRes = await session.get(solved.payload, {
    headers: {
      referer: pageUrl,
      ...(solved.headers || {}),
    },
  });
  ctx.jar?.ingest?.(verifyRes.headers);
  const verifyText = await session.readText(verifyRes);
  let verifyJson = null;
  try {
    verifyJson = JSON.parse(verifyText);
  } catch {
    /* ignore */
  }
  const applied = applyDatadomeSolveJson(ctx.jar, verifyJson || {});
  session.state.datadomeCleared = Boolean(applied.cookie);
  return {
    ok: Boolean(applied.cookie),
    status: verifyRes.status,
    kind: "slider",
    note: applied.cookie
      ? "datadome slider cookie set (Hyper captcha/check)"
      : `slider verify ${verifyRes.status} body=${verifyText.slice(0, 80)}`,
    dd,
  };
}

/**
 * Solve a DataDome captcha URL returned as JSON from a BFF 403
 * (`{ url: "https://geo.captcha-delivery.com/captcha/?..." }`).
 * If URL has `t=bv`, treat as Hyper hard-block (do not solve).
 * @see https://docs.hypersolutions.co/datadome/getting-started.md#slider
 */
export async function solveDatadomeCaptchaUrl(session, ctx, captchaUrl, { pageUrl } = {}) {
  const url = String(captchaUrl || "");
  if (!url || !/captcha-delivery\.com\/captcha/i.test(url)) {
    return { ok: false, note: "not a captcha-delivery captcha URL" };
  }
  if (/[?&]t=bv\b/i.test(url)) {
    return {
      ok: false,
      isIpBanned: true,
      hardBlock: true,
      note: "pc_edge_tbv: captcha URL t=bv — Hyper hard-block for this sticky; rotate (Bandai-ok ≠ PKC DataDome)",
      ref: "https://docs.hypersolutions.co/datadome/getting-started.md#slider",
    };
  }
  if (!hyperConfigured()) {
    return { ok: false, note: "HYPER_API_KEY missing" };
  }
  let ip = "";
  try {
    ip = (await resolveEgressIp(ctx)) || "";
  } catch {
    ip = "";
  }
  const referer = pageUrl || `${session.state?.base || PC_ORIGIN}/`;
  const deviceHtml = await fetchDeviceHtml(session, url, referer);
  const imgs = extractDdSliderImages(deviceHtml);
  const { puzzleUrl, pieceUrl } = imgs;
  if (!puzzleUrl || !pieceUrl) {
    return {
      ok: false,
      note: imgs.needsHcaptcha
        ? "captcha page escalated to hCaptcha — rotate sticky"
        : imgs.looksLikeStorefront
          ? "captcha URL returned storefront HTML — rotate sticky"
          : `captchaChallengePath missing (${imgs.bytes}b)`,
      needsHcaptcha: imgs.needsHcaptcha,
      bytes: imgs.bytes,
    };
  }
  const [puzzleB64, pieceB64] = await Promise.all([
    fetch(puzzleUrl).then(async (r) => bufferToB64(Buffer.from(await r.arrayBuffer()))),
    fetch(pieceUrl).then(async (r) => bufferToB64(Buffer.from(await r.arrayBuffer()))),
  ]);
  const solved = await solveDataDomeSlider({
    html: "",
    datadomeCookie: ctx.jar?.get?.("datadome") || "",
    referer,
    parentUrl: referer,
    userAgent: session.state?.userAgent || "",
    ip,
    acceptLanguage: session.state?.acceptLanguage || "en-AU,en;q=0.9",
    deviceLinkHtml: deviceHtml,
    puzzleB64,
    pieceB64,
    deviceLink: url,
  });
  if (solved.isIpBanned) {
    return {
      ok: false,
      isIpBanned: true,
      hardBlock: true,
      note: "slider t=bv after captcha URL fetch",
    };
  }
  if (!solved.payload) {
    return { ok: false, note: "slider payload empty" };
  }
  const verifyRes = await session.get(solved.payload, {
    headers: { referer, ...(solved.headers || {}) },
  });
  ctx.jar?.ingest?.(verifyRes.headers);
  const verifyText = await session.readText(verifyRes);
  let verifyJson = null;
  try {
    verifyJson = JSON.parse(verifyText);
  } catch {
    /* ignore */
  }
  const applied = applyDatadomeSolveJson(ctx.jar, verifyJson || {});
  return {
    ok: Boolean(applied.cookie),
    status: verifyRes.status,
    note: applied.cookie
      ? "BFF captcha URL slider solved"
      : `captcha check ${verifyRes.status} ${verifyText.slice(0, 80)}`,
  };
}

/**
 * Post DataDome tags (ch → le) to raise trust before BFF ATC.
 * @see https://docs.hypersolutions.co/datadome/tags.md
 */
export async function postDataDomeTags(session, ctx, { pageUrl } = {}) {
  if (!hyperConfigured()) {
    return { ok: false, note: "HYPER_API_KEY missing — skip tags" };
  }
  let ip = "";
  try {
    ip = (await resolveEgressIp(ctx)) || "";
  } catch {
    ip = "";
  }
  const referer = pageUrl || `${session.state.base}/`;
  const cid = ctx.jar?.get?.("datadome") || "";
  const results = [];
  for (const type of ["ch", "le"]) {
    const { payload } = await solveDataDomeTags({
      userAgent: session.state.userAgent,
      ddk: PC_DATADOME_HSH,
      referer,
      type,
      ip,
      acceptLanguage: session.state.acceptLanguage,
      cid: ctx.jar?.get?.("datadome") || cid,
    });
    const body =
      typeof payload === "string"
        ? payload
        : payload?.payload || JSON.stringify(payload);
    const res = await session.post(PC_DATADOME_TAGS_URL, {
      body,
      headers: {
        referer,
        origin: PC_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json, text/plain, */*",
        "sec-fetch-site": "same-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
    });
    ctx.jar?.ingest?.(res.headers);
    const text = await session.readText(res);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    const applied = applyDatadomeSolveJson(ctx.jar, json || {});
    results.push({
      type,
      status: res.status,
      cookie: Boolean(applied.cookie),
    });
  }
  session.state.datadomeTags = true;
  const ok = results.every((r) => r.status >= 200 && r.status < 400);
  return {
    ok,
    results,
    note: ok
      ? `datadome tags ch+le posted (${results.map((r) => r.status).join("/")})`
      : `datadome tags partial ${JSON.stringify(results)}`,
    ref: "https://docs.hypersolutions.co/datadome/tags.md",
  };
}

/**
 * Warm locale home: Incapsula clear → optional re-GET → DataDome if still blocked.
 */
/**
 * @param {object} session
 * @param {object} ctx
 * @param {{ tStep?: Function, light?: boolean }} [opts]
 *   light: monitor mode — skip slow slider solves + second DD clear; soft-clear via category.
 */
export async function warmPokemonCentre(session, ctx, { tStep, light = false } = {}) {
  const step = tStep || (async (_n, fn) => fn());
  const homeUrl = `${session.state.base}/`;

  const home = await step("pc_home", async () => {
    const res = await session.get(homeUrl);
    const html = await session.readText(res);
    const incap = looksLikeIncapsulaChallenge(html, res.status);
    const dd = looksLikeDataDomeBlock(html, res.status, res.headers);
    return {
      ok: !incap && !dd && res.status === 200 && html.length > 5_000,
      status: res.status,
      note: incap
        ? `incapsula challenge (${html.length}b)`
        : dd
          ? `datadome block (${html.length}b)`
          : `home ${res.status} (${html.length}b)`,
      html,
      incap,
      dd,
      headers: res.headers,
    };
  });

  if (home.ok) {
    if (session?.state) session.state.edgeNote = "home clear (no challenge)";
    return { ok: true, home, note: "home clear (no challenge)" };
  }

  if (home.incap) {
    const reese = await step("incapsula_reese", async () => {
      try {
        return await clearIncapsulaReese(session, ctx, { pageUrl: homeUrl, html: home.html });
      } catch (e) {
        return { ok: false, note: e?.message || String(e) };
      }
    });
    if (!reese.ok) {
      return { ok: false, home, reese, note: reese.note || "incapsula_reese failed" };
    }
  }

  // Re-fetch (after Reese if we ran it, otherwise one more look before DD)
  const home2 = await step("pc_home_retry", async () => {
    const res = await session.get(homeUrl);
    const html = await session.readText(res);
    const incap = looksLikeIncapsulaChallenge(html, res.status);
    const dd = looksLikeDataDomeBlock(html, res.status, res.headers);
    return {
      ok: !incap && !dd && res.status === 200 && html.length > 5_000,
      status: res.status,
      note: incap
        ? `still incapsula (${html.length}b)`
        : dd
          ? `datadome block (${html.length}b)`
          : `home ${res.status} (${html.length}b)`,
      html,
      incap,
      dd,
      headers: res.headers,
    };
  });

  if (home2.ok) {
    const note = session?.state?.reeseCleared
      ? "home clear after reese"
      : "home clear on retry";
    if (session?.state) session.state.edgeNote = note;
    return { ok: true, home: home2, note };
  }

  if (home2.dd || home.dd) {
    const ddClear = await step("datadome_clear", async () => {
      try {
        return await clearDataDome(session, ctx, {
          pageUrl: homeUrl,
          html: home2.html || home.html,
          headers: home2.headers || home.headers,
          light,
        });
      } catch (e) {
        return { ok: false, note: e?.message || String(e) };
      }
    });
    if (ddClear.isIpBanned) {
      return {
        ok: false,
        home: home2,
        datadome: ddClear,
        isIpBanned: true,
        note: ddClear.note,
      };
    }
    if (!ddClear.ok) {
      return { ok: false, home: home2, datadome: ddClear, note: ddClear.note };
    }

    // Hyper interstitial success may include a redirect URL — hit it before re-GET home.
    if (ddClear.redirectUrl && /^https?:\/\//i.test(String(ddClear.redirectUrl))) {
      await step("pc_dd_redirect", async () => {
        try {
          const res = await session.get(ddClear.redirectUrl, {
            headers: { referer: homeUrl },
          });
          await session.readText(res);
          return { ok: true, status: res.status, note: `dd redirect ${res.status}` };
        } catch (e) {
          return { ok: false, note: e?.message || String(e) };
        }
      });
    }

    // DD cookie swap often re-triggers Incapsula — remint Reese *before* declaring clear,
    // and once more if home is still an incap shell (was gated on home3.ok → never ran).
    let reeseAfterDd = await step("incapsula_reese_after_dd", async () => {
      try {
        return await clearIncapsulaReese(session, ctx, {
          pageUrl: homeUrl,
          html: home2.html || "",
        });
      } catch (e) {
        return { ok: false, note: e?.message || String(e) };
      }
    });

    const fetchHomeProbe = async (label) => {
      const res = await session.get(homeUrl);
      const html = await session.readText(res);
      const incap = looksLikeIncapsulaChallenge(html, res.status);
      const dd = looksLikeDataDomeBlock(html, res.status, res.headers);
      const ok = !incap && !dd && res.status === 200 && html.length > 5_000;
      let note;
      if (ok) note = `home clear (${html.length}b)`;
      else if (incap) note = `still incapsula (${html.length}b)`;
      else if (dd) note = `still datadome (${html.length}b)`;
      else note = `still blocked (${html.length}b) status=${res.status}`;
      return { ok, status: res.status, note, html, incap, dd, headers: res.headers, label };
    };

    let home3 = await step("pc_home_after_dd", () => fetchHomeProbe("after_dd_reese"));

    // Incapsula again → one more Reese remint + home GET.
    if (!home3.ok && home3.incap) {
      reeseAfterDd = await step("incapsula_reese_home3", async () => {
        try {
          return await clearIncapsulaReese(session, ctx, {
            pageUrl: homeUrl,
            html: home3.html || "",
          });
        } catch (e) {
          return { ok: false, note: e?.message || String(e) };
        }
      });
      home3 = await step("pc_home_after_reese2", () => fetchHomeProbe("after_reese2"));
    }

    // Prefer soft-clear (category/sitemap) before a second Hyper DD solve — faster for monitor.
    if (!home3.ok) {
      const soft = await step("pc_soft_clear_probe", async () => {
        const paths = [
          `${session.state.base}/category/trading-card-game`,
          `${PC_ORIGIN}/sitemap.xml`,
        ];
        for (const url of paths) {
          try {
            const res = await session.get(url, { headers: { referer: homeUrl } });
            const html = await session.readText(res);
            const incap = looksLikeIncapsulaChallenge(html, res.status);
            const dd = looksLikeDataDomeBlock(html, res.status, res.headers);
            const productHits = (String(html || "").match(/\/product\/[A-Za-z0-9._-]+/g) || [])
              .length;
            const useful =
              res.status === 200 &&
              !incap &&
              !dd &&
              (productHits >= 3 || (html.length > 20_000 && /pokemon|product/i.test(html)));
            if (useful) {
              return {
                ok: true,
                status: res.status,
                note: `soft-clear via ${url.includes("sitemap") ? "sitemap" : "category"} (${html.length}b, ${productHits} product urls)`,
                html,
                via: url,
              };
            }
          } catch {
            /* try next */
          }
        }
        return { ok: false, note: "soft-clear probe failed" };
      });
      if (soft.ok) {
        const note = `${soft.note} · home was ${home3.note}`;
        if (session?.state) session.state.edgeNote = note;
        return {
          ok: true,
          home: soft,
          datadome: ddClear,
          reeseAfterDd,
          softClear: true,
          note,
        };
      }
    }

    // Full checkout warm: optional second DD clear. Monitor light skips (too slow).
    let ddClear2 = null;
    if (!light && !home3.ok && home3.dd) {
      ddClear2 = await step("datadome_clear_home3", async () => {
        try {
          return await clearDataDome(session, ctx, {
            pageUrl: homeUrl,
            html: home3.html,
            headers: home3.headers,
            light: false,
          });
        } catch (e) {
          return { ok: false, note: e?.message || String(e) };
        }
      });
      if (ddClear2.isIpBanned) {
        return {
          ok: false,
          home: home3,
          datadome: ddClear2,
          isIpBanned: true,
          note: ddClear2.note,
        };
      }
      if (ddClear2.ok) {
        try {
          await clearIncapsulaReese(session, ctx, { pageUrl: homeUrl, html: "" });
        } catch {
          /* best-effort */
        }
        home3 = await step("pc_home_after_dd2", () => fetchHomeProbe("after_dd2"));
      }
    }

    const note = home3.ok
      ? `home clear after DD${reeseAfterDd?.hasToken ? "+reese" : ""}${ddClear2?.ok ? "+dd2" : ""}`
      : home3.note || "still blocked after DD";
    if (session?.state) session.state.edgeNote = note;
    return {
      ok: home3.ok,
      home: home3,
      datadome: ddClear2 || ddClear,
      reeseAfterDd,
      note,
    };
  }

  const failNote = home2.note || home.note;
  if (session?.state) session.state.edgeNote = failNote;
  return { ok: false, home: home2, note: failNote };
}

/**
 * Fetch a URL; if DataDome/Incapsula blocks, attempt clear once and retry.
 */
export async function fetchWithEdgeClear(session, ctx, url, { tStep } = {}) {
  const step = tStep || (async (_n, fn) => fn());
  const res = await session.get(url, { headers: { referer: `${session.state.base}/` } });
  const html = await session.readText(res);
  const incap = looksLikeIncapsulaChallenge(html, res.status);
  const dd = looksLikeDataDomeBlock(html, res.status, res.headers);
  if (!incap && !dd) {
    return { ok: res.status === 200, status: res.status, html, cleared: false };
  }
  if (incap && !session.state.reeseCleared) {
    await step("incapsula_reese_pdp", () =>
      clearIncapsulaReese(session, ctx, { pageUrl: url, html }),
    );
  }
  if (dd) {
    const ddOut = await step("datadome_clear_pdp", () =>
      clearDataDome(session, ctx, { pageUrl: url, html, headers: res.headers }),
    );
    if (ddOut.isIpBanned) {
      return { ok: false, status: res.status, html, cleared: false, isIpBanned: true, note: ddOut.note };
    }
  }
  const res2 = await session.get(url, { headers: { referer: `${session.state.base}/` } });
  const html2 = await session.readText(res2);
  const still =
    looksLikeIncapsulaChallenge(html2, res2.status) ||
    looksLikeDataDomeBlock(html2, res2.status, res2.headers);
  return {
    ok: !still && res2.status === 200,
    status: res2.status,
    html: html2,
    cleared: true,
    stillBlocked: still,
  };
}
