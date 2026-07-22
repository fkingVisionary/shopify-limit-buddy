// Pokémon Centre edge clear: Imperva Reese84 → DataDome interstitial/slider.
// HTTP-first. Sticky residential/ISP required (DC often gets t:'bv' IP ban on DD).
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
  parseSliderDeviceCheckUrl,
  parseInterstitialDeviceCheckUrl,
} from "../antibot.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { PC_ORIGIN } from "./pokemoncentre-session.js";

function bufferToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

async function readArrayBuffer(res) {
  if (typeof res.arrayBuffer === "function") {
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }
  const t = await res.text();
  return Buffer.from(t, "binary");
}

/**
 * Clear Incapsula Reese84 on a challenge HTML response.
 */
export async function clearIncapsulaReese(session, ctx, { pageUrl, html } = {}) {
  if (!hyperConfigured()) {
    return { ok: false, note: "HYPER_API_KEY missing — cannot solve Incapsula Reese84" };
  }
  const scriptPath = extractReeseScriptPath(html);
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
 * Returns { ok, note, isIpBanned?, kind }.
 */
export async function clearDataDome(session, ctx, { pageUrl, html, headers } = {}) {
  if (!hyperConfigured()) {
    return { ok: false, note: "HYPER_API_KEY missing — cannot solve DataDome" };
  }
  const dd = parseDataDomeObject(html) || {};
  const datadomeCookie =
    ctx.jar?.get?.("datadome") || dd.cookie || "";

  // IP ban short-circuit (Hyper: t === 'bv')
  const sliderProbe = parseSliderDeviceCheckUrl(html, datadomeCookie, pageUrl || "");
  if (sliderProbe?.isIpBanned || dd.t === "bv") {
    return {
      ok: false,
      isIpBanned: true,
      kind: "ip_ban",
      note: "DataDome IP banned (t=bv) — rotate sticky AU ISP/residential",
    };
  }

  let ip = "";
  try {
    ip = (await resolveEgressIp(ctx)) || "";
  } catch {
    ip = "";
  }

  const isInterstitial =
    dd.rt === "i" ||
    /captcha-delivery\.com\/i\.js|interstitial/i.test(String(html || "")) ||
    (!dd.rt && /geo\.captcha-delivery\.com\/interstitial/i.test(String(html || "")));

  if (isInterstitial || dd.rt === "i") {
    // Parse deviceLink first (no Hyper call), fetch HTML on sticky proxy, then solve.
    const deviceLink = parseInterstitialDeviceCheckUrl(html, datadomeCookie, pageUrl || "");
    if (!deviceLink) {
      return { ok: false, kind: "interstitial", note: "DataDome interstitial deviceLink missing" };
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
    const postRes = await session.post(solved.postUrl, {
      body: solved.payload,
      headers: {
        referer: pageUrl,
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://geo.captcha-delivery.com",
        ...(solved.headers || {}),
      },
    });
    ctx.jar?.ingest?.(postRes.headers);
    const cookie = ctx.jar?.get?.("datadome");
    session.state.datadomeCleared = Boolean(cookie);
    return {
      ok: Boolean(cookie) || postRes.status < 400,
      status: postRes.status,
      kind: "interstitial",
      note: cookie ? `datadome interstitial ok` : `interstitial POST ${postRes.status}`,
    };
  }

  // Slider / captcha (rt:'c' etc.)
  // Need device page to discover puzzle/piece image URLs.
  const deviceLink = sliderProbe?.url;
  if (!deviceLink) {
    return { ok: false, kind: "slider", note: "DataDome slider deviceLink missing" };
  }
  const deviceHtml = await fetchDeviceHtml(session, deviceLink, pageUrl);
  const puzzleUrl =
    (deviceHtml.match(/https?:\/\/[^"' ]+\.jpg/i) || [])[0] ||
    (deviceHtml.match(/\/image\/[^"' ]+\.jpg/i) || [])[0];
  const pieceUrl =
    (deviceHtml.match(/https?:\/\/[^"' ]+\.frag\.png/i) || [])[0] ||
    (deviceHtml.match(/\/image\/[^"' ]+\.frag\.png/i) || [])[0];
  if (!puzzleUrl || !pieceUrl) {
    return {
      ok: false,
      kind: "slider",
      note: "DataDome slider puzzle/piece URLs not found — may need hCaptcha path",
      needsHcaptcha: /hcaptcha|h-captcha/i.test(deviceHtml),
    };
  }
  const abs = (u) => (u.startsWith("http") ? u : `https://dd.prod.captcha-delivery.com${u}`);
  const puzzleRes = await session.get(abs(puzzleUrl), { headers: { referer: deviceLink } });
  const pieceRes = await session.get(abs(pieceUrl), { headers: { referer: deviceLink } });
  const puzzleB64 = bufferToB64(await readArrayBuffer(puzzleRes));
  const pieceB64 = bufferToB64(await readArrayBuffer(pieceRes));

  const solved = await solveDataDomeSlider({
    html,
    datadomeCookie,
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
      kind: "ip_ban",
      note: "DataDome IP banned during slider solve",
    };
  }
  // Slider payload is a verification URL to GET.
  const verifyRes = await session.get(solved.payload, {
    headers: {
      referer: pageUrl,
      ...(solved.headers || {}),
    },
  });
  ctx.jar?.ingest?.(verifyRes.headers);
  const cookie = ctx.jar?.get?.("datadome");
  session.state.datadomeCleared = Boolean(cookie);
  return {
    ok: Boolean(cookie) || verifyRes.status < 400,
    status: verifyRes.status,
    kind: "slider",
    note: cookie ? "datadome slider ok" : `slider verify ${verifyRes.status}`,
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
