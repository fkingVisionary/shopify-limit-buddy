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

function verdictFrom({ dispatcher, requestedProxy, initialIp, currentIp, solved, rounds }) {
  if (requestedProxy && !dispatcher.proxy) return "FAIL: sticky proxy was supplied but was not parsed";
  if (requestedProxy && dispatcher.transport !== "tls") return `FAIL: explicit proxy transport was ${dispatcher.transport}, expected tls`;
  if (initialIp && currentIp && initialIp !== currentIp) return `FAIL: IP changed between sensor rounds (${initialIp} → ${currentIp})`;
  if (solved) return "PASS: transport stable + Hyper sensor POST reached valid _abck";
  const rejected = rounds.find((r) => r.bodySuccess === false);
  if (rejected) return "FAIL: Hyper generated payload but Kmart returned success=false";
  const noCookies = rounds.every((r) => r.setCookies.length === 0);
  if (noCookies) return "FAIL: sensor POST did not rotate cookies";
  return "FAIL: _abck rotated but never reached a valid marker";
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
      return {
        ok: false,
        verdict: "FAIL: script URL/body mismatch — no Akamai script path found on initial PDP response",
        targetUrl,
        transport: dispatcher.transport,
        requestedMode: transportMode,
        requestedProxy,
        initialIp,
        steps,
        cookies: compactCookies(jar),
      };
    }

    const scriptUrl = new URL(scriptPath, ORIGIN).toString();
    const scriptRes = await request(scriptUrl, { method: "GET", headers: scriptHeaders(targetUrl) }, ctx);
    const scriptBody = await scriptRes.text();
    addStep({
      step: "akamai_script_fetch",
      ok: scriptRes.status < 400 && scriptBody.length > 0,
      status: scriptRes.status,
      note: `scriptUrl=${scriptUrl} bytes=${scriptBody.length} setCookies=[${cookieNamesFromResponse(scriptRes).join(",") || "none"}]`,
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