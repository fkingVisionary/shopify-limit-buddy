// Kmart AU adapter.
//
// Scope (this batch): dry-run only. Goal is to prove that Hyper-generated
// Akamai sensors clear the `_abck` challenge on kmart.com.au so the homepage
// → PDP path resolves to 200 with a valid `~0~` cookie. Cart and checkout
// endpoints get reverse-engineered after the sensor pipeline is verified.
//
// Why a custom adapter: Kmart AU runs Akamai Bot Manager (sensor + pixel,
// no SBSD as of writing). Their frontend is a custom SPA, not Shopify, so
// none of the generic Shopify cart endpoints apply.

import { request, UA } from "../http.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { hyperConfigured, solveAkamaiSensor, solveAkamaiPixel, solveAkamaiSbsd } from "../antibot.js";
import { createHash } from "node:crypto";

// Detects the SBSD script tag served inside Akamai SBSD challenge HTML
// (often returned with 403 or 429 status). Pattern per Hyper docs §3.4:
//   <script src="/path?v=<token>[&t=<token>]">
// `v` is an opaque token (NOT necessarily UUID-shaped), and the presence
// of `t=` distinguishes a HARD challenge (1 sensor submission, §3.3) from
// passive SBSD (2 submissions).
//
// IMPORTANT: the path must NOT end in `.js` — that's the Akamai bot-manager
// sensor script, not an SBSD challenge. The previous permissive pattern
// matched the sensor script URL and caused proactive `runSbsd` on the
// homepage to POST an SBSD payload to the sensor endpoint, poisoning the
// session and hard-403'ing category / cart on the next request.
const SBSD_RE = /src=["']((?:\/[a-z\d\-_.]+)+)\?v=([^"'&]*)(?:&[^"']*?t=([^"'&]+))?["']/i;
function parseSbsd(html) {
  const m = SBSD_RE.exec(html);
  if (!m) return null;
  if (/\.js$/i.test(m[1])) return null; // sensor script, not SBSD
  return { path: m[1], uuid: m[2], t: m[3] ?? "" };
}



import { parseAkamaiPath, isAkamaiCookieValid } from "hyper-sdk-js";

const ACCEPT_LANG = "en-AU,en;q=0.9";

// Human-pace jitter. Fixed delays are themselves a bot signature; always
// randomise within a range. Min/max in ms.
const sleep = (min, max) =>
  new Promise((r) => setTimeout(r, Math.floor(min + Math.random() * (max - min))));

// Realistic intermediate browsing pages — pick one at random to fetch
// between warm_home and pdp_get so the nav path is home → category → PDP
// instead of a straight home → PDP jump.
const CATEGORY_PATHS = [
  "/category/toys/D110000",
  "/category/home/D100000",
  "/category/kids-clothing/D170000",
  "/category/sale/D310000",
  "/category/kitchen-dining/D250000",
];

// Chrome 124 / macOS navigation header shape. Akamai scores requests on the
// presence + ordering of these client hints; a Chrome UA without matching
// sec-ch-ua + sec-fetch-* is an instant bot tag.
// Chrome 131 macOS client hints — basic (low entropy) + high entropy.
// Real Chrome sends the high-entropy hints (arch/bitness/full-version-list/
// model/platform-version) on navigation requests whenever the origin has
// previously responded with Accept-CH (Kmart does). Sending only the low-
// entropy trio is a classic headless-Chrome tell.
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
// Real Chrome 133 link-click navigation header set. Notable absences:
//   - NO `cache-control` / `pragma` — those only appear on a hard reload
//     (CMD+SHIFT+R). Sending them on every nav is a strong bot signal.
//   - `priority: u=0, i` is sent on every top-level navigation.
function navHeaders({ referer, site }) {
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

function akamaiSensorHeaders({ requestOrigin, referer }) {
  return {
    "user-agent": UA,
    "content-type": "application/json",
    accept: "*/*",
    "accept-language": ACCEPT_LANG,
    origin: requestOrigin,
    referer,
    ...CHROME_CH,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
}

function akamaiSensorBody(payload) {
  return JSON.stringify({ sensor_data: payload });
}

function marker(value) {
  const v = String(value ?? "");
  if (!v) return "(none)";
  const m = v.match(/~(-?\d+)~/);
  return `${v.length}b ind=${m?.[1] ?? "?"}`;
}

function cookieNamesFromResponse(res) {
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return setCookies
    .map((sc) => String(sc).split(";")[0].split("=")[0].trim())
    .filter(Boolean);
}

function sensorBodySuccess(body) {
  if (/"success"\s*:\s*true/i.test(body)) return "true";
  if (/"success"\s*:\s*false/i.test(body)) return "false";
  return "unknown";
}

function randomDecimalString(digits) {
  let out = "";
  while (out.length < digits) out += Math.floor(Math.random() * 10);
  return out.slice(0, digits).replace(/^0/, "1");
}

function hashShort(value, bytes = 12) {
  const raw = value == null ? "" : String(value);
  if (!raw) return null;
  return createHash("sha256").update(raw).digest("hex").slice(0, bytes);
}

function bodyPreview(value, max = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cookieTrustSnapshot(jar) {
  return {
    abck: marker(jar.get("_abck")),
    bmsz: marker(jar.get("bm_sz")),
    akBmsc: jar.has("ak_bmsc"),
    bmS: marker(jar.get("bm_s")),
    bmSo: marker(jar.get("bm_so")),
    bmSv: marker(jar.get("bm_sv")),
    sbsdO: marker(jar.get("sbsd_o")),
  };
}

function sbsdOCookieInput(jar) {
  const bmSo = jar.get("bm_so");
  const sbsdO = jar.get("sbsd_o");
  // Preserve current behavior in this diagnostic batch; trace the source so
  // the HAR diff can prove whether this needs to become sbsd_o-first later.
  const source = bmSo ? "bm_so" : (sbsdO ? "sbsd_o" : "none");
  const value = bmSo ?? sbsdO ?? "";
  return { source, value, bytes: String(value).length, hash: hashShort(value) };
}

function visitorIdFromGa(value) {
  const match = String(value ?? "").match(/^GA\d+\.\d+\.(\d+\.\d+)$/);
  return match?.[1] ?? null;
}

function ensureKmartVisitorIdentity(jar) {
  const existing = visitorIdFromGa(jar.get("_ga"));
  if (existing) return existing;

  // Kmart's shopping-agent seed requires x-visitor-id. In the HAR it is the
  // GA client id without the GA prefix: _ga=GA1.1.<visitor> → x-visitor-id.
  // If analytics cookies are absent in our fresh jar, create a coherent
  // browser identity set before touching api.kmart.com.au.
  const visitorId = `${randomDecimalString(10)}.${Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 86_400)}`;
  jar.ingest({
    "set-cookie": [
      `_ga=GA1.1.${visitorId}; Path=/; Domain=.kmart.com.au`,
      `server_visitor_id=${visitorId}; Path=/; Domain=.kmart.com.au`,
      `client_visitor_id=${visitorId}; Path=/; Domain=.kmart.com.au`,
      `server_visitor_id_test=${visitorId}; Path=/; Domain=.kmart.com.au`,
      `client_visitor_id_test=${visitorId}; Path=/; Domain=.kmart.com.au`,
      `tealium_visitor_id=${visitorId}; Path=/; Domain=.kmart.com.au`,
    ],
  });
  return visitorId;
}

function redactHeaderValue(name, value) {
  const key = String(name).toLowerCase();
  const raw = String(value ?? "");
  if (key === "cookie") {
    return raw
      .split(";")
      .map((part) => part.trim().split("=")[0])
      .filter(Boolean)
      .join("; ");
  }
  if (key === "authorization" || key === "x-access-token") return raw ? "[redacted]" : "";
  if (key === "newrelic" || key === "traceparent" || key === "tracestate") return raw.slice(0, 64) + (raw.length > 64 ? "…" : "");
  return raw;
}

function redactTraceBody(body) {
  if (body == null) return null;
  const redact = (value, key = "") => {
    const k = String(key).toLowerCase();
    if (k.includes("card_number")) return "[card-number-redacted]";
    if (k.includes("card_ccv") || k === "cvv") return "[cvv-redacted]";
    if (k.includes("token") || k.includes("jwt") || k.includes("x-access-token")) return "[token-redacted]";
    if (k === "email") return "[email-redacted]";
    if (k === "phone") return "[phone-redacted]";
    if (Array.isArray(value)) return value.map((v) => redact(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
    }
    if (typeof value === "string" && /^\d{12,19}$/.test(value)) return "[number-redacted]";
    return value;
  };
  if (typeof body !== "string") return redact(body);
  try {
    return redact(JSON.parse(body));
  } catch {
    if (body.includes("card_number") || body.includes("x-access-token")) return "[redacted-form-body]";
    return body.slice(0, 1200);
  }
}

async function postAkamaiSensorRounds({
  label,
  steps,
  tStep,
  ctx,
  jar,
  pageUrl,
  scriptUrl,
  scriptBody,
  requestOrigin,
  referer,
  egressIp,
}) {
  let localContext = null;
  for (let i = 0; i < 3; i++) {
    await tStep(`${label}#${i + 1}`, async () => {
      const beforeAbck = marker(jar.get("_abck"));
      const beforeBmsz = marker(jar.get("bm_sz"));
      const r = await solveAkamaiSensor({
        jar,
        pageUrl,
        userAgent: UA,
        ip: egressIp,
        acceptLanguage: ACCEPT_LANG,
        scriptUrl,
        scriptBody,
        prevContext: localContext,
        version: "3",
      });
      localContext = r.context;
      const res = await request(
        r.postUrl,
        {
          method: "POST",
          headers: akamaiSensorHeaders({ requestOrigin, referer }),
          body: akamaiSensorBody(r.payload),
        },
        ctx,
      );
      const body = await res.text().catch(() => "");
      const setCookieNames = cookieNamesFromResponse(res);
      return {
        status: res.status,
        ok: res.status < 400 && sensorBodySuccess(body) !== "false",
        note: `transport=${ctx.dispatcher?.transport ?? "unknown"} hyperPayload=${String(r.payload ?? "").slice(0, 2)} bodySuccess=${sensorBodySuccess(body)} setCookies=[${setCookieNames.join(",") || "none"}] beforeAbck=${beforeAbck} afterAbck=${marker(jar.get("_abck"))} beforeBmsz=${beforeBmsz} afterBmsz=${marker(jar.get("bm_sz"))} ctxIn=${i === 0 ? 0 : localContext?.length ?? 0} ctxOut=${r.context?.length ?? 0} body=${body.replace(/\s+/g, " ").slice(0, 180)}`,
      };
    });
    if (abckSolved(jar, i + 1)) {
      steps.push({ step: `${label}:solved`, ok: true, note: `rounds=${i + 1}` });
      return true;
    }
    await sleep(200, 400);
  }
  steps.push({ step: `${label}:unsolved`, ok: false, note: "_abck not valid after 3 challenge rounds" });
  return false;
}

// Use the SDK's parseAkamaiPath — Kmart's path doesn't contain "/akam/" and
// rotates per page load, so our old `/akam/` regex always missed.
function findAkamaiScriptPath(html) {
  return parseAkamaiPath(html);
}

// Solved when _abck contains the `~0~` indicator AND survives the SDK's
// internal validation (count of completed sensor rounds matters).
function abckSolved(jar, roundCount) {
  const v = jar.get("_abck") ?? "";
  return isAkamaiCookieValid(v, roundCount);
}


export const kmartAdapter = {
  id: "kmart",
  matches(host) {
    return host === "kmart.com.au" || host.endsWith(".kmart.com.au");
  },

  async run(task, ctx) {
    const steps = ctx.steps ?? (ctx.steps = []);
    const tStep = async (name, fn) => {
      const t0 = Date.now();
      try {
        const out = await fn();
        steps.push({ step: name, ok: out.ok !== false, status: out.status ?? null, ms: Date.now() - t0, note: out.note });
        return out;
      } catch (e) {
        const detail = (() => {
          if (e?.code === "antibot_misconfigured") return "HYPER_API_KEY missing on executor";
          const parts = [e?.message ?? String(e)];
          if (e?.cause) parts.push(`cause=${e.cause?.message ?? JSON.stringify(e.cause)}`);
          if (e?.response) {
            try {
              parts.push(`resp=${JSON.stringify({ status: e.response.status, data: e.response.data })}`);
            } catch {}
          }
          if (e?.data) {
            try { parts.push(`data=${JSON.stringify(e.data)}`); } catch {}
          }
          return parts.join(" | ").slice(0, 800);
        })();
        steps.push({
          step: name,
          ok: false,
          status: null,
          ms: Date.now() - t0,
          note: detail,
        });
        throw e;
      }
    };

    const traceEnabled = task.debugTrace === true || process.env.KMART_TRACE === "1";
    const requestTrace = ctx.requestTrace ?? (ctx.requestTrace = []);
    const recordTrace = (key, url, opts, res, extra = {}) => {
      if (!traceEnabled) return;
      let parsedUrl;
      try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
      const headers = opts?.headers ?? {};
      const cookieHeader = extra.requestCookieHeader ?? ctx.jar.header();
      const tracedHeaders = { ...headers, ...(cookieHeader ? { cookie: cookieHeader } : {}) };
      requestTrace.push({
        kind: "request",
        key,
        method: (opts?.method ?? "GET").toUpperCase(),
        host: parsedUrl?.host ?? null,
        path: parsedUrl?.pathname ?? null,
        search: parsedUrl?.search ?? "",
        status: res?.status ?? null,
        operationName: extra.operationName ?? null,
        variables: redactTraceBody(extra.variables ?? null),
        query: typeof extra.query === "string" ? extra.query.replace(/\s+/g, " ").trim() : null,
        requestBody: redactTraceBody(opts?.body ?? null),
        requestHeaders: Object.fromEntries(Object.entries(tracedHeaders).map(([name, value]) => [name.toLowerCase(), redactHeaderValue(name, value)])),
        cookieNames: cookieHeader.split(";").map((part) => part.trim().split("=")[0]).filter(Boolean),
        setCookieNames: res ? cookieNamesFromResponse(res) : [],
      });
    };
    const recordTraceEvent = (key, event = {}) => {
      if (!traceEnabled) return;
      requestTrace.push({ kind: "event", key, ...event });
    };
    const tracedRequest = async (key, url, opts, extra = {}) => {
      const requestCookieHeader = ctx.jar.header();
      const res = await request(url, opts, ctx);
      recordTrace(key, url, opts, res, { ...extra, requestCookieHeader });
      return res;
    };

    const allowedKmartModes = new Set(["current", "cart-baseline", "diagnostic"]);
    const requestedKmartMode = typeof task.kmartMode === "string" ? task.kmartMode : "current";
    const kmartMode = allowedKmartModes.has(requestedKmartMode) ? requestedKmartMode : "current";
    steps.push({
      step: "kmart_mode",
      ok: true,
      note: JSON.stringify({ requested: requestedKmartMode, normalized: kmartMode, branch: "single-adapter-current" }),
    });
    recordTraceEvent("kmart_mode", { mode: { requested: requestedKmartMode, normalized: kmartMode, branch: "single-adapter-current" } });

    steps.push({
      step: "transport",
      ok: true,
      note: `mode=${ctx.dispatcher?.transport ?? "unknown"} explicitProxy=${Boolean(ctx.dispatcher?.proxy)} tls=${Boolean(ctx.dispatcher?.useTls)}`,
    });
    if (!hyperConfigured()) {
      steps.push({ step: "antibot_misconfigured", ok: false, note: "HYPER_API_KEY missing on executor" });
      return { ok: false, steps, finalUrl: task.storeUrl, cookies: ctx.jar.dump() };
    }

    const origin = "https://www.kmart.com.au";
    // Sanitize task.storeUrl. Users occasionally paste PDP URLs with a
    // trailing sub-path (e.g. "…-43552146/status") which is not a real
    // Kmart page — Akamai 301s it to canonical, we get 0-byte HTML, SKU
    // extract fails, and worse, that fake URL becomes the referer on every
    // api.kmart.com.au GraphQL call → 403 Access Denied at the api edge.
    // Strip any trailing non-standard segment after the -<keycode>/ chunk.
    const pdpUrl = (() => {
      const raw = String(task.storeUrl || "");
      const m = raw.match(/^(https?:\/\/[^/]+\/product\/[^/?#]*-\d{6,9})(?:\/[^?#]*)?(\?[^#]*)?/i);
      return m ? `${m[1]}/${m[2] ?? ""}` : raw;
    })();
    steps.push({ step: "pdp_url_sanitize", ok: true, note: `raw=${task.storeUrl} → clean=${pdpUrl}` });

    let scriptPath = null;
    let scriptBody = null;
    let html = "";
    let prevContext = null;
    let lastSbsdUuid = "";

    // 1. Resolve egress IP for fingerprint consistency.
    const ip = await tStep("resolve_ip", async () => {
      const v = await resolveEgressIp(ctx);
      return { note: v ?? "(no ip)", ok: Boolean(v) };
    }).then(() => ctx._ip ?? null).catch(() => null);
    // resolveEgressIp doesn't stash on ctx; re-read from cache via helper.
    const egressIp = await resolveEgressIp(ctx);

    // 2. Warm homepage → ingests _abck/bm_sz seeds + lets us discover the
    //    Akamai script path.
    await tStep("warm_home", async () => {
      const warmHeaders = navHeaders({ site: "none" });
      steps.push({
        step: "warm_home:hdrs",
        ok: true,
        note: JSON.stringify({ url: origin + "/", headers: warmHeaders, cookieHeader: ctx.jar.header() }),
      });
      const res = await request(
        origin + "/",
        { method: "GET", headers: warmHeaders },
        ctx,
      );
      html = await res.text();
      scriptPath = findAkamaiScriptPath(html);
      recordTraceEvent("nav_warm_home", {
        type: "document_get",
        url: origin + "/",
        status: res.status,
        htmlBytes: html.length,
        scriptPath,
        setCookieNames: cookieNamesFromResponse(res),
        jar: cookieTrustSnapshot(ctx.jar),
      });
      // Diagnostic: expose which cookies Kmart actually set —
      // if _abck/bm_sz aren't here, Hyper's sensor call will reject with
      // "missing abck" and none of the downstream steps can succeed.
      const setCookies =
        typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      const setCookieNames = setCookies
        .map((sc) => String(sc).split(";")[0].split("=")[0].trim())
        .filter(Boolean);
      steps.push({
        step: "warm_home:cookies",
        ok: setCookieNames.includes("_abck"),
        note: `set-cookie count=${setCookies.length} names=[${setCookieNames.join(",")}] jar=[${Object.keys(ctx.jar.dump()).join(",")}]`,
      });
      const snippet = html.replace(/\s+/g, " ").trim().slice(0, 240);
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 400 && Boolean(scriptPath),
        note: `${html.length}b, abck=${ctx.jar.has("_abck")} bmsz=${ctx.jar.has("bm_sz")} script=${scriptPath ?? "(none)"} srv=${res.headers.get("server") ?? "-"} ct=${res.headers.get("content-type") ?? "-"} body=${snippet}`,
      };
    });

    // 2a-DIAG. Homepage script-tag dump. Diagnostic-only: enumerates every
    // <script src="…"> found in the homepage HTML with its path, whether
    // the path ends in `.js`, and which query params it carries. We hash
    // the token values so nothing sensitive leaks. Use this to identify
    // the real SBSD script tag Kmart serves so we can tighten SBSD_RE
    // without re-poisoning the session by matching the sensor script.
    try {
      const tagRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
      const seen = [];
      let mm;
      while ((mm = tagRe.exec(html)) && seen.length < 60) {
        const raw = mm[1];
        // Only report internal/relative script srcs — third-party CDNs are noise here.
        if (!/^\//.test(raw) && !/kmart\.com\.au/i.test(raw)) continue;
        let path = raw;
        let query = "";
        const qi = raw.indexOf("?");
        if (qi >= 0) { path = raw.slice(0, qi); query = raw.slice(qi + 1); }
        const qparams = query
          ? Object.fromEntries(
              query.split("&").filter(Boolean).map((p) => {
                const [k, v = ""] = p.split("=");
                return [k, v ? `${v.length}b:${hashShort(v)}` : "(empty)"];
              }),
            )
          : {};
        const endsJs = /\.js(?:$|\?)/i.test(raw);
        const sbsdReMatch = SBSD_RE.test(`src="${raw}"`);
        const sbsdParsed = parseSbsd(`<script src="${raw}">`);
        seen.push({
          path,
          endsJs,
          hasV: "v" in qparams,
          hasT: "t" in qparams,
          qparams,
          matchesSbsdRe: sbsdReMatch,
          parsedAsSbsd: Boolean(sbsdParsed),
        });
      }
      const sbsdCandidates = seen.filter((s) => s.hasV && !s.endsJs);
      const sensorLike = seen.filter((s) => s.endsJs && s.hasV);
      recordTraceEvent("home_scripts_dump", {
        type: "diag_home_scripts",
        totalTags: seen.length,
        sbsdCandidates,
        sensorLike,
        allTags: seen,
      });
      steps.push({
        step: "home_scripts_dump",
        ok: true,
        note: `scriptTags=${seen.length} sbsdCandidates=${sbsdCandidates.length} sensorLike=${sensorLike.length}`,
      });
    } catch (e) {
      steps.push({ step: "home_scripts_dump", ok: false, note: `err=${e?.message ?? e}` });
    }

    if (!scriptPath) {
      // Without the script path we can't generate a sensor. Fail fast.
      steps.push({ step: "akamai_script_missing", ok: false, note: "no /akam/ path on homepage; recon needed" });
      return { ok: false, steps, finalUrl: origin, cookies: ctx.jar.dump() };
    }
    const scriptUrl = scriptPath ? origin + scriptPath : null;

    // 2b. PROACTIVE SBSD SOLVE. Kmart runs passive SBSD on the whole site.
    //     Real Chrome fetches + solves the SBSD script on the homepage
    //     before any protected nav (category/PDP). Without it, `_abck`
    //     alone is not enough and category/PDP hard-403 with no in-body
    //     challenge (see `sbsd_missing` note on prior runs). Docs §3.5.
    const runSbsd = async (sourceHtml, pageUrl, label) => {
      const parsed = parseSbsd(sourceHtml);
      if (!parsed) {
        steps.push({ step: `${label}:none`, ok: true, note: "no SBSD script tag in HTML" });
        return false;
      }
      if (parsed.uuid) lastSbsdUuid = parsed.uuid;
      const sbsdUuid = parsed.uuid || lastSbsdUuid;
      if (!sbsdUuid) {
        steps.push({ step: `${label}:missing_uuid`, ok: false, note: "SBSD script had empty v= and no cached uuid from an earlier page" });
        return false;
      }
      const sbsdPath = parsed.path.startsWith("/") ? parsed.path : "/" + parsed.path;
      const sbsdScriptUrl = origin + sbsdPath + `?v=${parsed.uuid}${parsed.t ? `&t=${parsed.t}` : ""}`;
      const sbsdPostUrl = origin + sbsdPath + (parsed.t ? `?t=${parsed.t}` : "");
      let sbsdBody = "";
      await tStep(`${label}:script_fetch`, async () => {
        const r = await request(
          sbsdScriptUrl,
          {
            method: "GET",
            headers: {
              "user-agent": UA,
              referer: pageUrl,
              "accept-language": ACCEPT_LANG,
              accept: "*/*",
              "sec-fetch-dest": "script",
              "sec-fetch-mode": "no-cors",
              "sec-fetch-site": "same-origin",
            },
          },
          ctx,
        );
        sbsdBody = await r.text();
        recordTraceEvent(`${label}:script_fetch`, {
          type: "sbsd_script_fetch",
          label,
          pageUrl,
          scriptUrl: sbsdScriptUrl,
          postUrl: sbsdPostUrl,
          path: sbsdPath,
          uuidHash: hashShort(sbsdUuid),
          hasToken: Boolean(parsed.t),
          tokenHash: hashShort(parsed.t),
          status: r.status,
          scriptBytes: sbsdBody.length,
          scriptHash: hashShort(sbsdBody),
          setCookieNames: cookieNamesFromResponse(r),
          jar: cookieTrustSnapshot(ctx.jar),
        });
        return { status: r.status, note: `uuid=${sbsdUuid.slice(0, 8)}${parsed.uuid ? "" : "(cached)"} ${sbsdBody.length}b t=${parsed.t || "-"}` };
      });
      const rounds = parsed.t ? 1 : 2; // hard = 1, passive = 2 (docs §3.3)
      for (let i = 0; i < rounds; i++) {
        await tStep(`${label}:round#${i}`, async () => {
          const oInput = sbsdOCookieInput(ctx.jar);
          const beforeCookies = cookieTrustSnapshot(ctx.jar);
          const payload = await solveAkamaiSbsd({
            jar: ctx.jar,
            pageUrl,
            scriptBody: sbsdBody,
            uuid: sbsdUuid,
            oCookie: oInput.value,
            index: i,
            userAgent: UA,
            ip: egressIp,
            acceptLanguage: ACCEPT_LANG,
          });
          const res = await request(
            sbsdPostUrl,
            {
              method: "POST",
              headers: {
                "user-agent": UA,
                "content-type": "application/json",
                accept: "*/*",
                "accept-language": ACCEPT_LANG,
                origin,
                referer: pageUrl,
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
              },
              body: JSON.stringify({ body: payload }),
            },
            ctx,
          );
          const rawBody = await res.text().catch(() => "");
          const bodyTxt = rawBody.replace(/\s+/g, " ").slice(0, 180);
          const setCookieNames = cookieNamesFromResponse(res);
          const sbsdKeys = Object.keys(ctx.jar.dump()).filter((k) => /sbsd|bm_s/.test(k)).join(",");
          const akGrn = res.headers.get("akamai-grn") || "-";
          const server = res.headers.get("server") || "-";
          const xCache = res.headers.get("x-cache") || "-";
          const ctType = res.headers.get("content-type") || "-";
          recordTraceEvent(`${label}:round#${i}`, {
            type: "sbsd_round",
            label,
            round: i,
            pageUrl,
            referer: pageUrl,
            scriptUrl: sbsdScriptUrl,
            postUrl: sbsdPostUrl,
            path: sbsdPath,
            uuidHash: hashShort(sbsdUuid),
            hasToken: Boolean(parsed.t),
            tokenHash: hashShort(parsed.t),
            input: {
              oCookieSource: oInput.source,
              oCookieBytes: oInput.bytes,
              oCookieHash: oInput.hash,
              scriptBytes: sbsdBody.length,
              scriptHash: hashShort(sbsdBody),
              egressIpKnown: Boolean(egressIp),
            },
            payload: { bytes: String(payload ?? "").length, hash: hashShort(payload) },
            beforeCookies,
            response: {
              status: res.status,
              setCookieNames,
              bodyBytes: rawBody.length,
              bodyPreview: bodyTxt,
              headers: { server, "akamai-grn": akGrn, "x-cache": xCache, "content-type": ctType },
            },
            afterCookies: cookieTrustSnapshot(ctx.jar),
          });
          return {
            status: res.status,
            ok: res.status < 400,
            note: `status=${res.status} setCookies=[${setCookieNames.join(",") || "none"}] jarSbsd=${sbsdKeys} bm_sv=${ctx.jar.has("bm_sv")} bodyBytes=${rawBody.length} srv=${server} grn=${akGrn} xCache=${xCache} ct=${ctType} payloadBytes=${String(payload ?? "").length} body="${bodyTxt}"`,
          };

        }).catch(() => {});
      }
      return true;
    };
    // NOTE: proactive SBSD on the homepage was REMOVED. The Akamai lab
    // (kmart-akamai-lab.js) proves the sensor solves cleanly with just
    // {initial GET → script fetch → sensor rounds}. The old `sbsd_home`
    // was firing on Akamai's own bot-manager script tag (SBSD_RE matches
    // any `?v=` script) and POSTing bogus SBSD payloads to the sensor
    // endpoint, poisoning the session. Reactive SBSD on pdp_get remains.

    // Human pause: glance at homepage before the browser pulls the sensor script.
    await sleep(800, 1500);

    // 3. Fetch the Akamai sensor script. Headers must match a real Chrome
    //    script-tag load — the lab uses these exact headers and consistently
    //    reaches SOLVED. Missing CH / sec-fetch-dest / accept-encoding is a
    //    fingerprintable divergence and is enough on its own to have the
    //    following sensor POST scored as bot.
    await tStep("akamai_script_fetch", async () => {
      const res = await request(
        scriptUrl,
        {
          method: "GET",
          headers: {
            "user-agent": UA,
            accept: "*/*",
            "accept-language": ACCEPT_LANG,
            "accept-encoding": "gzip, deflate, br, zstd",
            referer: origin + "/",
            ...CHROME_CH,
            "sec-fetch-dest": "script",
            "sec-fetch-mode": "no-cors",
            "sec-fetch-site": "same-origin",
          },
        },
        ctx,
      );
      scriptBody = await res.text();
      recordTraceEvent("akamai_script_fetch", {
        type: "akamai_script_fetch",
        scriptUrl,
        referer: origin + "/",
        status: res.status,
        scriptBytes: scriptBody.length,
        scriptHash: hashShort(scriptBody),
        setCookieNames: cookieNamesFromResponse(res),
        jar: cookieTrustSnapshot(ctx.jar),
      });
      return { status: res.status, note: `${scriptBody.length}b` };
    });


    // 4. Sensor loop. Akamai rotates `_abck` on response; we need `~0~` in
    //    the cookie before we're allowed past the bot wall. Cap at 3 rounds.
    //
    // Seed a sentinel `_abck` if the jar is missing one. Hyper's /v2/sensor
    // endpoint rejects empty abck with `{"error":"missing abck"}`. The
    // sentinel is Akamai's own "unsolved" placeholder; the sensor POST
    // response Set-Cookies the real `_abck` back.
    if (!ctx.jar.has("_abck")) {
      ctx.jar.ingest({ "set-cookie": ["_abck=-1~-1~-1~-1~-1~-1~-1; Path=/"] });
      steps.push({
        step: "akamai_abck_seed",
        ok: true,
        note: "jar had no _abck after warm_home; seeded sentinel for first sensor",
      });
    }
    steps.push({
      step: "akamai_sensor:pre",
      ok: ctx.jar.has("_abck"),
      note: `transport=${ctx.dispatcher?.transport ?? "unknown"} ip=${egressIp ?? "?"} abck=${marker(ctx.jar.get("_abck"))} bmsz=${marker(ctx.jar.get("bm_sz"))} scriptBytes=${scriptBody?.length ?? 0}`,
    });
    for (let i = 0; i < 3; i++) {
      const { payload, postUrl, context } = await tStep(`akamai_sensor#${i + 1}`, async () => {
        const beforeAbck = marker(ctx.jar.get("_abck"));
        const beforeBmsz = marker(ctx.jar.get("bm_sz"));
        const beforeCookies = cookieTrustSnapshot(ctx.jar);
        const r = await solveAkamaiSensor({
          jar: ctx.jar,
          pageUrl: pdpUrl,

          userAgent: UA,
          ip: egressIp,
          acceptLanguage: ACCEPT_LANG,
          scriptUrl,
          scriptBody,
          prevContext,
          version: "3",
        });
        // Post the sensor payload back to the script URL — Akamai answers
        // with refreshed `_abck`/`bm_sz` cookies via Set-Cookie.
        const res = await request(
          r.postUrl,
          {
            method: "POST",
            headers: akamaiSensorHeaders({ requestOrigin: origin, referer: pdpUrl }),
            body: akamaiSensorBody(r.payload),
          },
          ctx,
        );
        const body = await res.text().catch(() => "");
        const setCookieNames = cookieNamesFromResponse(res);
        recordTraceEvent(`akamai_sensor#${i + 1}`, {
          type: "akamai_sensor_round",
          round: i + 1,
          pageUrl: pdpUrl,
          scriptUrl,
          input: {
            scriptBytes: prevContext ? 0 : scriptBody?.length ?? 0,
            scriptHash: prevContext ? null : hashShort(scriptBody),
            contextInBytes: prevContext?.length ?? 0,
            egressIpKnown: Boolean(egressIp),
          },
          payload: { bytes: String(r.payload ?? "").length, hash: hashShort(r.payload), prefix: String(r.payload ?? "").slice(0, 2) },
          beforeCookies,
          response: { status: res.status, setCookieNames, bodySuccess: sensorBodySuccess(body), bodyPreview: bodyPreview(body) },
          afterCookies: cookieTrustSnapshot(ctx.jar),
          contextOutBytes: r.context?.length ?? 0,
        });
        return {
          status: res.status,
          ok: res.status < 400 && sensorBodySuccess(body) !== "false",
          note: `transport=${ctx.dispatcher?.transport ?? "unknown"} hyperPayload=${String(r.payload ?? "").slice(0, 2)} bodySuccess=${sensorBodySuccess(body)} setCookies=[${setCookieNames.join(",") || "none"}] beforeAbck=${beforeAbck} afterAbck=${marker(ctx.jar.get("_abck"))} beforeBmsz=${beforeBmsz} afterBmsz=${marker(ctx.jar.get("bm_sz"))} ctxIn=${prevContext?.length ?? 0} ctxOut=${r.context?.length ?? 0} body=${body.replace(/\s+/g, " ").slice(0, 180)}`,
          _ctx: r.context,
        };
      }).then((s) => ({ payload: null, postUrl: null, context: s._ctx }));
      prevContext = context;
      if (abckSolved(ctx.jar, i + 1)) {
        steps.push({ step: "akamai_solved", ok: true, note: `rounds=${i + 1}` });
        steps.push({ step: "abck_raw", ok: true, note: ctx.jar.get("_abck") ?? "(empty)" });
        steps.push({ step: "bmsz_raw", ok: true, note: ctx.jar.get("bm_sz") ?? "(empty)" });
        break;
      }
      // Sensors are JS-scheduled; back-to-back posts with zero gap are a tell.
      await sleep(200, 400);
    }

    if (!abckSolved(ctx.jar, 3)) {
      steps.push({ step: "akamai_unsolved", ok: false, note: "_abck never reached ~0~ after 3 rounds" });
      return { ok: false, steps, finalUrl: origin, cookies: ctx.jar.dump() };
    }

    // 3b. Proactive SBSD on the homepage HTML. RESTORED after diagnostic
    //     evidence (`home_scripts_dump`) confirmed the homepage contains
    //     exactly 1 real SBSD candidate (path `/…/0WLGJY?v=<uuid>`) and
    //     the sensor script has no `?v=` param — so the old "SBSD_RE
    //     matches the sensor script" concern was wrong. Without this,
    //     `bm_sv` never mints and category_browse / pdp_get hard-403.
    //     This gets us back to the pre-#860 flow where PDP passed and
    //     ATC was the remaining focus.
    await runSbsd(html, origin + "/", "sbsd_home");


    // Recon helper: dump exact request headers + cookie-jar snapshot at the
    // moment of a request. Used to compare against a real browser when
    // Akamai 403s after a clean sensor solve.
    const dumpRequestState = (label, url, headers) => {
      const jarDump = ctx.jar.dump();
      // Minimal recon: URL, header order, cookie names + abck/bm_sz markers only.
      // Full cookie/header dump was bloating step notes and getting our
      // post-pdp steps cut off by upstream truncation. Trim aggressively.
      const abck = String(jarDump._abck ?? "");
      const bmsz = String(jarDump.bm_sz ?? "");
      steps.push({
        step: label,
        ok: true,
        note: JSON.stringify({
          url,
          hdrs: Object.keys(headers).length,
          ck: Object.keys(jarDump),
          abck: marker(abck),
          bmsz: marker(bmsz),
        }),
      });
    };


    // Pre-PDP pixel solve REMOVED. The lab reaches SOLVED without any pixel
    // POST and the previous implementation was firing on an empty pixel spec
    // (warm_home rarely embeds one), sometimes POSTing a stale/blank body
    // that Akamai scored against the session. Reactive pixel on pdp_get
    // (step 6 below) still runs when the PDP actually embeds a pixel.


    // 4c. Intermediate category browse. Real users don't teleport from the
    //     homepage to a deep PDP — they click into a category first. Hitting
    //     /category/* gives Akamai a same-origin nav with a sensible referer
    //     chain (none → home → category → pdp) and an extra 200 to learn from.
    const catPath = CATEGORY_PATHS[Math.floor(Math.random() * CATEGORY_PATHS.length)];
    const catUrl = origin + catPath;
    let categoryStatus = 0;
    let categoryHtml = "";
    let categoryOk = false;
    await sleep(700, 1400); // brief glance at homepage before the click
    await tStep("category_browse", async () => {
      const res = await request(
        catUrl,
        { method: "GET", headers: navHeaders({ referer: origin + "/", site: "same-origin" }) },
        ctx,
      );
      categoryStatus = res.status;
      categoryHtml = await res.text();
      categoryOk = res.status < 400;
      const hasSbsd = Boolean(parseSbsd(categoryHtml));
      recordTraceEvent("nav_category", {
        type: "document_get",
        url: catUrl,
        referer: origin + "/",
        status: res.status,
        htmlBytes: categoryHtml.length,
        hasSbsd,
        setCookieNames: cookieNamesFromResponse(res),
        jar: cookieTrustSnapshot(ctx.jar),
      });
      return { status: res.status, ok: categoryOk, note: `${catPath} ${categoryHtml.length}b sbsd=${hasSbsd}` };
    });

    // If the category hop is the first route to expose the SBSD block, solve it
    // there and retry the category before moving on. A real browser cannot click
    // from a 403 category page into the PDP, so keeping that failed hop in the
    // journey makes the next request look impossible.
    if (!categoryOk && categoryHtml) {
      try {
        const solvedCategorySbsd = await runSbsd(categoryHtml, catUrl, "sbsd_category");
        if (solvedCategorySbsd) {
          await sleep(350, 850);
          await tStep("category_browse#2", async () => {
            const res = await request(
              catUrl,
              { method: "GET", headers: navHeaders({ referer: origin + "/", site: "same-origin" }) },
              ctx,
            );
            categoryStatus = res.status;
            categoryHtml = await res.text();
            categoryOk = res.status < 400;
            const snippet = categoryHtml.replace(/\s+/g, " ").trim().slice(0, 180);
            recordTraceEvent("nav_category_retry", {
              type: "document_get",
              url: catUrl,
              referer: origin + "/",
              status: res.status,
              htmlBytes: categoryHtml.length,
              hasSbsd: Boolean(parseSbsd(categoryHtml)),
              setCookieNames: cookieNamesFromResponse(res),
              jar: cookieTrustSnapshot(ctx.jar),
            });
            return { status: res.status, ok: categoryOk, note: `${catPath} ${categoryHtml.length}b | ${snippet}` };
          });
        }
      } catch (e) {
        steps.push({ step: "sbsd_category:error", ok: false, note: e?.message ?? String(e) });
      }
    }
    // Human dwell on the category page before clicking through to the PDP.
    // 1.5–3s is the critical gap — Akamai's risk model is sensitive to the
    // home→PDP interval being unrealistically short.
    await sleep(1500, 3000);

    // 5. Hit the PDP — this is the gated request and the real success signal.
    let pdpStatus = 0;
    let pdpHtml = "";
    {
      const pdpReferer = categoryOk ? catUrl : origin + "/";
      const pdpHeaders = navHeaders({ referer: pdpReferer, site: "same-origin" });
      dumpRequestState("pdp_get:recon", pdpUrl, pdpHeaders);
      steps.push({
        step: "pdp_get:hdrs",
        ok: true,
        note: JSON.stringify({ url: pdpUrl, headers: pdpHeaders, cookieHeader: ctx.jar.header() }),
      });
      await tStep("pdp_get", async () => {
        const res = await request(pdpUrl, { method: "GET", headers: pdpHeaders }, ctx);
        pdpStatus = res.status;
        pdpHtml = await res.text();
        const snippet = pdpHtml.replace(/\s+/g, " ").trim().slice(0, 300);
        const hasRefScript = /<script[^>]+src=["'][^"']*\?v=/i.test(pdpHtml);
        const hasRefMarker = /Reference\s*#|Access\s+Denied/i.test(pdpHtml);
        recordTraceEvent("nav_pdp", {
          type: "document_get",
          url: pdpUrl,
          referer: pdpReferer,
          status: res.status,
          htmlBytes: pdpHtml.length,
          hasSbsd: Boolean(parseSbsd(pdpHtml)),
          hasReferenceMarker: hasRefMarker,
          hasScriptWithV: hasRefScript,
          setCookieNames: cookieNamesFromResponse(res),
          jar: cookieTrustSnapshot(ctx.jar),
        });
        return {
          status: res.status,
          ok: res.status < 400,
          note: `${pdpHtml.length}b srv=${res.headers.get("server") ?? "-"} ct=${res.headers.get("content-type") ?? "-"} refMk=${hasRefMarker} refScr=${hasRefScript} | ${snippet}`,
        };
      });
      if (pdpHtml && pdpHtml.length < 10000) {
        steps.push({ step: "pdp_body_full", ok: true, note: pdpHtml });
      }
    }

    // Some Kmart 403 pages return a fresh Akamai sensor script rather than an
    // SBSD payload. Treat that as a new script body/context, post sensors for
    // the PDP page URL, then retry the PDP before moving on.
    if (pdpStatus >= 400) {
      const pdpChallengePath = findAkamaiScriptPath(pdpHtml);
      if (pdpChallengePath) {
        const pdpChallengeUrl = origin + pdpChallengePath;
        let pdpChallengeBody = "";
        await tStep("pdp_akamai_script_fetch", async () => {
          const res = await request(
            pdpChallengeUrl,
            {
              method: "GET",
              headers: {
                "user-agent": UA,
                referer: pdpUrl,
                "accept-language": ACCEPT_LANG,
                accept: "*/*",
                "sec-fetch-dest": "script",
                "sec-fetch-mode": "no-cors",
                "sec-fetch-site": "same-origin",
              },
            },
            ctx,
          );
          pdpChallengeBody = await res.text();
          return { status: res.status, ok: res.status < 400, note: `${pdpChallengeBody.length}b path=${pdpChallengePath}` };
        });
        await postAkamaiSensorRounds({
          label: "pdp_akamai_sensor",
          steps,
          tStep,
          ctx,
          jar: ctx.jar,
          pageUrl: pdpUrl,
          scriptUrl: pdpChallengeUrl,
          scriptBody: pdpChallengeBody,
          requestOrigin: origin,
          referer: pdpUrl,
          egressIp,
        });
        await sleep(450, 950);
        const pdpRetryHeaders = navHeaders({ referer: categoryOk ? catUrl : origin + "/", site: "same-origin" });
        dumpRequestState("pdp_get#akamai_retry:recon", pdpUrl, pdpRetryHeaders);
        await tStep("pdp_get#akamai_retry", async () => {
          const res = await request(pdpUrl, { method: "GET", headers: pdpRetryHeaders }, ctx);
          pdpStatus = res.status;
          pdpHtml = await res.text();
          const snippet = pdpHtml.replace(/\s+/g, " ").trim().slice(0, 300);
          return { status: res.status, ok: res.status < 400, note: `${pdpHtml.length}b | ${snippet}` };
        });
      }
    }

    // Verify the proxy session held the same egress IP from warm_home through
    // pdp_get. If the IP drifted, Akamai will hard-block because `_abck` was
    // solved on a different IP than the one making the PDP request.
    await tStep("verify_ip", async () => {
      const ipNow = await resolveEgressIp(ctx, { force: true });
      const same = ipNow && egressIp && ipNow === egressIp;
      return { ok: Boolean(same), note: `start=${egressIp ?? "?"} now=${ipNow ?? "?"} same=${Boolean(same)}` };
    });



    // 5b. SBSD challenge — the PDP response (200 OR 403/429) carries a
    //     `<script src="/path?v=<token>[&t=<token>]">` tag. Hyper docs §3.4:
    //     fetch the script, POST to /sbsd, then POST the payload to
    //     `/path?t=<t>`. Hard challenge (t present) = 1 round; passive = 2.
    if (parseSbsd(pdpHtml)) {
      await runSbsd(pdpHtml, pdpUrl, "sbsd_pdp");
      await sleep(450, 950);
      const pdp2Headers = navHeaders({ referer: categoryOk ? catUrl : origin + "/", site: "same-origin" });
      dumpRequestState("pdp_get#2:recon", pdpUrl, pdp2Headers);
      await tStep("pdp_get#2", async () => {
        const res = await request(pdpUrl, { method: "GET", headers: pdp2Headers }, ctx);
        pdpStatus = res.status;
        pdpHtml = await res.text();
        const snippet = pdpHtml.length < 1500 ? pdpHtml.replace(/\s+/g, " ").trim().slice(0, 1200) : `ok ${pdpHtml.length}b`;
        const respHeaders = {
          server: res.headers.get("server"),
          "akamai-grn": res.headers.get("akamai-grn"),
          "set-cookie-count": (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []).length,
        };
        return { status: res.status, ok: res.status < 400, note: `resp=${JSON.stringify(respHeaders)} | ${snippet}` };
      });
    } else if (pdpStatus >= 400) {
      steps.push({ step: "sbsd_missing", ok: false, note: `pdp ${pdpStatus} body had no SBSD script tag` });
    }



    // 6. Opportunistic pixel solve if the PDP carries one. Non-fatal.
    try {
      const pixel = await solveAkamaiPixel({
        jar: ctx.jar,
        pageUrl: pdpUrl,
        html: pdpHtml,
        userAgent: UA,
        ip: egressIp,
        acceptLanguage: ACCEPT_LANG,
        ctx,
      });
      if (pixel) {
        await tStep("akamai_pixel", async () => {
          const res = await request(
            pixel.postUrl,
            {
              method: "POST",
              headers: {
                "user-agent": UA,
                "content-type": "application/x-www-form-urlencoded",
                origin,
                referer: pdpUrl,
                "accept-language": ACCEPT_LANG,
              },
              body: pixel.payload,
            },
            ctx,
          );
          recordTraceEvent("akamai_pixel", {
            type: "akamai_pixel_post",
            postUrl: pixel.postUrl,
            status: res.status,
            payloadBytes: String(pixel.payload ?? "").length,
            payloadHash: hashShort(pixel.payload),
            setCookieNames: cookieNamesFromResponse(res),
            jar: cookieTrustSnapshot(ctx.jar),
          });
          return { status: res.status, note: "pixel posted" };
        });
      } else {
        steps.push({ step: "akamai_pixel", ok: true, note: "no pixel challenge" });
      }
    } catch (e) {
      steps.push({ step: "akamai_pixel", ok: false, note: e?.message ?? String(e) });
    }

    // 7. Cart steps — commercetools-style GraphQL on api.kmart.com.au.
    //    Auth is cookie-only (Akamai session from kmart.com.au). Real ops
    //    captured from DevTools: getActiveBag / createMyBag / updateMyBag.
    const gqlUrl = "https://api.kmart.com.au/gateway/graphql";
    const apiOrigin = "https://api.kmart.com.au";
    const keycodeMatch = pdpUrl.match(/-(\d{6,9})\/?(?:\?|$)/);
    const urlKeycode = task.keycode ?? keycodeMatch?.[1] ?? null;

    // SKU != URL keycode. Scrape the variant sku from the PDP HTML (Next.js
    // embeds it inside __NEXT_DATA__ / Apollo preloaded state).
    let sku = null;
    let skuSource = "none";
    if (pdpHtml) {
      const nextBlock = pdpHtml.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      const blob = nextBlock?.[1] ?? pdpHtml;
      const m1 = nextBlock && /"sku":"(\d{6,9})"/.exec(nextBlock[1]);
      const m2 = !m1 && /"sku":"(\d{6,9})"/.exec(pdpHtml);
      if (m1) { sku = m1[1]; skuSource = "__NEXT_DATA__"; }
      else if (m2) { sku = m2[1]; skuSource = "html"; }
    }
    if (!sku && urlKeycode) { sku = urlKeycode; skuSource = "url-fallback"; }
    steps.push({ step: "sku_extract", ok: Boolean(sku), note: `sku=${sku ?? "(none)"} source=${skuSource}` });
    ctx.__kmart_cart = { cartAtcOk: false, cartVerifyHasSku: false };

    const apiVisitorId = ensureKmartVisitorIdentity(ctx.jar);

    // Referer MUST be the PDP URL, not the homepage. Real Chrome fires
    // GraphQL/get-token XHRs from the product page, and Akamai Bot Manager
    // scores same-site XHRs where referer path is `/` (homepage) far lower
    // than XHRs whose referer matches the PDP the shopper is on. This was
    // the last remaining www→api asymmetry vs the HAR.
    const apiReferer = pdpUrl || (origin + "/");
    const gqlHeaders = {
      "user-agent": UA,
      "content-type": "application/json",
      accept: "*/*",
      "accept-language": ACCEPT_LANG,
      origin,
      referer: apiReferer,
      ...CHROME_CH,
      "sec-fetch-site": "same-site",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "cache-control": "no-cache",
      pragma: "no-cache",
      priority: "u=1, i",
      // Real HAR includes x-country-code on payment-adjacent GraphQL calls.
      "x-country-code": "AU",
      // Kmart's browser Apollo client stamps every GraphQL op with these
      // and x-visitor-id. Missing them is a strong "not a real browser"
      // signal to Akamai Bot Manager and correlates with cart_get 403s.
      "x-visitor-id": apiVisitorId,
      "apollographql-client-name": "kmart-web",
      "apollographql-client-version": "nx14-10200",
    };


    // New Relic RUM headers — real Kmart pages carry these on every api.*
    // GraphQL call. Akamai's Bot Manager reportedly scores requests that
    // are missing them lower on the "real browser" heuristic. Constants
    // (ac / ap / tk) come from HAR entry #368; per-request ids are freshly
    // random per call (traceparent / newrelic.id / newrelic.tr).
    const NR_AC = "1065151";
    const NR_AP = "1564950200";
    const NR_TK = "1647451";
    const randHex = (n) => {
      const bytes = new Uint8Array(n / 2);
      globalThis.crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    };
    const nrHeaders = (ap = NR_AP) => {
      const tr = randHex(32);
      const id = randHex(16);
      const ti = Date.now();
      const nrPayload = {
        v: [0, 1],
        d: { ty: "Browser", ac: NR_AC, ap, id, tr, ti, tk: NR_TK },
      };
      return {
        newrelic: Buffer.from(JSON.stringify(nrPayload)).toString("base64"),
        traceparent: `00-${tr}-${id}-01`,
        tracestate: `${NR_TK}@nr=0-1-${NR_AC}-${ap}-${id}----${ti}`,
      };
    };
    const gqlPost = async (body, traceKey = body?.operationName ?? "graphql") =>
      tracedRequest(
        traceKey,
        gqlUrl,
        {
          method: "POST",
          headers: { ...gqlHeaders, ...nrHeaders() },
          body: JSON.stringify(body),
        },
        { operationName: body?.operationName ?? null, variables: body?.variables ?? null, query: body?.query ?? null },
      );


    if (pdpStatus > 0 && pdpStatus < 400) {
      {
      // 7a. API-host bot-manager seed. Kmart's api.kmart.com.au does NOT
      //     run the full Akamai JS sensor; instead the browser hits
      //     POST /shopping-agent/v1/get-token which seeds `ak_bmsc` +
      //     `bm_sv` (Akamai Bot Manager static challenge cookies) for the
      //     api host. Parent-domain `.kmart.com.au` cookies like `_abck`
      //     and `bm_sz` — already solved on WWW — are automatically sent
      //     to api.* by the cookie jar. The previous api-host sensor
      //     solve was over-solving and overwriting the parent-domain
      //     `_abck` with an api-scoped variant that Akamai then scored
      //     against subsequent GraphQL calls (→ Access Denied on ATC).
      //
      //     Source: HAR entry #25 (real browser first request to api.*
      //     is get-token, not a sensor script).
      const sessionId = (() => {
        // Real HAR sessionId: "4tQL5VsAygaQefVIGXblCa83Avzi6XzLQs4G7-JApNU"
        // (43-char base64url of 32 random bytes). Regenerate per task so
        // sessions don't collide.
        const bytes = new Uint8Array(32);
        globalThis.crypto.getRandomValues(bytes);
        return Buffer.from(bytes).toString("base64url");
      })();
      let apiSeedOk = false;
      await tStep("api_get_token", async () => {
        const getTokenHeaders = {
          "user-agent": UA,
          accept: "*/*",
          "accept-language": ACCEPT_LANG,
          "content-type": "application/json",
          origin,
          referer: apiReferer,
          ...CHROME_CH,
          "sec-fetch-site": "same-site",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
          priority: "u=1, i",
          "x-visitor-id": apiVisitorId,
          ...nrHeaders("1834777981"),
        };
        const res = await tracedRequest(
          "seed",
          apiOrigin + "/shopping-agent/v1/get-token",
          {
            method: "POST",
            headers: getTokenHeaders,
            body: JSON.stringify({ sessionId }),
          },
          { requestBody: { sessionId } },
        );
        const bodyTxt = (await res.text().catch(() => "")).slice(0, 2000);
        const setCookieNames = cookieNamesFromResponse(res);
        try {
          const parsed = JSON.parse(bodyTxt);
          if (parsed?.token) {
            ctx.__kmart_bearer = parsed.token;
            ctx.__kmart_bearer_session = parsed.sessionId ?? sessionId;
          }
        } catch {}
        apiSeedOk = res.status < 400 && !/Missing required header|error/i.test(bodyTxt) && (ctx.jar.has("bm_sv") || ctx.jar.has("ak_bmsc") || setCookieNames.length > 0);
        return {
          status: res.status,
          ok: apiSeedOk,
          note: `visitor=${apiVisitorId} sessionId=${sessionId.slice(0, 10)}… setCookies=[${setCookieNames.join(",") || "none"}] bm_sv=${ctx.jar.has("bm_sv")} ak_bmsc=${ctx.jar.has("ak_bmsc")} bearer=${ctx.__kmart_bearer ? "yes" : "no"} body=${bodyTxt.slice(0,200)}`,
        };
      });
      if (!apiSeedOk) {
        steps.push({ step: "api_get_token:gate", ok: false, note: "stopped before cart mutation because API BotManager seed failed" });
        return { ok: false, steps, finalUrl: pdpUrl, cookies: ctx.jar.dump(), trace: traceEnabled ? requestTrace : undefined };
      }
      }





      // 7b. getActiveBag — me.activeCart may be null on first run.
      let cartId = null;
      let cartVersion = null;
      steps.push({
        step: "cart_get:hdrs",
        ok: true,
        note: JSON.stringify({ url: gqlUrl, headers: gqlHeaders, cookieHeader: ctx.jar.header() }),
      });
      await tStep("cart_get", async () => {
        const res = await gqlPost({
          operationName: "getMyActiveCart",
          variables: {},
          query:
            "query getMyActiveCart { me { activeCart { id version totalPrice { centAmount __typename } lineItems { id quantity __typename } __typename } __typename } }",
        }, "cart_get_initial");
        const txt = await res.text();
        try {
          const j = JSON.parse(txt);
          const ac = j?.data?.me?.activeCart;
          if (ac) { cartId = ac.id; cartVersion = ac.version; }
        } catch {}
        steps.push({ step: "cart_get_body_full", ok: true, note: `srv=${res.headers.get("server") ?? "-"} ct=${res.headers.get("content-type") ?? "-"} | ${txt.slice(0, 4500)}` });
        return {
          status: res.status,
          ok: res.status < 400,
          note: `${txt.length}b activeCart=${cartId ? `${cartId.slice(0, 8)} v${cartVersion}` : "null"}`,
        };
      });

      // 7c. createMyBag — only if no active cart.
      //     postcodeSelector is a JSON string per real HAR (entry #343);
      //     backend parses it server-side to seed shippingInfo. Use the
      //     profile's real postcode so downstream setShippingAddress
      //     doesn't fight the cart's stored postcode.
      const profileForCart = task.profile ?? {};
      const cartPostcode = profileForCart.zip ?? "4160";
      const cartCity = (profileForCart.city ?? "WELLINGTON POINT").toUpperCase();
      const cartState = profileForCart.province ?? "QLD";
      const postcodeSelectorJson = JSON.stringify({
        city: cartCity,
        postalCode: cartPostcode,
        state: cartState,
        country: "AU",
      });
      if (!cartId) {
        await tStep("cart_create", async () => {
          const res = await gqlPost({
            operationName: "createMyBag",
            variables: {
              draft: {
                currency: "AUD",
                country: "AU",
                shippingAddress: { country: "AU" },
                postcodeSelector: postcodeSelectorJson,
                // HAR entry #343 always sends selectedCncStoreId on cart
                // creation. Include verbatim; harmless for home delivery.
                selectedCncStoreId: "1241",
              },
            },

            query:
              "mutation createMyBag($draft: MyCartDraft!) { createMyCart(draft: $draft) { id version postcodeSelector { postalCode __typename } __typename } }",
          }, "cart_create");
          const txt = await res.text();
          try {
            const j = JSON.parse(txt);
            const c = j?.data?.createMyCart;
            if (c) { cartId = c.id; cartVersion = c.version; }
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400 && Boolean(cartId),
            note: `id=${cartId ?? "null"} v=${cartVersion ?? "?"} postcode=${cartPostcode} : ${txt.slice(0, 400)}`,
          };
        });
      }


      // 7d. updateMyBag — addLineItem(sku) + setCustomField(selectedCncStoreId).
      let cartAtcOk = false;
      let cartVerifyHasSku = false;
      if (cartId && sku) {
        const updateQuery = `mutation updateMyBag($id: String!, $version: Long!, $actions: [MyCartUpdateAction!]!) {
  updateMyCart(id: $id, version: $version, actions: $actions) {
    ...BasicBagFields
    lineItems { ...LineItemFields __typename }
    __typename
  }
}
fragment BasicBagFields on Cart {
  id version
  postcodeSelector { postalCode state city country __typename }
  totalPrice { centAmount __typename }
  shippingDiscount { FreeShippingThreshold __typename }
  __typename
}
fragment LineItemFields on LineItem {
  id name(locale: "en") quantity
  price { value { centAmount __typename } __typename }
  totalPrice { centAmount __typename }
  variant { id sku image(input: {preset: thumbnail}) imageKey attributes { name value __typename } __typename }
  custom { fields { offerId __typename } __typename }
  __typename
}`;
        // Real HAR (entries #357, #366) fires two probe reads between
        // cart_create and cart_atc — getActiveBag then getMyActiveCart —
        // before the addLineItem mutation. Skipping them changed our
        // request-cadence fingerprint enough for Akamai to score the ATC
        // as bot traffic (→ 403). Replay both.
        await tStep("cart_probe1", async () => {
          const res = await gqlPost({
            operationName: "getActiveBag",
            variables: {},
            query:
              "query getActiveBag { me { activeCart { id version lineItems { quantity __typename } __typename } __typename } }",
          }, "cart_probe_active");
          const txt = await res.text();
          return { status: res.status, ok: res.status < 400, note: `${txt.length}b` };
        });
        await tStep("cart_probe2", async () => {
          const res = await gqlPost({
            operationName: "getMyActiveCart",
            variables: {},
            query:
              "query getMyActiveCart { me { activeCart { id version totalPrice { centAmount __typename } lineItems { id quantity __typename } __typename } __typename } }",
          }, "cart_probe_full");
          const txt = await res.text();
          return { status: res.status, ok: res.status < 400, note: `${txt.length}b` };
        });

        await tStep("cart_atc", async () => {
          const res = await gqlPost({
            operationName: "updateMyBag",
            variables: {
              id: cartId,
              version: cartVersion,
              // HAR entry #368: addLineItem + setCustomField selectedCncStoreId.
              // We include the custom field verbatim — real browsers always
              // send it and the extra action is harmless for home delivery.
              actions: [
                { addLineItem: { sku, quantity: task.qty ?? 1, addToCartSource: "PDP" } },
                { setCustomField: { name: "selectedCncStoreId", value: "1241" } },
              ],
            },
            query: updateQuery,
          }, "cart_atc");

          const txt = await res.text();
          let lineCount = 0;
          let total = null;
          let hasSku = false;
          try {
            const j = JSON.parse(txt);
            const c = j?.data?.updateMyCart;
            if (c) {
              cartVersion = c.version ?? cartVersion;
              lineCount = c.lineItems?.length ?? 0;
              total = c.totalPrice?.centAmount ?? null;
              hasSku = (c.lineItems ?? []).some((li) => li.variant?.sku === sku);
            }
          } catch {}
          cartAtcOk = res.status < 400 && hasSku;
          ctx.__kmart_cart.cartAtcOk = cartAtcOk;
          return {
            status: res.status,
            ok: cartAtcOk,
            note: `sku=${sku} lines=${lineCount} total=${total} hasSku=${hasSku} : ${txt.slice(0, 500)}`,
          };
        });


        // 7e. Verify with the rich getMyActiveCart query.
        await tStep("cart_verify", async () => {
          const verifyQuery = `query getMyActiveCart {
  me {
    activeCart {
      id version
      totalPrice { centAmount __typename }
      lineItems {
        id quantity
        totalPrice { centAmount __typename }
        variant { sku __typename }
        __typename
      }
      __typename
    }
    __typename
  }
}`;
          const res = await gqlPost({
            operationName: "getMyActiveCart",
            variables: {},
            query: verifyQuery,
          }, "cart_verify");
          const txt = await res.text();
          let hasSku = false;
          let lineCount = 0;
          try {
            const j = JSON.parse(txt);
            const lis = j?.data?.me?.activeCart?.lineItems ?? [];
            lineCount = lis.length;
            hasSku = lis.some((li) => li.variant?.sku === sku);
            cartVerifyHasSku = hasSku;
            ctx.__kmart_cart.cartVerifyHasSku = cartVerifyHasSku;
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400 && hasSku,
            note: `lines=${lineCount} hasSku=${hasSku} : ${txt.slice(0, 400)}`,
          };
        });
      } else {
        steps.push({
          step: "cart_atc",
          ok: false,
          note: `skipped: cartId=${cartId ?? "null"} sku=${sku ?? "null"}`,
        });
      }

      // ===================================================================
      // 8. CHECKOUT FLOW
      //    Address → billing → Paydock card vault → create3DSToken.
      //    Stops short of placeOrder until task.placeOrder === true AND we
      //    have the final mutation captured.
      // ===================================================================
      const wantCheckout = task.checkout !== false && cartId && sku && cartAtcOk && cartVerifyHasSku;
      if (task.checkout !== false && cartId && sku && (!cartAtcOk || !cartVerifyHasSku)) {
        steps.push({
          step: "checkout_gate",
          ok: false,
          note: `stopped before address/payment because cart not verified: cartAtcOk=${cartAtcOk} cartVerifyHasSku=${cartVerifyHasSku}`,
        });
      }
      if (wantCheckout) {
        // 8a. Warm the checkout pages — establishes the referer chain that
        //     later GraphQL calls expect (some ops are referer-gated).
        let checkoutHtml = "";
        await tStep("checkout_warm", async () => {
          const r1 = await request(
            origin + "/checkout/bag",
            { method: "GET", headers: navHeaders({ referer: pdpUrl, site: "same-origin" }) },
            ctx,
          );
          const b1 = await r1.text();
          const r2 = await request(
            origin + "/checkout/delivery",
            { method: "GET", headers: navHeaders({ referer: origin + "/checkout/bag", site: "same-origin" }) },
            ctx,
          );
          const b2 = await r2.text();
          const r3 = await request(
            origin + "/checkout/payment",
            { method: "GET", headers: navHeaders({ referer: origin + "/checkout/delivery", site: "same-origin" }) },
            ctx,
          );
          checkoutHtml = await r3.text();
          return {
            status: r3.status,
            ok: r3.status < 400,
            note: `bag=${r1.status}/${b1.length}b delivery=${r2.status}/${b2.length}b payment=${r3.status}/${checkoutHtml.length}b`,
          };
        });

        // Identity + address. Prefer task.profile when supplied; otherwise fall
        // back to the same Brisbane 4001 QLD values used in the postcodeSelector
        // so pickup postcode and billing address stay consistent.
        //
        // Address shape mirrors the real HAR (Chrome DevTools capture of a
        // successful C&C checkout on 2026-07-11):
        //   setShippingAddress.address = {
        //     firstName, lastName, email, phone,
        //     streetName: "133 Allenby Rd",   ← full "<number> <street>" combined
        //     city, state, country: "AU", postalCode,
        //     company: "", deliveryInstructions: "", isAuthorisedToLeave: true,
        //     additionalAddressInfo: "{\"dpid\":null}", region: null
        //   }
        //   setBillingAddress.address = same minus deliveryInstructions/isAuthorisedToLeave
        //   addItemShippingAddress.address = {
        //     key: "storeAddress",   ← literal string, NOT the store id
        //     streetName: "C&C – No Address Specified",
        //     city, state, postalCode, country: "AU"
        //   }
        // Kmart's 3DS validator specifically requires non-empty
        // streetName/state/postalCode on both shipping and billing.
        const p = task.profile ?? {};
        const identity = {
          firstName: p.first_name ?? task.firstName ?? "Morgan",
          lastName: p.last_name ?? task.lastName ?? "Edwards",
          email: p.email ?? task.email ?? "flowgdesigns@gmail.com",
          phone: p.phone ?? task.phone ?? "0429386919",
        };
        const streetLine = ((p.address1 ?? "133 Allenby Rd").toString()).trim();
        const cncCity = p.city ?? "WELLINGTON POINT";
        const cncState = p.province ?? "QLD";
        const cncPostcode = p.zip ?? "4160";
        const cncStoreId = "1124";

        const updateNoStockQuery = `mutation updateMyBagWithoutBagStockAvailability($id: String!, $version: Long!, $actions: [MyCartUpdateAction!]!) {
  updateMyCart(id: $id, version: $version, actions: $actions) {
    id version
    totalPrice { centAmount __typename }
    shippingAddress { firstName lastName email phone streetName city state postalCode country company additionalAddressInfo region deliveryInstructions isAuthorisedToLeave __typename }
    billingAddress { firstName lastName email phone streetName city state postalCode country company additionalAddressInfo region __typename }
    itemShippingAddresses { key streetName city state postalCode country __typename }
    __typename
  }
}`;

        const shippingAddressPayload = {
          firstName: identity.firstName,
          lastName: identity.lastName,
          email: identity.email,
          phone: identity.phone,
          streetName: streetLine,
          city: cncCity,
          state: cncState,
          country: "AU",
          postalCode: cncPostcode,
          company: "",
          deliveryInstructions: "",
          isAuthorisedToLeave: true,
          additionalAddressInfo: "{\"dpid\":null}",
          region: null,
        };
        const billingAddressPayload = {
          firstName: identity.firstName,
          lastName: identity.lastName,
          email: identity.email,
          phone: identity.phone,
          streetName: streetLine,
          city: cncCity,
          state: cncState,
          country: "AU",
          postalCode: cncPostcode,
          company: "",
          additionalAddressInfo: "{\"dpid\":null}",
          region: null,
        };
        // C&C pickup address. Real HAR uses the literal key "storeAddress"
        // and a synthetic street "C&C – No Address Specified"; the store id
        // is carried separately via the selectedCncStoreId custom field.
        const storeAddress = {
          key: "storeAddress",
          streetName: "C&C – No Address Specified",
          city: cncCity,
          state: cncState,
          postalCode: cncPostcode,
          country: "AU",
        };

        await tStep("checkout_set_address", async () => {
          const res = await gqlPost({
            operationName: "updateMyBagWithoutBagStockAvailability",
            variables: {
              id: cartId,
              version: cartVersion,
              actions: [
                { setShippingAddress: { address: shippingAddressPayload } },
                { addItemShippingAddress: { address: storeAddress } },
              ],
            },
            query: updateNoStockQuery,
          }, "addr_shipping");
          const txt = await res.text();
          try {
            const j = JSON.parse(txt);
            const c = j?.data?.updateMyCart;
            if (c?.version) cartVersion = c.version;
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400,
            note: `v=${cartVersion} store=${cncStoreId} : ${txt.slice(0, 350)}`,
          };
        });

        // 8c. setShippingAddress + setBillingAddress.
        await tStep("checkout_set_billing", async () => {
          const res = await gqlPost({
            operationName: "updateMyBagWithoutBagStockAvailability",
            variables: {
              id: cartId,
              version: cartVersion,
              actions: [
                { setShippingAddress: { address: shippingAddressPayload } },
                { setBillingAddress: { address: billingAddressPayload } },
              ],
            },
            query: updateNoStockQuery,
          }, "addr_billing");
          const txt = await res.text();
          let hasBilling = false;
          let hasStreet = false;
          try {
            const j = JSON.parse(txt);
            const c = j?.data?.updateMyCart;
            if (c?.version) cartVersion = c.version;
            hasBilling = Boolean(c?.billingAddress?.email);
            hasStreet = Boolean(c?.billingAddress?.streetName && c?.billingAddress?.state && c?.billingAddress?.postalCode);
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400 && hasBilling && hasStreet,
            note: `v=${cartVersion} hasBilling=${hasBilling} hasStreet=${hasStreet} : ${txt.slice(0, 350)}`,
          };
        });

        // 8d. Refresh — snapshot version + totals before payment.
        await tStep("checkout_refresh", async () => {
          const res = await gqlPost({
            operationName: "getMyActiveBag",
            variables: {},
            query:
              "query getMyActiveBag { me { activeCart { id version totalPrice { centAmount __typename } lineItems { id quantity variant { sku __typename } __typename } billingAddress { email __typename } shippingAddress { email __typename } __typename } __typename } }",
          }, "checkout_refresh");
          const txt = await res.text();
          try {
            const j = JSON.parse(txt);
            const c = j?.data?.me?.activeCart;
            if (c?.version) cartVersion = c.version;
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400,
            note: `v=${cartVersion} : ${txt.slice(0, 300)}`,
          };
        });

        // 8e. Paydock card vault. Tokenizes the PAN → returns a UUID we feed
        //     into create3DSToken. Public key is scraped from the checkout
        //     page bundle (Paydock client SDK embeds it).
        // Prefer per-request card (sent by the control plane) over Fly env.
        // This keeps the PAN out of the executor's secret store and matches
        // the future profiles-sourced flow.
        const reqCard = task.card ?? {};
        const cardNumber = String(reqCard.number ?? process.env.KMART_CARD_NUMBER ?? "");
        const cardCcv = String(reqCard.cvv ?? process.env.KMART_CARD_CVV ?? "");
        const cardMonth = String(reqCard.expMonth ?? process.env.KMART_CARD_EXPIRY_MONTH ?? "");
        const cardYear = String(reqCard.expYear ?? process.env.KMART_CARD_EXPIRY_YEAR ?? "");
        const cardHolder = String(reqCard.holder ?? process.env.KMART_CARD_HOLDER ?? `${identity.firstName} ${identity.lastName}`);
        const paydockPublicKey =
          process.env.PAYDOCK_PUBLIC_KEY ||
          checkoutHtml.match(/"(?:publicKey|public_key|paydockPublicKey)"\s*:\s*"([^"]+)"/i)?.[1] ||
          checkoutHtml.match(/public[-_]?key["']?\s*[:=]\s*["']([a-zA-Z0-9._-]{20,})/)?.[1] ||
          "";

        // Kmart's Paydock account is configured with a single gateway named
        // "MasterCard" that processes all card brands — real HAR entry #766
        // uses gatewayType="MasterCard" even for a Visa PAN (4216 04…).
        // Deriving from BIN would send the wrong gatewayType and either 400
        // on create3DSToken or route through a gateway Kmart doesn't have
        // configured. Hardcode per HAR.
        const gatewayType = "MasterCard";


        let oneTimeToken = null;
        if (!cardNumber || !cardCcv) {
          steps.push({
            step: "paydock_tokenize",
            ok: false,
            note: "skipped: KMART_CARD_NUMBER / KMART_CARD_CVV not set",
          });
        } else {
          await tStep("paydock_tokenize", async () => {
            // Real HAR entry #764: origin/referer are widget.paydock.com,
            // NOT www.kmart.com.au. Sending the storefront origin makes
            // Paydock's CORS check reject the token as coming from an
            // unregistered caller. The widget origin is what the SDK uses
            // when it iframes into the checkout page.
            const headers = {
              "user-agent": UA,
              "content-type": "application/json",
              accept: "application/json",
              "accept-language": ACCEPT_LANG,
              origin: "https://widget.paydock.com",
              referer: "https://widget.paydock.com/",
              ...CHROME_CH,
              "sec-fetch-site": "cross-site",
              "sec-fetch-mode": "cors",
              "sec-fetch-dest": "empty",
            };
            if (paydockPublicKey) headers["x-user-public-key"] = paydockPublicKey;

            const res = await tracedRequest(
              "paydock_tokenize",
              "https://api.paydock.com/v1/payment_sources/tokens",
              {
                method: "POST",
                headers,
                body: JSON.stringify({
                  type: "card",
                  card_name: cardHolder,
                  card_number: cardNumber,
                  expire_month: cardMonth,
                  expire_year: cardYear,
                  card_ccv: cardCcv,
                  gateway_id: "",
                  store_ccv: true,
                  meta: {},
                }),
              },
            );
            const txt = await res.text();
            try {
              const j = JSON.parse(txt);
              oneTimeToken = j?.resource?.data ?? null;
            } catch {}
            return {
              status: res.status,
              ok: res.status < 400 && Boolean(oneTimeToken),
              note: `gateway=${gatewayType} pk=${paydockPublicKey ? paydockPublicKey.slice(0, 12) + "…" : "(none)"} token=${oneTimeToken ? oneTimeToken.slice(0, 12) + "…" : "null"} : ${txt.slice(0, 250)}`,
            };
          });
        }

        // 8f. create3DSToken — Kmart's payment orchestrator hands us a
        //     base64-wrapped GPayments session bundle. Query shape matches
        //     real HAR entry #766 exactly (nullable String/Boolean, not
        //     required — the required version worked but caused schema
        //     drift warnings when new optional fields were introduced).
        //
        // Response: data.create3DSToken = base64(JSON{
        //   content: "<JWT>",           ← acts as x-access-token for /process
        //   format: "standalone_3ds"
        // })
        //
        // JWT payload contains meta (base64) with everything we need:
        //   charge_3ds_id, service_type, initialization_url,
        //   authorization_url, secondary_url
        let paydockJwt = null;           // x-access-token for /process
        let charge3dsId = null;          // used by chargePayDockWithToken
        let create3dsRaw = null;
        if (oneTimeToken) {
          await tStep("create_3ds_token", async () => {
            const res = await gqlPost({
              operationName: "create3DSToken",
              variables: {
                oneTimeToken,
                gatewayType,
                useSavedCard: false,
                saveCardOption: false,
              },
              query:
                "mutation create3DSToken($oneTimeToken: String!, $gatewayType: String, $useSavedCard: Boolean, $saveCardOption: Boolean) {\n  create3DSToken(\n    oneTimeToken: $oneTimeToken\n    gatewayType: $gatewayType\n    useSavedCard: $useSavedCard\n    saveCardOption: $saveCardOption\n  )\n}\n",
            }, "create_3ds");
            const txt = await res.text();
            try {
              const j = JSON.parse(txt);
              const outerB64 = j?.data?.create3DSToken;
              if (typeof outerB64 === "string" && outerB64) {
                create3dsRaw = outerB64;
                const outer = JSON.parse(Buffer.from(outerB64, "base64").toString("utf8"));
                paydockJwt = outer?.content ?? null;
                if (paydockJwt) {
                  const parts = paydockJwt.split(".");
                  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
                  const meta = payload?.meta
                    ? JSON.parse(Buffer.from(payload.meta, "base64").toString("utf8"))
                    : {};
                  charge3dsId = meta.charge_3ds_id ?? null;
                }
              }
            } catch (e) {
              steps.push({ step: "create_3ds_token:decode", ok: false, note: e?.message ?? String(e) });
            }
            return {
              status: res.status,
              ok: res.status < 400 && Boolean(charge3dsId),
              note: `charge_3ds_id=${charge3dsId ?? "null"} jwtLen=${paydockJwt?.length ?? 0} : ${txt.slice(0, 300)}`,
            };
          });
        } else {
          steps.push({
            step: "create_3ds_token",
            ok: false,
            note: "skipped: no oneTimeToken from Paydock",
          });
        }

        // 8g. Paydock standalone-3ds handle — signals the 3DS orchestrator
        //     that the browser's 3DS-method probe didn't complete
        //     (InitAuthTimedOut). Real browsers hit this path whenever the
        //     issuer's ACS doesn't respond within the SDK timeout; the
        //     issuer then falls back to frictionless authentication or a
        //     challenge. From a headless HTTP client we can never run the
        //     3dsMethod iframe, so InitAuthTimedOut is legitimate here.
        //
        // Real HAR entry #788:
        //   POST /v1/charges/standalone-3ds/handle?x-access-token=<JWT>
        //   Content-Type: application/x-www-form-urlencoded
        //   Body: requestorTransId=<uuid>&event=InitAuthTimedOut
        //         &param=<base64(browser info JSON)>
        //   → 302 Location: widget.paydock.com/3ds/standalone-3ds?...
        //     &charge_3ds_id=<id>&info=InitAuthTimedOut
        let handleOk = false;
        if (paydockJwt && charge3dsId) {
          await tStep("paydock_3ds_handle", async () => {
            const requestorTransId = globalThis.crypto.randomUUID();
            // Browser env blob that matches HAR entry #788's decoded param.
            // Values match a real Chrome 150 / Windows viewer; only browserIP
            // is dynamic — we synthesize from the egress IP resolver.
            const browserInfo = {
              browserAcceptHeader:
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
              browserIP: egressIp || "0.0.0.0",
              browserJavaEnabled: false,
              browserLanguage: "en-GB",
              browserJavascriptEnabled: true,
              browserColorDepth: "24",
              browserScreenHeight: "864",
              browserScreenWidth: "1536",
              browserTZ: "-600",
              browserUserAgent: UA,
            };
            const param = Buffer.from(JSON.stringify(browserInfo), "utf8").toString("base64");
            const body = new URLSearchParams({
              requestorTransId,
              event: "InitAuthTimedOut",
              param,
            }).toString();
            const url = `https://api.paydock.com/v1/charges/standalone-3ds/handle?x-access-token=${encodeURIComponent(paydockJwt)}`;
            const res = await tracedRequest(
              "paydock_handle",
              url,
              {
                method: "POST",
                headers: {
                  "user-agent": UA,
                  accept: "*/*",
                  "content-type": "application/x-www-form-urlencoded",
                  origin: "https://paydock.as1.gpayments.net",
                  referer: "https://paydock.as1.gpayments.net/",
                  ...CHROME_CH,
                  "sec-fetch-site": "cross-site",
                  "sec-fetch-mode": "cors",
                  "sec-fetch-dest": "empty",
                },
                body,
              },
            );
            const loc = res.headers.get("location") ?? "";
            const idMatch = loc.match(/charge_3ds_id=([a-f0-9-]{20,})/i);
            const returnedId = idMatch?.[1] ?? null;
            handleOk = res.status >= 300 && res.status < 400 && Boolean(returnedId);
            // Trust the location's id if it disagrees with the JWT-decoded one.
            if (returnedId) charge3dsId = returnedId;
            return {
              status: res.status,
              ok: handleOk,
              note: `transId=${requestorTransId.slice(0, 8)} status=${res.status} loc=${loc.slice(0, 200)}`,
            };
          }).catch((e) => steps.push({ step: "paydock_3ds_handle:error", ok: false, note: e?.message ?? String(e) }));
        } else {
          steps.push({ step: "paydock_3ds_handle", ok: false, note: "skipped: no paydockJwt/charge3dsId from create3DSToken" });
        }

        // 8h. Paydock standalone-3ds process — completes the 3DS flow on
        //     Paydock's side. Without this, chargePayDockWithToken will
        //     reject the charge_3ds_id as "not yet processed".
        //
        // Real HAR entry #802:
        //   POST /v1/charges/standalone-3ds/process
        //   x-access-token: <JWT from create3DSToken>
        //   Body: {"charge_3ds_id": "<id>"}
        //   → 200 { resource.data.result.frictionless: true }
        let processFrictionless = false;
        let processStatus = null;
        if (paydockJwt && charge3dsId) {
          await tStep("paydock_3ds_process", async () => {
            const res = await tracedRequest(
              "paydock_process",
              "https://api.paydock.com/v1/charges/standalone-3ds/process",
              {
                method: "POST",
                headers: {
                  "user-agent": UA,
                  accept: "application/json, text/plain, */*",
                  "content-type": "application/json; charset=UTF-8",
                  "x-access-token": paydockJwt,
                  origin,
                  referer: origin + "/",
                  ...CHROME_CH,
                  "sec-fetch-site": "cross-site",
                  "sec-fetch-mode": "cors",
                  "sec-fetch-dest": "empty",
                },
                body: JSON.stringify({ charge_3ds_id: charge3dsId }),
              },
            );
            const txt = await res.text();
            try {
              const j = JSON.parse(txt);
              const result = j?.resource?.data?.result;
              processFrictionless = Boolean(result?.frictionless);
              processStatus = result?.status ?? null;
            } catch {}
            return {
              status: res.status,
              ok: res.status < 400 && processFrictionless,
              note: `frictionless=${processFrictionless} status=${processStatus} : ${txt.slice(0, 300)}`,
            };
          }).catch((e) => steps.push({ step: "paydock_3ds_process:error", ok: false, note: e?.message ?? String(e) }));
        } else {
          steps.push({ step: "paydock_3ds_process", ok: false, note: "skipped: no paydockJwt/charge3dsId" });
        }

        // 8i. Final stock-event custom field. The HAR sets `sohEvent` after
        // Paydock 3DS processing and immediately before the real order mutation.
        // Keep this in dry-run too because it is a cart-state prerequisite, not
        // the order submission itself.
        if (processFrictionless && sku) {
          await tStep("checkout_soh_event", async () => {
            const res = await gqlPost({
              operationName: "updateMyBagWithoutBagStockAvailability",
              variables: {
                id: cartId,
                version: cartVersion,
                actions: [
                  {
                    setCustomField: {
                      name: "sohEvent",
                      value: JSON.stringify({
                        poolConfig: [{ keyCode: sku, poolName: "OMFP-CONFIGURED-POOL" }],
                      }),
                    },
                  },
                ],
              },
              query: updateNoStockQuery,
            }, "soh_event");
            const txt = await res.text();
            try {
              const j = JSON.parse(txt);
              const c = j?.data?.updateMyCart;
              if (c?.version) cartVersion = c.version;
            } catch {}
            return {
              status: res.status,
              ok: res.status < 400,
              note: `v=${cartVersion} sku=${sku} : ${txt.slice(0, 260)}`,
            };
          });
        } else {
          steps.push({ step: "checkout_soh_event", ok: false, note: `skipped: processFrictionless=${processFrictionless} sku=${sku ?? "null"}` });
        }

        // 8j. chargePayDockWithToken — THE REAL PLACE-ORDER MUTATION.
        //     Real HAR entry #807 returns { orderNumber, paydockChargeId,
        //     paymentId, accountCreationStatus }. Guarded by
        //     task.placeOrder === true so the default dry-run stops here.
        let orderNumber = null;
        let orderId = null;
        let paymentStatus = null;
        if (task.placeOrder === true) {
          if (!charge3dsId) {
            steps.push({ step: "place_order", ok: false, note: "skipped: no charge_3ds_id" });
          } else if (!processFrictionless) {
            steps.push({
              step: "place_order",
              ok: false,
              note: `skipped: 3DS not frictionless (status=${processStatus}). Issuer step-up would require a real browser to complete the ACS challenge.`,
            });
          } else {
            await tStep("place_order", async () => {
              const res = await gqlPost({
                operationName: "chargePayDockWithToken",
                variables: {
                  type: "TOKEN_3DS",
                  token: charge3dsId,
                  gatewayType,
                  saveCard: false,
                  isCreateAccount: false,
                },
                query:
                  "mutation chargePayDockWithToken($type: TokenType!, $token: String!, $gatewayType: String!, $saveCard: Boolean, $isCreateAccount: Boolean) {\n  chargePayDockWithToken(\n    type: $type\n    token: $token\n    gatewayType: $gatewayType\n    saveCard: $saveCard\n    isCreateAccount: $isCreateAccount\n  ) {\n    paydockChargeId\n    paymentId\n    orderNumber\n    accountCreationStatus\n    __typename\n  }\n}\n",
              }, "place_order");
              const txt = await res.text();
              try {
                const j = JSON.parse(txt);
                const r = j?.data?.chargePayDockWithToken;
                if (r) {
                  orderNumber = r.orderNumber ?? null;
                  orderId = r.paymentId ?? r.paydockChargeId ?? null;
                  paymentStatus = orderNumber ? "captured" : (r ? "no_order" : null);
                }
              } catch {}
              return {
                status: res.status,
                ok: res.status < 400 && Boolean(orderNumber),
                note: `order=${orderNumber ?? "null"} paydockCharge=${orderId ?? "null"} : ${txt.slice(0, 400)}`,
              };
            });
          }
        } else {
          steps.push({
            step: "place_order",
            ok: true,
            note: "skipped: task.placeOrder !== true (dry-run stop)",
          });
        }

        ctx.__kmart_order = { orderNumber, orderId, paymentStatus };
      }
    }


    const orderInfo = ctx.__kmart_order ?? {};
    const cartInfo = ctx.__kmart_cart ?? {};
    return {
      ok: pdpStatus > 0 && pdpStatus < 400 && cartInfo.cartAtcOk === true && cartInfo.cartVerifyHasSku === true,
      steps,
      finalUrl: pdpUrl,
      cookies: ctx.jar.dump(),
      trace: traceEnabled ? requestTrace : undefined,
      dryRun: task.placeOrder !== true,
      orderNumber: orderInfo.orderNumber ?? null,
      orderId: orderInfo.orderId ?? null,
      paymentStatus: orderInfo.paymentStatus ?? null,
    };
  },
};
