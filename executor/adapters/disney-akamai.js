/**
 * Disney Store AU — Hyper Akamai warm (sensor + optional SBSD/pixel).
 *
 * Pattern mirrors Kmart's undici + Hyper path, scoped to disneystore.com.au.
 * Do not import kmart.js — keep Disney self-contained.
 */

import { parseAkamaiPath, isAkamaiCookieValid } from "hyper-sdk-js";
import {
  hyperConfigured,
  solveAkamaiSensor,
  solveAkamaiPixel,
  solveAkamaiSbsd,
} from "../antibot.js";
import { request } from "../http.js";
import {
  DISNEY_ORIGIN,
  disneyNavHeaders,
  looksLikeAkamaiDenied,
  extractAkamaiScriptPath as heuristicAkamaiPath,
} from "./disney-session.js";

const ACCEPT_LANG = "en-AU,en;q=0.9";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findAkamaiScriptPath(html) {
  try {
    const p = parseAkamaiPath(html);
    if (p) return p;
  } catch {
    /* fall through */
  }
  return heuristicAkamaiPath(html);
}

function abckSolved(jar, roundCount) {
  const v = jar?.get?.("_abck") ?? "";
  try {
    return isAkamaiCookieValid(v, roundCount);
  } catch {
    return /~0~/.test(v);
  }
}

