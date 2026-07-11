// Kmart Akamai-only diagnostic lab.
// This deliberately avoids PDP/cart/checkout continuation. It proves only the
// sensor layer: transport → initial cookies → script → Hyper payload → sensor
// POST rounds → `_abck` validity.

import { parseAkamaiPath, isAkamaiCookieValid } from "hyper-sdk-js";
import { createJar, makeDispatcher, request, UA } from "../http.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { hyperConfigured, hyperSensorInputShape, solveAkamaiSensor } from "../antibot.js";
import { randomUUID } from "node:crypto";

const ORIGIN = "https://www.kmart.com.au";
const ACCEPT_LANG = "en-AU,en;q=0.9";
const DEFAULT_URL = "https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/";

const CHROME_CH = {
  "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
  "sec-ch-ua-arch": '"x86"',
  "sec-ch-ua-bitness": '"64"',
  "sec-ch-ua-full-version": '"131.0.6778.265"',
  "sec-ch-ua-full-version-list":
    '"Not(A:Brand";v="99.0.0.0", "Google Chrome";v="131.0.6778.265", "Chromium";v="131.0.6778.265"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-model": '""',
  "sec-ch-ua-platform": '"macOS"',
  "sec-ch-ua-platform-version": '"14.6.1"',
};

function navHeaders({ referer, site = "none" } = {}) {
  return {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": ACCEPT_LANG,
    "accept-encoding": "gzip, deflate, br, zstd",
    "upgrade-insecure-requests": "1",
    ...CHROME_CH,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": site,
    "sec-fetch-user": "?1",
    priority: "u=0, i",
    ...(referer ? { referer } : {}),
  };
}

function scriptHeaders(referer) {
  return {
    "user-agent": UA,
    accept: "*/*",
    "accept-language": ACCEPT_LANG,
    "accept-encoding": "gzip, deflate, br, zstd",
    referer,
    ...CHROME_CH,
    "sec-fetch-dest": "script",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "same-origin",
  };
}

