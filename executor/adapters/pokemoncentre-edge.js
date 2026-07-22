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
export async function clearDataDome(session, ctx, { pageUrl, html, headers } = {}) {
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
      // Escalation — usually TLS/header fingerprint, not an automatic proxy condemnation.
      return {
        ok: false,
        kind: "interstitial_escalated",
        view: json.view,
        captchaUrl: json.url || null,
        status: postRes.status,
        note: "interstitial returned view=captcha (not redirect) — check Hyper header-order/TLS before blaming proxy",
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
  const puzzleUrl = (deviceHtml.match(/(https:\/\/dd\.prod\.captcha-delivery\.com\/image\/.*?\.jpg)/i) ||
    deviceHtml.match(/(https?:\/\/[^"' ]+\.jpg)/i) ||
    [])[1];
  const pieceUrl = (deviceHtml.match(/(https:\/\/dd\.prod\.captcha-delivery\.com\/image\/.*?\.frag\.png)/i) ||
    deviceHtml.match(/(https?:\/\/[^"' ]+\.frag\.png)/i) ||
    [])[1];
  if (!puzzleUrl || !pieceUrl) {
    return {
      ok: false,
      kind: "slider",
      note: "DataDome slider puzzle/piece URLs not found — may need hCaptcha path",
      needsHcaptcha: /hcaptcha|h-captcha/i.test(deviceHtml),
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
      note: "ATC/captcha URL t=bv — Hyper hard IP block; rotate sticky",
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
  const puzzleUrl = (deviceHtml.match(/(https:\/\/dd\.prod\.captcha-delivery\.com\/image\/.*?\.jpg)/i) ||
    deviceHtml.match(/(https?:\/\/[^"' ]+\.jpg)/i) ||
    [])[1];
  const pieceUrl = (deviceHtml.match(/(https:\/\/dd\.prod\.captcha-delivery\.com\/image\/.*?\.frag\.png)/i) ||
    deviceHtml.match(/(https?:\/\/[^"' ]+\.frag\.png)/i) ||
    [])[1];
  if (!puzzleUrl || !pieceUrl) {
    return {
      ok: false,
      note: "captcha page missing puzzle/piece — may be hCaptcha escalation",
      needsHcaptcha: /hcaptcha|h-captcha/i.test(deviceHtml),
      bytes: deviceHtml.length,
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
export async function warmPokemonCentre(session, ctx, { tStep } = {}) {
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
    session.state.edgeNote = "home clear (no challenge)";
    return { ok: true, home, note: session.state.edgeNote };
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
    session.state.edgeNote = session.state.reeseCleared
      ? "home clear after reese"
      : "home clear on retry";
    return { ok: true, home: home2, note: session.state.edgeNote };
  }

  if (home2.dd || home.dd) {
    const ddClear = await step("datadome_clear", async () => {
      try {
        return await clearDataDome(session, ctx, {
          pageUrl: homeUrl,
          html: home2.html || home.html,
          headers: home2.headers || home.headers,
        });
      } catch (e) {
        return { ok: false, note: e?.message || String(e) };
      }
    });
    if (ddClear.isIpBanned) {
      return { ok: false, home: home2, datadome: ddClear, note: ddClear.note };
    }
    if (!ddClear.ok) {
      return { ok: false, home: home2, datadome: ddClear, note: ddClear.note };
    }
    const home3 = await step("pc_home_after_dd", async () => {
      const res = await session.get(homeUrl);
      const html = await session.readText(res);
      const blocked =
        looksLikeIncapsulaChallenge(html, res.status) ||
        looksLikeDataDomeBlock(html, res.status, res.headers);
      return {
        ok: !blocked && res.status === 200 && html.length > 5_000,
        status: res.status,
        note: blocked ? `still blocked (${html.length}b)` : `home clear (${html.length}b)`,
        html,
      };
    });
    session.state.edgeNote = home3.ok ? "home clear after DD" : home3.note;
    return { ok: home3.ok, home: home3, datadome: ddClear, note: session.state.edgeNote };
  }

  session.state.edgeNote = home2.note || home.note;
  return { ok: false, home: home2, note: session.state.edgeNote };
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