function akamaiSensorHeaders({ requestOrigin, referer, userAgent }) {
  return {
    "user-agent": userAgent,
    accept: "*/*",
    "accept-language": ACCEPT_LANG,
    "content-type": "text/plain;charset=UTF-8",
    origin: requestOrigin,
    referer: referer || `${requestOrigin}/`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
}

function extractSbsdChallenge(html) {
  const h = String(html || "");
  const m =
    h.match(/\/([0-9a-zA-Z_-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ||
    h.match(/sbsd[^"']*["']([^"']+)["']/i);
  if (!m) return null;
  // Soft heuristic — only treat as SBSD when page mentions sbsd.
  if (!/sbsd/i.test(h)) return null;
  return { uuid: m[2] || m[1], raw: m[0] };
}

/**
 * Warm homepage cookies + Hyper sensor until `_abck` valid (or rounds exhausted).
 */
async function runSensorRounds(session, ctx, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  const origin = session.state.origin || DISNEY_ORIGIN;
  const ua = session.state.userAgent;
  const jar = ctx.jar;
  const pageUrl = opts.pageUrl || `${origin}/`;
  const scriptUrl = opts.scriptUrl;
  const scriptBody = opts.scriptBody || "";
  const maxRounds = Number(opts.maxRounds || 3);
  const label = opts.label || "akamai_sensor";
  let localContext = opts.prevContext || null;
  let solved = false;
  let rounds = 0;

  for (let i = 0; i < maxRounds; i++) {
    rounds = i + 1;
    const row = await tStep(`${label}#${rounds}`, async () => {
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await solveAkamaiSensor({
            jar,
            pageUrl,
            userAgent: ua,
            ip: ctx.egressIp || opts.egressIp || "",
            acceptLanguage: ACCEPT_LANG,
            scriptUrl,
            scriptBody,
            prevContext: localContext,
            version: "3",
          });
          localContext = r.context;
          const res = await request(
            r.postUrl || scriptUrl,
            {
              method: "POST",
              headers: akamaiSensorHeaders({
                requestOrigin: origin,
                referer: pageUrl,
                userAgent: ua,
              }),
              body: JSON.stringify({ sensor_data: r.payload }),
            },
            ctx,
          );
          const body = await res.text().catch(() => "");
          const valid = abckSolved(jar, rounds + Number(opts.baseRound || 0));
          const softOk = res.status < 400 && /"success"\s*:\s*true/i.test(body);
          return {
            ok: res.status < 400,
            status: res.status,
            note: `sensor ${res.status} abckValid=${valid} softOk=${softOk} attempt=${attempt} page=${pageUrl.split("/").pop() || "home"} body=${body.replace(/\s+/g, " ").slice(0, 60)}`,
            valid,
          };
        } catch (e) {
          lastErr = e;
          await sleep(350 * attempt);
        }
      }
      return {
        ok: false,
        note: `sensor post failed: ${lastErr?.message || lastErr}`,
        valid: false,
      };
    });
    if (row.valid) {
      solved = true;
      break;
    }
    await sleep(200 + Math.floor(Math.random() * 200));
  }
  session.state.abckValid = solved || abckSolved(jar, rounds);
  session.state._sensorContext = localContext;
  session.state._sensorScriptUrl = scriptUrl;
  session.state._sensorScriptBody = scriptBody;
  return { ok: session.state.abckValid, solved, rounds, context: localContext };
}

export async function warmDisneyAkamai(session, ctx, opts = {}) {
  const tStep = opts.tStep || (async (_n, fn) => fn());
  const origin = session.state.origin || DISNEY_ORIGIN;
  const ua = session.state.userAgent;
  const jar = ctx.jar;
  const maxRounds = Number(opts.maxRounds || 5);

  if (!hyperConfigured()) {
    const home = await tStep("warm_home_no_hyper", async () => {
      const res = await session.get(`${origin}/`);
      const denied = looksLikeAkamaiDenied(res.text, res.status);
      session.state.warmed = res.ok && !denied;
      return {
        ok: res.ok && !denied,
        status: res.status,
        note: denied
          ? "Akamai denied home (need HYPER_API_KEY + sticky AU ISP)"
          : `home ${res.status} bytes=${res.text?.length || 0} (Hyper not configured — sensor skipped)`,
        denied,
      };
    });
    return {
      ok: home.ok,
      note: home.note,
      hyperConfigured: false,
      abckValid: abckSolved(jar, 0),
      home,
    };
  }

  const home = await tStep("warm_home", async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const headers = {
          ...disneyNavHeaders({ userAgent: ua }),
          // ISP tunnels flake less with identity than br on first CONNECT.
          "accept-encoding": "gzip, deflate",
        };
        const res = await request(`${origin}/`, { method: "GET", headers }, ctx);
        const html = await res.text().catch(() => "");
        const denied = looksLikeAkamaiDenied(html, res.status);
        session.state.warmed = res.status < 400 && !denied;
        return {
          ok: res.status < 400 && !denied,
          status: res.status,
          note: denied
            ? `Akamai denied home status=${res.status}`
            : `home ${res.status} bytes=${html.length} abck=${Boolean(jar?.get?.("_abck"))} attempt=${attempt}`,
          html,
          denied,
        };
      } catch (e) {
        lastErr = e;
        await sleep(400 * attempt);
      }
    }
    const cause = lastErr?.cause?.message || lastErr?.causeCode || "";
    return {
      ok: false,
      status: null,
      note: `warm_home failed: ${lastErr?.message || lastErr}${cause ? ` cause=${cause}` : ""}`,
      denied: false,
    };
  });

  if (!home.ok) {
    return {
      ok: false,
      note: home.note,
      hyperConfigured: true,
      abckValid: false,
      home,
    };
  }

  let html = home.html || "";
  const scriptPath = findAkamaiScriptPath(html);
  if (!scriptPath) {
    const softOk = abckSolved(jar, 0) || Boolean(jar?.get?.("_abck"));
    session.state.abckValid = softOk;
    return {
      ok: softOk,
      note: softOk
        ? "no sensor script path; seeded _abck present"
        : "Akamai script path not found in home HTML",
      hyperConfigured: true,
      abckValid: softOk,
      home,
    };
  }

  const scriptUrl = scriptPath.startsWith("http") ? scriptPath : `${origin}${scriptPath}`;
  const scriptBody = await tStep("akamai_script", async () => {
    const res = await request(
      scriptUrl,
      {
        method: "GET",
        headers: {
          "user-agent": ua,
          accept: "*/*",
          referer: `${origin}/`,
        },
      },
      ctx,
    );
    const body = await res.text().catch(() => "");
    return {
      ok: res.status < 400 && body.length > 0,
      status: res.status,
      note: `script ${res.status} bytes=${body.length}`,
      body,
    };
  });

  if (!scriptBody.ok) {
    return {
      ok: false,
      note: scriptBody.note,
      hyperConfigured: true,
      abckValid: false,
      home,
      scriptUrl,
    };
  }

  // Optional SBSD if challenge shell present.
  const sbsd = extractSbsdChallenge(html);
  if (sbsd?.uuid) {
    await tStep("sbsd_home", async () => {
      try {
        const payload = await solveAkamaiSbsd({
          jar,
          pageUrl: `${origin}/`,
          scriptBody: scriptBody.body,
          uuid: sbsd.uuid,
          index: 0,
          userAgent: ua,
          ip: ctx.egressIp || opts.egressIp || "",
          acceptLanguage: ACCEPT_LANG,
        });
        const postUrl = `${origin}/_sec/cp_challenge/verify`;
        const res = await request(
          postUrl,
          {
            method: "POST",
            headers: akamaiSensorHeaders({ requestOrigin: origin, referer: `${origin}/`, userAgent: ua }),
            body: typeof payload === "string" ? payload : JSON.stringify(payload),
          },
          ctx,
        );
        return { ok: res.status < 400, status: res.status, note: `sbsd ${res.status}` };
      } catch (e) {
        return { ok: false, note: `sbsd skip: ${e?.message || e}` };
      }
    });
  }

  const sensor = await runSensorRounds(session, ctx, {
    tStep,
    pageUrl: `${origin}/`,
    scriptUrl,
    scriptBody: scriptBody.body,
    maxRounds,
    egressIp: opts.egressIp,
    label: "akamai_sensor",
  });

  // Pixel (optional — ignore failures).
  try {
    const pixel = await solveAkamaiPixel({
      jar,
      pageUrl: `${origin}/`,
      html,
      userAgent: ua,
      ip: ctx.egressIp || opts.egressIp || "",
      acceptLanguage: ACCEPT_LANG,
      ctx,
    });
    if (pixel?.postUrl && pixel?.payload) {
      await tStep("akamai_pixel", async () => {
        const res = await request(
          pixel.postUrl,
          {
            method: "POST",
            headers: akamaiSensorHeaders({
              requestOrigin: origin,
              referer: `${origin}/`,
              userAgent: ua,
            }),
            body: pixel.payload,
          },
          ctx,
        );
        return { ok: res.status < 400, status: res.status, note: `pixel ${res.status}` };
      });
    }
  } catch {
    /* pixel optional */
  }

  session.state.warmed = true;
  return {
    ok: sensor.ok,
    note: sensor.ok
      ? `Akamai warm ok rounds=${sensor.rounds}`
      : `_abck not valid after ${sensor.rounds} sensor rounds`,
    hyperConfigured: true,
    abckValid: sensor.ok,
    rounds: sensor.rounds,
    scriptUrl,
    home,
  };
}