function sensorHeaders(referer) {
  return {
    "user-agent": UA,
    "content-type": "application/json",
    accept: "*/*",
    "accept-language": ACCEPT_LANG,
    origin: ORIGIN,
    referer,
    ...CHROME_CH,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
}

function marker(value) {
  const v = String(value ?? "");
  if (!v) return { present: false, bytes: 0, index: null, text: "(none)" };
  const m = v.match(/~(-?\d+)~/);
  return { present: true, bytes: v.length, index: m?.[1] ?? null, text: `${v.length}b ind=${m?.[1] ?? "?"}` };
}

function cookieNamesFromResponse(res) {
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return setCookies
    .map((sc) => String(sc).split(";")[0].split("=")[0].trim())
    .filter(Boolean);
}

function bodySuccess(body) {
  if (/"success"\s*:\s*true/i.test(body)) return true;
  if (/"success"\s*:\s*false/i.test(body)) return false;
  return null;
}

function compactCookies(jar) {
  const dump = jar.dump();
  return {
    names: Object.keys(dump),
    abck: marker(dump._abck),
    bmsz: marker(dump.bm_sz),
  };
}

// Classify the state Akamai edge is putting us in. Three distinct outcomes
// that used to all collapse to "fail":
//   EDGE_DENY        — edge refused before bot-manager ran; no _abck at all.
//                      IP reputation problem, not a sensor problem.
//   SENSOR_CHALLENGE — _abck present but sentinel (~-1~); Hyper must solve.
//   SOLVED           — _abck valid (~0~ marker); sensor round succeeded.
//   UNKNOWN          — anything else (partial, unexpected shape).
function classifyEdge({ status, hasAbck, abckMarker, solved }) {
  if (solved) return "SOLVED";
  if (!hasAbck && status >= 400) return "EDGE_DENY";
  if (hasAbck && abckMarker?.index === "-1") return "SENSOR_CHALLENGE";
  if (hasAbck) return "SENSOR_CHALLENGE";
  return "UNKNOWN";
}

function verdictFrom({ dispatcher, requestedProxy, initialIp, currentIp, solved, rounds, classification }) {
  if (requestedProxy && !dispatcher.proxy) return "FAIL: sticky proxy was supplied but was not parsed";
  if (requestedProxy && dispatcher.transport !== "tls") return `FAIL: explicit proxy transport was ${dispatcher.transport}, expected tls`;
  if (classification === "EDGE_DENY") return "EDGE_DENY: Akamai edge refused this IP before bot-manager ran — try a different proxy (this is NOT a Hyper failure)";
  if (initialIp && currentIp && initialIp !== currentIp) return `FAIL: IP changed between sensor rounds (${initialIp} → ${currentIp})`;
  if (solved) return "PASS: transport stable + Hyper sensor POST reached valid _abck";
  const rejected = rounds.find((r) => r.bodySuccess === false);
  if (rejected) return "SENSOR_REJECTED: Hyper generated payload but Kmart returned success=false — sensor shape/context mismatch";
  const noCookies = rounds.every((r) => r.setCookies.length === 0);
  if (noCookies) return "SENSOR_NO_ROTATE: sensor POST did not rotate cookies — request shape or headers wrong";
  return "SENSOR_STALE: _abck rotated but never reached a valid marker after all rounds";
}

export async function runKmartAkamaiLab({ url = DEFAULT_URL, proxy = null, rounds = 3, useProxy = false, transport = "tls" }) {
  const targetUrl = String(url || DEFAULT_URL).trim();
  const resolvedProxy = proxy ?? (useProxy ? process.env.PROXY_URL_RESI ?? null : null);
  const requestedProxy = Boolean(String(resolvedProxy ?? "").trim());
  const jar = createJar();
  const transportMode = ["auto", "tls", "undici", "oxylabs"].includes(String(transport)) ? String(transport) : "tls";
  const dispatcher = makeDispatcher(resolvedProxy, {
    forceTls: transportMode === "tls",
    forceUndici: transportMode === "undici",
    forceOxylabs: transportMode === "oxylabs",
  });
  const ctx = { dispatcher, jar };
  const startedAt = Date.now();
  const steps = [];
  const sensorRounds = [];

  if (dispatcher.useOxylabs) {
    ctx.oxylabsSessionId = randomUUID().replace(/-/g, "");
    ctx.oxylabsSessionTime = "10";
  }

  const addStep = (step) => {
    steps.push({ msFromStart: Date.now() - startedAt, ...step });
  };

  try {
    addStep({
      step: "transport",
      ok: requestedProxy ? dispatcher.transport === "tls" : true,
      note: `requestedMode=${transportMode} requestedProxy=${requestedProxy} parsedProxy=${Boolean(dispatcher.proxy)} transport=${dispatcher.transport} tls=${Boolean(dispatcher.useTls)} oxylabs=${Boolean(dispatcher.useOxylabs)}`,
    });

    addStep({ step: "hyper_sdk_shape", ok: true, note: JSON.stringify(hyperSensorInputShape()) });
    if (!hyperConfigured()) {
      addStep({ step: "hyper_config", ok: false, note: "HYPER_API_KEY missing on executor" });
      return { ok: false, verdict: "FAIL: HYPER_API_KEY missing on executor", targetUrl, steps, cookies: compactCookies(jar) };
    }

    const initialIp = await resolveEgressIp(ctx, { force: true });
    addStep({ step: "resolve_ip#initial", ok: Boolean(initialIp), note: initialIp ?? "(no ip)" });

    let html = "";
    let scriptPath = null;
    let scriptSourceUrl = targetUrl;
    const initialRes = await request(targetUrl, { method: "GET", headers: navHeaders({ site: "none" }) }, ctx);
    html = await initialRes.text();
    scriptPath = parseAkamaiPath(html);
    const initialSetCookies = cookieNamesFromResponse(initialRes);
    addStep({
      step: "initial_pdp_get",
      ok: Boolean(scriptPath),
      status: initialRes.status,
      note: `html=${html.length}b setCookies=[${initialSetCookies.join(",") || "none"}] jar=[${Object.keys(jar.dump()).join(",") || "none"}] script=${scriptPath ?? "(none)"} abck=${marker(jar.get("_abck")).text} bmsz=${marker(jar.get("bm_sz")).text}`,
    });

    if (!scriptPath) {
      const homeRes = await request(ORIGIN + "/", { method: "GET", headers: navHeaders({ referer: targetUrl, site: "same-origin" }) }, ctx);
      const homeHtml = await homeRes.text();
      const homeScriptPath = parseAkamaiPath(homeHtml);
      const homeSetCookies = cookieNamesFromResponse(homeRes);
      addStep({
        step: "script_discovery_home",
        ok: Boolean(homeScriptPath),
        status: homeRes.status,
        note: `initial PDP had no script; home html=${homeHtml.length}b setCookies=[${homeSetCookies.join(",") || "none"}] script=${homeScriptPath ?? "(none)"} abck=${marker(jar.get("_abck")).text} bmsz=${marker(jar.get("bm_sz")).text}`,
      });
      if (homeScriptPath) {
        scriptPath = homeScriptPath;
        scriptSourceUrl = ORIGIN + "/";
      }
    }

    // Classify the edge state from the initial PDP fetch. If the edge outright
    // denied us (403 with no _abck), Hyper cannot help — bot-manager never ran.
    const initialAbckMarker = marker(jar.get("_abck"));
    const initialHasAbck = jar.has("_abck");
    const initialClassification = classifyEdge({
      status: initialRes.status,
      hasAbck: initialHasAbck,
      abckMarker: initialAbckMarker,
      solved: false,
    });
    addStep({
      step: "classify_edge",
      ok: initialClassification !== "EDGE_DENY",
      note: `classification=${initialClassification} status=${initialRes.status} hasAbck=${initialHasAbck} abck=${initialAbckMarker.text}`,
    });

    if (initialClassification === "EDGE_DENY") {
      const verdict = verdictFrom({ dispatcher, requestedProxy, initialIp, currentIp: initialIp, solved: false, rounds: [], classification: "EDGE_DENY" });
      addStep({ step: "akamai_lab_skip", ok: false, note: verdict });
      return {
        ok: false,
        classification: "EDGE_DENY",
        verdict,
        targetUrl,
        transport: dispatcher.transport,
        requestedMode: transportMode,
        requestedProxy,
        parsedProxy: Boolean(dispatcher.proxy),
        initialIp,
        finalIp: initialIp,
        ipStable: true,
        initialStatus: initialRes.status,
        hyper: hyperSensorInputShape(),
        rounds: [],
        steps,
        cookies: compactCookies(jar),
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (!scriptPath) {
      return {
        ok: false,
        classification: "UNKNOWN",
        verdict: "FAIL: no Akamai script path found on initial PDP or home (edge served content without bot-manager script — unexpected shape)",
        targetUrl,
        transport: dispatcher.transport,
        requestedMode: transportMode,
        requestedProxy,
        initialIp,
        initialStatus: initialRes.status,
        steps,
        cookies: compactCookies(jar),
      };
    }

    const scriptUrl = new URL(scriptPath, ORIGIN).toString();
    const scriptRes = await request(scriptUrl, { method: "GET", headers: scriptHeaders(scriptSourceUrl) }, ctx);
    const scriptBody = await scriptRes.text();
    addStep({
      step: "akamai_script_fetch",
      ok: scriptRes.status < 400 && scriptBody.length > 0,
      status: scriptRes.status,
      note: `source=${scriptSourceUrl} scriptUrl=${scriptUrl} bytes=${scriptBody.length} setCookies=[${cookieNamesFromResponse(scriptRes).join(",") || "none"}]`,
    });

    if (!jar.has("_abck")) {
      jar.ingest({ "set-cookie": ["_abck=-1~-1~-1~-1~-1~-1~-1; Path=/"] });
      addStep({ step: "abck_seed", ok: true, note: "jar had no _abck after initial PDP; seeded Akamai sentinel for first Hyper call" });
    }

    let context = "";
    let currentIp = initialIp;
    let solved = false;
    const maxRounds = Math.max(1, Math.min(6, Number(rounds) || 3));

    for (let i = 0; i < maxRounds; i++) {
      const beforeAbck = marker(jar.get("_abck"));
      const beforeBmsz = marker(jar.get("bm_sz"));
      const roundIp = await resolveEgressIp(ctx, { force: true });
      currentIp = roundIp ?? currentIp;
      const ctxIn = context?.length ?? 0;
      const generated = await solveAkamaiSensor({
        jar,
        pageUrl: targetUrl,
        userAgent: UA,
        ip: roundIp ?? initialIp ?? "",
        acceptLanguage: ACCEPT_LANG,
        scriptUrl,
        scriptBody,
        prevContext: context,
        version: "3",
      });
      context = generated.context ?? "";

      const sensorRes = await request(
        generated.postUrl,
        {
          method: "POST",
          headers: sensorHeaders(targetUrl),
          body: JSON.stringify({ sensor_data: generated.payload }),
        },
        ctx,
      );
      const rawBody = await sensorRes.text().catch(() => "");
      const setCookies = cookieNamesFromResponse(sensorRes);
      const afterAbck = marker(jar.get("_abck"));
      const afterBmsz = marker(jar.get("bm_sz"));
      solved = isAkamaiCookieValid(jar.get("_abck") ?? "", i + 1);
      const round = {
        round: i + 1,
        ok: sensorRes.status < 400 && bodySuccess(rawBody) !== false && solved,
        status: sensorRes.status,
        transport: dispatcher.transport,
        requestedMode: transportMode,
        requestedProxy,
        egressIp: roundIp,
        ipChanged: Boolean(initialIp && roundIp && initialIp !== roundIp),
        payloadPrefix: String(generated.payload ?? "").slice(0, 3),
        payloadBytes: String(generated.payload ?? "").length,
        ctxIn,
        ctxOut: context.length,
        bodySuccess: bodySuccess(rawBody),
        setCookies,
        beforeAbck,
        afterAbck,
        beforeBmsz,
        afterBmsz,
        solved,
        body: rawBody.replace(/\s+/g, " ").slice(0, 220),
      };
      sensorRounds.push(round);
      addStep({
        step: `akamai_sensor#${i + 1}`,
        ok: round.ok,
        status: round.status,
        note: `transport=${round.transport} proxy=${requestedProxy} ip=${round.egressIp ?? "?"} ipChanged=${round.ipChanged} payloadBytes=${round.payloadBytes} bodySuccess=${round.bodySuccess} setCookies=[${setCookies.join(",") || "none"}] beforeAbck=${beforeAbck.text} afterAbck=${afterAbck.text} beforeBmsz=${beforeBmsz.text} afterBmsz=${afterBmsz.text} ctxIn=${ctxIn} ctxOut=${context.length} solved=${solved} body=${round.body}`,
      });
      if (solved) break;
    }

    const verdict = verdictFrom({ dispatcher, requestedProxy, initialIp, currentIp, solved, rounds: sensorRounds });
    addStep({ step: solved ? "akamai_lab_pass" : "akamai_lab_fail", ok: solved, note: verdict });

    return {
      ok: solved,
      verdict,
      targetUrl,
      transport: dispatcher.transport,
      requestedMode: transportMode,
      requestedProxy,
      parsedProxy: Boolean(dispatcher.proxy),
      initialIp,
      finalIp: currentIp,
      ipStable: !initialIp || !currentIp || initialIp === currentIp,
      scriptUrl,
      scriptBytes: scriptBody.length,
      hyper: hyperSensorInputShape(),
      rounds: sensorRounds,
      steps,
      cookies: compactCookies(jar),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (e) {
    addStep({ step: "akamai_lab_error", ok: false, note: e?.message ?? String(e) });
    return {
      ok: false,
      verdict: `FAIL: lab error — ${e?.message ?? String(e)}`,
      targetUrl,
      transport: dispatcher.transport,
      requestedMode: transportMode,
      requestedProxy,
      steps,
      rounds: sensorRounds,
      cookies: compactCookies(jar),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    try { await dispatcher.close?.(); } catch { /* ignore */ }
  }
}