/** Extra sensor rounds on PDP (or any page) using cached script when possible. */
export async function refreshDisneyAkamai(session, ctx, opts = {}) {
  const origin = session.state.origin || DISNEY_ORIGIN;
  const pageUrl = opts.pageUrl || `${origin}/`;
  let scriptUrl = session.state._sensorScriptUrl;
  let scriptBody = session.state._sensorScriptBody;
  const tStep = opts.tStep || (async (_n, fn) => fn());

  if (!scriptUrl || !scriptBody) {
    const got = await session.get(pageUrl, { referer: `${origin}/` });
    const path = findAkamaiScriptPath(got.text || "");
    if (!path) return { ok: false, note: "no sensor script on refresh page" };
    scriptUrl = path.startsWith("http") ? path : `${origin}${path}`;
    const scriptRes = await request(
      scriptUrl,
      { method: "GET", headers: { "user-agent": session.state.userAgent, referer: pageUrl } },
      ctx,
    );
    scriptBody = await scriptRes.text();
  }

  return runSensorRounds(session, ctx, {
    tStep,
    pageUrl,
    scriptUrl,
    scriptBody,
    maxRounds: Number(opts.maxRounds || 3),
    egressIp: opts.egressIp || ctx.egressIp,
    prevContext: session.state._sensorContext || null,
    label: opts.label || "akamai_refresh",
  });
}

export default { warmDisneyAkamai, refreshDisneyAkamai };
