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
import { completeAcsChallenge, pickAcsEntryUrl, isUuidLike, isGpaymentsApiHost, runMethodThenHandle } from "./kmart-3ds-acs.js";

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
// CORS XHRs to api.kmart.com.au (get-token / GraphQL) only emit the low-entropy
// Client Hints trio in real Chrome (slim HAR). High-entropy hints are for
// document navigations after Accept-CH — stuffing them onto every GraphQL call
// is a bot tell and correlates with api GraphQL Access Denied while get-token
// (same host, lighter BM) still returns 200.
const CHROME_CH_XHR = {
  "sec-ch-ua": CHROME_CH["sec-ch-ua"],
  "sec-ch-ua-mobile": CHROME_CH["sec-ch-ua-mobile"],
  "sec-ch-ua-platform": CHROME_CH["sec-ch-ua-platform"],
};
// Real Chrome 133 link-click navigation header set. Notable absences:
//   - NO `cache-control` / `pragma` — those only appear on a hard reload
//     (CMD+SHIFT+R). Sending them on every nav is a strong bot signal.
//   - `priority: u=0, i` is sent on every top-level navigation.
// Paydock card vault wants MM + YY (2-digit year). UI / env may send
// "7" / "2029" / "29" — normalise before tokenize so we don't 400 on shape.
function normalizePaydockCard({ number, cvv, expMonth, expYear, holder }) {
  const pan = String(number ?? "").replace(/\s+/g, "");
  const ccv = String(cvv ?? "").trim();
  let month = String(expMonth ?? "").trim().replace(/\D/g, "");
  let year = String(expYear ?? "").trim().replace(/\D/g, "");
  if (month.length === 1) month = `0${month}`;
  if (year.length === 4) year = year.slice(-2);
  return {
    number: pan,
    cvv: ccv,
    expMonth: month,
    expYear: year,
    holder: String(holder ?? "").trim(),
    ok: pan.length >= 12 && ccv.length >= 3 && /^\d{2}$/.test(month) && /^\d{2}$/.test(year),
  };
}

// Checkout HTML / Next chunks embed the Paydock widget public key. Prefer
// env override (Fly secret) when scrape misses after a thin payment shell.
function extractPaydockPublicKey(html) {
  if (!html) return "";
  const patterns = [
    /"(?:publicKey|public_key|paydockPublicKey)"\s*:\s*"([^"]{16,})"/i,
    /public[-_]?key["']?\s*[:=]\s*["']([a-zA-Z0-9._-]{16,})/i,
    /x-user-public-key["']?\s*[:=]\s*["']([a-zA-Z0-9._-]{16,})/i,
    /paydock[\s\S]{0,80}?publicKey["']?\s*[:=]\s*["']([a-zA-Z0-9._-]{16,})/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return "";
}

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
    // Diagnostic only — does not change request behavior vs kmart-mriwd1up.
    steps.push({
      step: "proxy_config",
      ok: Boolean(ctx.dispatcher?.proxy) || !task.proxy,
      note: ctx.dispatcher?.proxy
        ? `active=true transport=${ctx.dispatcher.transport} rawLen=${ctx.dispatcher.rawProxyLen ?? String(task.proxy ?? "").length}`
        : "direct (no proxy on task — same as kmart-mriwd1up / 5:25 run)",
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
    let pdpUrl = (() => {
      const raw = String(task.storeUrl || "");
      const m = raw.match(/^(https?:\/\/[^/]+\/product\/[^/?#]*-\d{6,9})(?:\/[^?#]*)?(\?[^#]*)?/i);
      return m ? `${m[1]}/${m[2] ?? ""}` : raw;
    })();
    const resolveKmartRedirect = (location, baseUrl) => {
      if (!location) return null;
      try {
        const next = new URL(location, baseUrl);
        if (next.hostname !== "www.kmart.com.au" && next.hostname !== "kmart.com.au") return null;
        return next.href;
      } catch {
        return null;
      }
    };
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

    // Hybrid resume: Playwright (or another lane) can seed a solved jar and
    // jump straight into the GraphQL checkout chain.
    const resumeFromApi = task.resumeFrom === "api";
    // Hoisted: assigned inside the warm/PDP block (or resume path), then used
    // for SKU scrape + cart GraphQL after that block ends.
    let pdpStatus = 0;
    let pdpHtml = "";
    if (task.seedCookies && typeof task.seedCookies === "object") {
      const n = ctx.jar.load(task.seedCookies);
      steps.push({
        step: "seed_cookies",
        ok: n > 0,
        note: `loaded=${n} abckValid=${/\~0\~/.test(ctx.jar.get("_abck") ?? "")}`,
      });
    }

    if (resumeFromApi) {
      pdpStatus = 200;
      steps.push({
        step: "resume_from_api",
        ok: Boolean(ctx.jar.get("_abck")),
        note: "skipped WWW warm/sensor/PDP; continuing api GraphQL checkout with seeded cookies",
      });
    } else {

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
      // Diagnostic: homepage GET seeds Bot Manager cookies (bm_sz / ak_bmsc /
      // bm_s / bm_so / bm_ss). `_abck` is NOT expected here — Hyper's sensor
      // rounds mint it afterward (see Hyper "Getting started": POST sensor_data
      // → Set-Cookie _abck). Marking ok:false for missing _abck was a false
      // alarm that made every successful warm look like a cookie failure.
      const setCookies =
        typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      const setCookieNames = setCookies
        .map((sc) => String(sc).split(";")[0].split("=")[0].trim())
        .filter(Boolean);
      const seedOk = setCookieNames.includes("bm_sz") || ctx.jar.has("bm_sz");
      steps.push({
        step: "warm_home:cookies",
        ok: seedOk,
        note: `set-cookie count=${setCookies.length} names=[${setCookieNames.join(",")}] jar=[${Object.keys(ctx.jar.dump()).join(",")}] abckExpectedAfterSensor=${!setCookieNames.includes("_abck")}`,
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
      let sbsdRoundOk = 0;
      for (let i = 0; i < rounds; i++) {
        if (i > 0) {
          // Residential tunnels often die between SBSD POSTs; refresh the agent.
          try { await ctx.dispatcher?.resetUndici?.(); } catch { /* ignore */ }
          await sleep(400, 900);
        }
        try {
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

        });
          sbsdRoundOk++;
        } catch (e) {
          steps.push({
            step: `${label}:round#${i}:recover`,
            ok: false,
            note: `network after SBSD round — continuing (${e?.message ?? e})`,
          });
        }
      }
      // Passive SBSD wants 2 rounds, but round0 + valid _abck is enough to keep moving.
      return sbsdRoundOk > 0 || abckSolved(ctx.jar, 3);
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
    try { await ctx.dispatcher?.resetUndici?.(); } catch { /* ignore */ }
    try {
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
    } catch (e) {
      // Do not abort the adapter — PDP can still succeed with home referer.
      categoryOk = false;
      categoryHtml = "";
      steps.push({
        step: "category_browse:soft_fail",
        ok: false,
        note: `continuing to PDP despite category network error (${e?.message ?? e})`,
      });
    }

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
        let res = await request(pdpUrl, { method: "GET", headers: pdpHeaders }, ctx);
        if (res.status >= 300 && res.status < 400) {
          const redirectFrom = pdpUrl;
          const redirectTo = resolveKmartRedirect(res.headers.get("location"), redirectFrom);
          steps.push({
            step: "pdp_redirect",
            ok: Boolean(redirectTo),
            status: res.status,
            ms: 0,
            note: redirectTo ? `${redirectFrom} → ${redirectTo}` : `unfollowable location=${res.headers.get("location") ?? "(none)"}`,
          });
          if (redirectTo) {
            pdpUrl = redirectTo;
            res = await request(pdpUrl, { method: "GET", headers: navHeaders({ referer: pdpReferer, site: "same-origin" }) }, ctx);
          }
        }
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

    } // end !resumeFromApi warm/sensor/PDP block

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

    // Referer for api XHRs: PDP is the mriwd1up baseline that cleared
    // cart_get/create. Slim HAR sometimes shows `/` — kept as a fallback
    // profile below when the baseline is Access-Denied.
    const apiReferer = pdpUrl || (origin + "/");
    const homeReferer = origin + "/";

    // New Relic RUM headers — real Kmart pages carry these on every api.*
    // GraphQL call. Constants (ac / ap / tk) come from slim HAR; per-request
    // ids are freshly random per call (traceparent / newrelic.id / newrelic.tr).
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

    // Shared CORS base for api.kmart.com.au XHRs. No cache-control/pragma
    // (those are hard-reload only) and low-entropy Client Hints only.
    const apiXhrBase = (referer) => ({
      "user-agent": UA,
      accept: "*/*",
      "accept-language": ACCEPT_LANG,
      "accept-encoding": "gzip, deflate, br, zstd",
      "content-type": "application/json",
      origin,
      referer,
      ...CHROME_CH_XHR,
      "sec-fetch-site": "same-site",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      priority: "u=1, i",
    });

    // GraphQL header profiles. get-token can 200 while /gateway/graphql 403s
    // on the same jar/IP — so request shape matters more than proxy vs direct.
    // Try baseline first; on Access Denied rotate through HAR-aligned variants
    // before declaring cart dead.
    const gqlProfiles = {
      // mriwd1up: PDP referer + visitor + apollo + country (no hard-reload cache headers)
      baseline: {
        ...apiXhrBase(apiReferer),
        "x-country-code": "AU",
        "x-visitor-id": apiVisitorId,
        "apollographql-client-name": "kmart-web",
        "apollographql-client-version": "nx14-10200",
      },
      // Match get-token stamps (visitor, no apollo/country) — same host just cleared BM seed.
      seed_match: {
        ...apiXhrBase(apiReferer),
        "x-visitor-id": apiVisitorId,
      },
      // Slim HAR getMyActiveCart: homepage referer, no visitor/apollo/country.
      har_slim: {
        ...apiXhrBase(homeReferer),
      },
      // PDP + visitor without apollo client stamps.
      pdp_visitor: {
        ...apiXhrBase(apiReferer),
        "x-visitor-id": apiVisitorId,
        "x-country-code": "AU",
      },
    };
    let activeGqlProfile = "baseline";
    let gqlHeaders = gqlProfiles[activeGqlProfile];

    const gqlPost = async (body, traceKey = body?.operationName ?? "graphql", headerOverrides = null) =>
      tracedRequest(
        traceKey,
        gqlUrl,
        {
          method: "POST",
          headers: { ...gqlHeaders, ...(headerOverrides || {}), ...nrHeaders() },
          body: JSON.stringify(body),
        },
        { operationName: body?.operationName ?? null, variables: body?.variables ?? null, query: body?.query ?? null },
      );

    const isAkamaiAccessDenied = (status, txt) =>
      status === 403 && /access denied|errors\.edgesuite\.net|AkamaiGHost/i.test(String(txt ?? ""));


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
          ...apiXhrBase(apiReferer),
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
        const bodyTxt = (await res.text().catch(() => "")).slice(0, 200);
        const setCookieNames = cookieNamesFromResponse(res);
        apiSeedOk = res.status < 400 && !/Missing required header|error/i.test(bodyTxt) && (ctx.jar.has("bm_sv") || ctx.jar.has("ak_bmsc") || setCookieNames.length > 0);
        return {
          status: res.status,
          ok: apiSeedOk,
          note: `visitor=${apiVisitorId} sessionId=${sessionId.slice(0, 10)}… setCookies=[${setCookieNames.join(",") || "none"}] bm_sv=${ctx.jar.has("bm_sv")} ak_bmsc=${ctx.jar.has("ak_bmsc")} body=${bodyTxt}`,
        };
      });
      if (!apiSeedOk) {
        steps.push({ step: "api_get_token:gate", ok: false, note: "stopped before cart mutation because API BotManager seed failed" });
        return { ok: false, steps, finalUrl: pdpUrl, cookies: ctx.jar.dump(), trace: traceEnabled ? requestTrace : undefined };
      }
      }

      // 7a.1. API-host Akamai sensor — OPT-IN only (`task.apiSensor === true`).
      //
      // Slim HAR (`public/kmart-slim.har`) posts every `sensor_data` body to
      // www.kmart.com.au, never api.kmart.com.au. Real browsers seed api.* via
      // POST /shopping-agent/v1/get-token (done above), then go straight to
      // GraphQL. Posting Hyper payloads to `apiOrigin + wwwScriptPath` returns
      // 503 (run kmart-mriv5eyf) and previously false-claimed "solved" because
      // WWW `_abck` was already `~0~` / ind=0 before the failed POST.
      //
      // Keep the block for controlled experiments only.
      const apiSensorEnabled = task.apiSensor === true && Boolean(scriptPath);
      if (apiSensorEnabled) {
        const apiScriptUrl = apiOrigin + scriptPath;
        let apiCtxToken = null;
        let apiSensorSolved = false;
        for (let i = 0; i < 3; i++) {
          const beforeWwwAbck = marker(ctx.jar.get("_abck"));
          const beforeAbckRaw = ctx.jar.get("_abck") ?? "";
          let postOk = false;
          await tStep(`api_sensor#${i + 1}`, async () => {
            const r = await solveAkamaiSensor({
              jar: ctx.jar,
              pageUrl: apiReferer,
              userAgent: UA,
              ip: egressIp,
              acceptLanguage: ACCEPT_LANG,
              scriptUrl: apiScriptUrl,
              scriptBody,
              prevContext: apiCtxToken,
              version: "3",
            });
            apiCtxToken = r.context;
            const res = await request(
              apiScriptUrl,
              {
                method: "POST",
                headers: akamaiSensorHeaders({ requestOrigin: apiOrigin, referer: apiReferer }),
                body: akamaiSensorBody(r.payload),
              },
              ctx,
            );
            const body = await res.text().catch(() => "");
            const setCookieNames = cookieNamesFromResponse(res);
            const afterWwwAbck = marker(ctx.jar.get("_abck"));
            postOk = res.status < 400 && sensorBodySuccess(body) !== "false";
            return {
              status: res.status,
              ok: postOk,
              note: `apiHostSensor payload=${String(r.payload ?? "").slice(0, 2)} bodySuccess=${sensorBodySuccess(body)} setCookies=[${setCookieNames.join(",") || "none"}] wwwAbckBefore=${beforeWwwAbck} wwwAbckAfter=${afterWwwAbck} abck=${marker(ctx.jar.get("_abck"))} body=${body.replace(/\s+/g, " ").slice(0, 160)}`,
            };
          });
          // Abort on edge 5xx — the api host is not serving this script path.
          if (!postOk) {
            steps.push({
              step: "api_sensor:abort",
              ok: false,
              note: "api-host sensor POST failed (often 503); HAR never posts sensor_data to api.* — continuing to cart_get with WWW _abck + get-token seed",
            });
            break;
          }
          // Only treat as solved if this POST actually refreshed _abck (or kept
          // a valid one after a successful 2xx sensor body) — not merely because
          // WWW already had ind=0 before we touched api.*.
          const afterAbckRaw = ctx.jar.get("_abck") ?? "";
          if (postOk && abckSolved(ctx.jar, i + 1) && afterAbckRaw !== beforeAbckRaw) {
            apiSensorSolved = true;
            steps.push({ step: "api_sensor:solved", ok: true, note: `rounds=${i + 1}` });
            break;
          }
          await sleep(200, 400);
        }
        if (!apiSensorSolved) {
          steps.push({ step: "api_sensor:unsolved", ok: false, note: "api-host sensor did not refresh _abck (continuing to cart_get anyway)" });
        }
      } else {
        steps.push({
          step: "api_sensor:skipped",
          ok: true,
          note: `default-off (HAR has no api-host sensor). scriptPath=${scriptPath ?? "none"} apiSensorFlag=${task.apiSensor}`,
        });
      }







      // 7b. getActiveBag — me.activeCart may be null on first run.
      let cartId = null;
      let cartVersion = null;
      let gqlCartBlocked = false;
      // Trim hdrs note: full cookieHeader was truncating run JSON in the UI
      // right as cart steps began (seen on kmart-mriv5eyf).
      steps.push({
        step: "cart_get:hdrs",
        ok: true,
        note: JSON.stringify({
          url: gqlUrl,
          profile: activeGqlProfile,
          headerKeys: Object.keys(gqlHeaders),
          referer: gqlHeaders.referer,
          visitor: gqlHeaders["x-visitor-id"] ?? null,
          cookieNames: Object.keys(ctx.jar.dump()),
          abck: marker(ctx.jar.get("_abck")),
          bmsz: marker(ctx.jar.get("bm_sz")),
        }),
      });
      const GET_ACTIVE_CART = {
        operationName: "getMyActiveCart",
        variables: {},
        query:
          "query getMyActiveCart { me { activeCart { id version totalPrice { centAmount __typename } lineItems { id quantity __typename } __typename } __typename } }",
      };
      await tStep("cart_get", async () => {
        const res = await gqlPost(GET_ACTIVE_CART, "cart_get_initial");
        let txt = await res.text();
        try {
          const j = JSON.parse(txt);
          const ac = j?.data?.me?.activeCart;
          if (ac) { cartId = ac.id; cartVersion = ac.version; }
        } catch {}
        steps.push({ step: "cart_get_body_full", ok: true, note: `srv=${res.headers.get("server") ?? "-"} ct=${res.headers.get("content-type") ?? "-"} profile=${activeGqlProfile} | ${txt.slice(0, 4500)}` });

        // get-token 200 + GraphQL 403 on the same jar/IP ⇒ request-shape, not
        // missing rollback / proxy. Rotate HAR-aligned header profiles once.
        if (isAkamaiAccessDenied(res.status, txt)) {
          const fallbackOrder = ["seed_match", "har_slim", "pdp_visitor"];
          for (const name of fallbackOrder) {
            await sleep(250, 550);
            activeGqlProfile = name;
            gqlHeaders = gqlProfiles[name];
            const retry = await gqlPost(GET_ACTIVE_CART, `cart_get_${name}`);
            txt = await retry.text();
            cartId = null;
            cartVersion = null;
            try {
              const j = JSON.parse(txt);
              const ac = j?.data?.me?.activeCart;
              if (ac) { cartId = ac.id; cartVersion = ac.version; }
            } catch {}
            const denied = isAkamaiAccessDenied(retry.status, txt);
            steps.push({
              step: `cart_get:profile_${name}`,
              ok: !denied && retry.status < 400,
              status: retry.status,
              note: `denied=${denied} activeCart=${cartId ? `${cartId.slice(0, 8)}` : "null"} srv=${retry.headers.get("server") ?? "-"} body=${txt.slice(0, 220).replace(/\s+/g, " ")}`,
            });
            if (!denied && retry.status < 400) {
              return {
                status: retry.status,
                ok: true,
                note: `${txt.length}b activeCart=${cartId ? `${cartId.slice(0, 8)} v${cartVersion}` : "null"} profile=${activeGqlProfile}`,
              };
            }
          }
          steps.push({
            step: "cart_get:all_profiles_denied",
            ok: false,
            note: "get-token ok but every GraphQL header profile got Akamai Access Denied — try kmartMode=playwright (browser seeds api trust) rather than more adapter rollbacks",
          });
          gqlCartBlocked = true;
          return {
            status: res.status,
            ok: false,
            note: `${txt.length}b activeCart=null profile=all_denied`,
          };
        }

        return {
          status: res.status,
          ok: res.status < 400,
          note: `${txt.length}b activeCart=${cartId ? `${cartId.slice(0, 8)} v${cartVersion}` : "null"} profile=${activeGqlProfile}`,
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
      if (!cartId && gqlCartBlocked) {
        steps.push({
          step: "cart_create",
          ok: false,
          note: "skipped: GraphQL Access Denied on all header profiles (same session as successful get-token)",
        });
      } else if (!cartId) {
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
            note: `id=${cartId ?? "null"} v=${cartVersion ?? "?"} postcode=${cartPostcode} profile=${activeGqlProfile} : ${txt.slice(0, 400)}`,
          };
        });
      }


      // 7d. updateMyBag — addLineItem(sku) + setCustomField(selectedCncStoreId).
      let cartAtcOk = false;
      let cartVerifyHasSku = false;
      if (cartId && sku) {
        const updateQuery = `mutation updateMyCart($id: String!, $version: Long!, $actions: [MyCartUpdateAction!]!) {
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

        if (task.skipAtc === true) {
          steps.push({
            step: "cart_atc",
            ok: true,
            note: "skipped: task.skipAtc (browser lane already added line item)",
          });
          cartAtcOk = true;
          ctx.__kmart_cart.cartAtcOk = true;
        } else {
          // SKU is already in addLineItem — kmart-mrjovb69 denied ATC with
          // sku=43552146 in the note. Checkout_gate is Akamai on updateMyCart,
          // not a missing-SKU bug. Keep get/create on the PDP baseline profile;
          // ATC-only uses homepage referer (slim HAR) + pause + sensor refresh.
          const atcActions = [
            { addLineItem: { sku, quantity: task.qty ?? 1, addToCartSource: "PDP" } },
            { setCustomField: { name: "selectedCncStoreId", value: "1241" } },
          ];
          const atcHeaderOverrides = { referer: homeReferer };
          const atcQueryMinimal =
            "mutation updateMyCart($id: String!, $version: Long!, $actions: [MyCartUpdateAction!]!) { updateMyCart(id: $id, version: $version, actions: $actions) { id version totalPrice { centAmount __typename } lineItems { id quantity variant { sku __typename } __typename } __typename } }";

          const parseAtcResponse = (res, txt) => {
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
            } catch { /* Access Denied HTML */ }
            const denied = res.status === 403 || /Access\s+Denied/i.test(txt);
            return { lineCount, total, hasSku, denied };
          };

          const postAtc = async (stepName, queryDoc) => {
            const res = await gqlPost(
              {
                operationName: "updateMyCart",
                variables: { id: cartId, version: cartVersion, actions: atcActions },
                query: queryDoc,
              },
              stepName === "cart_atc" ? "cart_atc" : stepName,
              atcHeaderOverrides,
            );
            const txt = await res.text();
            const parsed = parseAtcResponse(res, txt);
            cartAtcOk = res.status < 400 && parsed.hasSku;
            ctx.__kmart_cart.cartAtcOk = cartAtcOk;
            return {
              status: res.status,
              ok: cartAtcOk,
              note: `sku=${sku} lines=${parsed.lineCount} total=${parsed.total} hasSku=${parsed.hasSku} denied=${parsed.denied} ref=home : ${txt.slice(0, 500)}`,
              _denied: parsed.denied,
            };
          };

          // Human gap before addLineItem — back-to-back ATC denied in ~30ms on
          // kmart-mriwd1up / kmart-mrjovb69.
          await sleep(900, 2200);

          let atcDenied = false;
          await tStep("cart_atc", async () => {
            const out = await postAtc("cart_atc", updateQuery);
            atcDenied = Boolean(out._denied);
            return out;
          });

          if (!cartAtcOk && atcDenied && scriptPath && scriptBody) {
            steps.push({
              step: "cart_atc:denied",
              ok: false,
              note: "updateMyCart Access Denied — refreshing WWW sensor then retrying ATC once (minimal query, homepage referer)",
            });
            const wwwScriptUrl = origin + scriptPath;
            let sensorCtx = prevContext;
            for (let i = 0; i < 2; i++) {
              try {
                await tStep(`cart_atc:sensor#${i + 1}`, async () => {
                  const r = await solveAkamaiSensor({
                    jar: ctx.jar,
                    pageUrl: origin + "/",
                    userAgent: UA,
                    ip: egressIp,
                    acceptLanguage: ACCEPT_LANG,
                    scriptUrl: wwwScriptUrl,
                    scriptBody: i === 0 ? scriptBody : "",
                    prevContext: sensorCtx,
                    version: "3",
                  });
                  sensorCtx = r.context;
                  prevContext = r.context;
                  const res = await request(
                    wwwScriptUrl,
                    {
                      method: "POST",
                      headers: akamaiSensorHeaders({ requestOrigin: origin, referer: origin + "/" }),
                      body: akamaiSensorBody(r.payload),
                    },
                    ctx,
                  );
                  const body = await res.text().catch(() => "");
                  return {
                    status: res.status,
                    ok: res.status < 400 && sensorBodySuccess(body) !== "false",
                    note: `abck=${marker(ctx.jar.get("_abck"))} setCookies=[${cookieNamesFromResponse(res).join(",") || "none"}] bodySuccess=${sensorBodySuccess(body)}`,
                  };
                });
                if (abckSolved(ctx.jar, i + 1)) break;
                await sleep(200, 400);
              } catch (e) {
                steps.push({ step: `cart_atc:sensor#${i + 1}:error`, ok: false, note: e?.message ?? String(e) });
                break;
              }
            }
            await sleep(700, 1600);
            await tStep("cart_atc#2", async () => postAtc("cart_atc#2", atcQueryMinimal));
          } else if (!cartAtcOk && atcDenied) {
            steps.push({
              step: "cart_atc:denied",
              ok: false,
              note: "updateMyCart Access Denied but no WWW script cached for sensor refresh",
            });
          }

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

          // Soft recover only when ATC was not Akamai-denied (version skew /
          // empty cart after a 200). After Access Denied we already retried.
          if (!cartVerifyHasSku && cartId && sku && !atcDenied) {
            steps.push({
              step: "cart_verify_miss",
              ok: false,
              note: "activeCart missing SKU after verify — forcing GraphQL ATC recovery (minimal query)",
            });
            await tStep("cart_atc_recover", async () => postAtc("cart_atc_recover", atcQueryMinimal));
            if (cartAtcOk) {
              cartVerifyHasSku = true;
              ctx.__kmart_cart.cartVerifyHasSku = true;
            }
          } else if (!cartVerifyHasSku && atcDenied) {
            steps.push({
              step: "cart_verify_miss",
              ok: false,
              note: "skipped recover after Akamai ATC deny (already retried as cart_atc#2) — SKU was in the mutation; edge blocked updateMyCart",
            });
          }
        }

      } else {
        steps.push({
          step: "cart_atc",
          ok: false,
          note: `skipped: cartId=${cartId ?? "null"} sku=${sku ?? "null"}`,
        });
      }

      // ===================================================================
      // 8. CHECKOUT FLOW
      //    Address → billing → Paydock card vault → create3DSToken →
      //    3DS handle/process → chargePayDockWithToken.
      //    Stops short of placeOrder until task.placeOrder === true AND
      //    Paydock process returns frictionless (issuer step-up needs ACS).
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
        const cardNorm = normalizePaydockCard({
          number: reqCard.number ?? process.env.KMART_CARD_NUMBER ?? "",
          cvv: reqCard.cvv ?? process.env.KMART_CARD_CVV ?? "",
          expMonth: reqCard.expMonth ?? process.env.KMART_CARD_EXPIRY_MONTH ?? "",
          expYear: reqCard.expYear ?? process.env.KMART_CARD_EXPIRY_YEAR ?? "",
          holder:
            reqCard.holder ??
            process.env.KMART_CARD_HOLDER ??
            `${identity.firstName} ${identity.lastName}`,
        });
        const { number: cardNumber, cvv: cardCcv, expMonth: cardMonth, expYear: cardYear, holder: cardHolder } =
          cardNorm;

        let paydockPublicKey = process.env.PAYDOCK_PUBLIC_KEY || extractPaydockPublicKey(checkoutHtml);
        // Payment shell is often a thin Next document; public key lives in a
        // deferred chunk. Pull a couple of likely scripts when scrape misses.
        if (!paydockPublicKey && checkoutHtml) {
          const scriptHrefs = [
            ...checkoutHtml.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g),
          ]
            .map((m) => m[1])
            .filter((p) => /paydock|payment|checkout|chunk/i.test(p) || p.includes("/chunks/"))
            .slice(0, 8);
          for (const href of scriptHrefs) {
            try {
              const sr = await request(
                origin + href,
                {
                  method: "GET",
                  headers: {
                    "user-agent": UA,
                    accept: "*/*",
                    "accept-language": ACCEPT_LANG,
                    referer: origin + "/checkout/payment",
                    ...CHROME_CH_XHR,
                    "sec-fetch-site": "same-origin",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-dest": "script",
                  },
                },
                ctx,
              );
              const body = await sr.text();
              paydockPublicKey = extractPaydockPublicKey(body);
              if (paydockPublicKey) {
                steps.push({
                  step: "paydock_pk_script",
                  ok: true,
                  note: `pk from ${href.slice(0, 80)}…`,
                });
                break;
              }
            } catch {}
          }
        }
        steps.push({
          step: "paydock_pk",
          ok: Boolean(paydockPublicKey),
          note: paydockPublicKey
            ? `pk=${paydockPublicKey.slice(0, 12)}… source=${process.env.PAYDOCK_PUBLIC_KEY ? "env" : "scrape"}`
            : "missing — set PAYDOCK_PUBLIC_KEY on Fly or ensure /checkout/payment embeds the widget key",
        });

        // Kmart's Paydock account is configured with a single gateway named
        // "MasterCard" that processes all card brands — real HAR entry #766
        // uses gatewayType="MasterCard" even for a Visa PAN (4216 04…).
        // Deriving from BIN would send the wrong gatewayType and either 400
        // on create3DSToken or route through a gateway Kmart doesn't have
        // configured. Hardcode per HAR.
        const gatewayType = "MasterCard";

        if (task.placeOrder === true && !cardNorm.ok) {
          steps.push({
            step: "place_order_gate",
            ok: false,
            note: "placeOrder=true but card incomplete (need number+cvv+MM+YY). Fill the test card panel or set KMART_CARD_*.",
          });
        }

        let oneTimeToken = null;
        if (!cardNorm.ok) {
          steps.push({
            step: "paydock_tokenize",
            ok: false,
            note: cardNumber && cardCcv
              ? `skipped: card expiry shape invalid after normalize (mm=${cardMonth || "?"} yy=${cardYear || "?"})`
              : "skipped: no card on task and KMART_CARD_NUMBER / KMART_CARD_CVV unset — paste a test card in the Kmart UI profile panel",
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
              note: `gateway=${gatewayType} mm=${cardMonth} yy=${cardYear} last4=${cardNumber.slice(-4)} pk=${paydockPublicKey ? paydockPublicKey.slice(0, 12) + "…" : "(none)"} token=${oneTimeToken ? oneTimeToken.slice(0, 12) + "…" : "null"} : ${txt.slice(0, 250)}`,
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
        let threeDsInitUrl = null;
        let threeDsSecondaryUrl = null;
        let threeDsAuthUrl = null;
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
                  threeDsInitUrl = meta.initialization_url ?? null;
                  threeDsSecondaryUrl = meta.secondary_url ?? null;
                  threeDsAuthUrl = meta.authorization_url ?? null;
                }
              }
            } catch (e) {
              steps.push({ step: "create_3ds_token:decode", ok: false, note: e?.message ?? String(e) });
            }
            return {
              status: res.status,
              ok: res.status < 400 && Boolean(charge3dsId),
              note: `charge_3ds_id=${charge3dsId ?? "null"} jwtLen=${paydockJwt?.length ?? 0} init=${Boolean(threeDsInitUrl)} secondary=${Boolean(threeDsSecondaryUrl)} : ${txt.slice(0, 300)}`,
            };
          });
        } else {
          steps.push({
            step: "create_3ds_token",
            ok: false,
            note: "skipped: no oneTimeToken from Paydock",
          });
        }

        // 8f2. GPayments 3DS Method + monitor iframes. Real browsers load
        //     secondary_url (monitor) and initialization_url (method) before
        //     posting InitAuthTimedOut. Skipping these hurts frictionless
        //     rates — issuers never see the method probe.
        if (paydockJwt && charge3dsId && (threeDsSecondaryUrl || threeDsInitUrl)) {
          await tStep("paydock_3ds_init", async () => {
            const hits = [];
            for (const [label, url] of [
              ["secondary", threeDsSecondaryUrl],
              ["initialization", threeDsInitUrl],
            ]) {
              if (!url) continue;
              try {
                const res = await tracedRequest(
                  `paydock_3ds_${label}`,
                  url,
                  {
                    method: "GET",
                    headers: {
                      "user-agent": UA,
                      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                      "accept-language": ACCEPT_LANG,
                      "upgrade-insecure-requests": "1",
                      ...CHROME_CH,
                      "sec-fetch-site": "cross-site",
                      "sec-fetch-mode": "navigate",
                      "sec-fetch-dest": "iframe",
                      referer: origin + "/checkout/payment",
                    },
                  },
                );
                hits.push(`${label}=${res.status}`);
                // Drain body so undici/connection reuse stays clean.
                await res.text().catch(() => "");
              } catch (e) {
                hits.push(`${label}=err:${e?.message ?? e}`);
              }
              await sleep(80, 220);
            }
            return {
              status: 200,
              ok: hits.some((h) => /=\d{3}$/.test(h) && !h.includes("=err")),
              note: hits.join(" ") || "no urls",
            };
          }).catch((e) => steps.push({ step: "paydock_3ds_init:error", ok: false, note: e?.message ?? String(e) }));
        } else if (paydockJwt && charge3dsId) {
          steps.push({
            step: "paydock_3ds_init",
            ok: false,
            note: "skipped: JWT meta missing initialization_url/secondary_url",
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
        // 8g/8h0. 3DS Method iframes + InitAuthTimedOut handle in ONE Playwright
        //     session (Paydock SDK order). Undici-only handle was 403'ing and we
        //     then still burned 120s on ACS with no Revolut push.
        let handleOk = false;
        let handleLocation = null;
        if (paydockJwt && charge3dsId && task.acsChallenge !== false) {
          await tStep("paydock_3ds_method", async () => {
            const method = await runMethodThenHandle({
              initializationUrl: threeDsInitUrl,
              secondaryUrl: threeDsSecondaryUrl,
              paydockJwt,
              charge3dsId,
              egressIp,
              userAgent: UA,
              proxy: task.proxy ?? null,
              methodWaitMs: 10_000,
              storeOrigin: origin,
            });
            handleOk = method.ok;
            handleLocation = method.handleLocation || null;
            if (method.returnedCharge3dsId) charge3dsId = method.returnedCharge3dsId;
            return {
              status: method.handleStatus || (method.ok ? 200 : 500),
              ok: method.ok || Boolean(threeDsInitUrl),
              note: method.note,
            };
          }).catch((e) => steps.push({ step: "paydock_3ds_method:error", ok: false, note: e?.message ?? String(e) }));

          steps.push({
            step: "paydock_3ds_handle",
            ok: handleOk,
            note: handleOk
              ? `ok via browser method+handle loc=${String(handleLocation || "").slice(0, 120)}`
              : "browser handle did not return 2xx/3xx — process may ValidationError; will fail fast (no 2min ACS hang)",
          });
        } else if (paydockJwt && charge3dsId) {
          steps.push({ step: "paydock_3ds_method", ok: false, note: "skipped: task.acsChallenge===false" });
        } else {
          steps.push({ step: "paydock_3ds_handle", ok: false, note: "skipped: no paydockJwt/charge3dsId from create3DSToken" });
        }

        // 8h. Paydock standalone-3ds process.
        let processFrictionless = false;
        let processStatus = null;
        let processRawNote = "";
        let processHttpStatus = null;
        let challengeAcsUrl = threeDsAuthUrl;
        let processChallengeUrl = null;
        let processSecondaryUrl = threeDsSecondaryUrl;
        let processDecoupled = false;
        let processValidationError = false;
        let acsOk = false;
        let acsCertError = false;

        const runPaydockProcess = async (label) => {
          if (!isUuidLike(charge3dsId)) {
            return {
              status: 0,
              ok: false,
              frictionless: false,
              processStatus: null,
              acsFromBody: null,
              challengeUrl: null,
              secondaryUrl: null,
              decoupled: false,
              validationError: true,
              txt: "",
              note: `refusing process: charge3dsId not UUID (len=${String(charge3dsId ?? "").length})`,
            };
          }
          const res = await tracedRequest(
            label,
            "https://api.paydock.com/v1/charges/standalone-3ds/process",
            {
              method: "POST",
              headers: {
                "user-agent": UA,
                accept: "application/json, text/plain, */*",
                "content-type": "application/json; charset=UTF-8",
                "x-access-token": paydockJwt,
                origin,
                referer: origin + "/checkout/payment",
                ...CHROME_CH,
                "sec-fetch-site": "cross-site",
                "sec-fetch-mode": "cors",
                "sec-fetch-dest": "empty",
              },
              body: JSON.stringify({ charge_3ds_id: String(charge3dsId) }),
            },
          );
          const txt = await res.text();
          let frictionless = false;
          let status = null;
          let acsFromBody = null;
          let challengeUrl = null;
          let secondaryUrl = null;
          let decoupled = false;
          let validationError = null;
          try {
            const j = JSON.parse(txt);
            if (j?.error?.code === "ValidationError") validationError = j.error;
            const data = j?.resource?.data ?? {};
            const result = data?.result ?? data;
            status = result?.status ?? data?.status ?? result?.authentication_status ?? null;
            acsFromBody =
              result?.redirect_url || result?.acs_url || result?.authorization_url || data?.redirect_url || data?.acs_url || null;
            challengeUrl = result?.challenge_url || null;
            if (result?.challenge && typeof result.challenge === "string" && /^https?:/i.test(result.challenge)) {
              challengeUrl = result.challenge;
            }
            // Paydock sometimes sets challenge:true with challenge_url alongside.
            if (!challengeUrl && result?.challenge === true && result?.challenge_url) {
              challengeUrl = result.challenge_url;
            }
            secondaryUrl = result?.secondary_url || null;
            decoupled = Boolean(result?.decoupled_challenge);
            if (result?.frictionless === true || String(status).toLowerCase() === "success") {
              frictionless = true;
            } else if (
              result?.frictionless !== false &&
              /^(authenticated|complete|success|approved)$/i.test(String(status ?? ""))
            ) {
              frictionless = true;
            }
          } catch {}
          let challengeHost = "";
          try {
            if (challengeUrl) challengeHost = new URL(challengeUrl).hostname;
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400 && frictionless,
            frictionless,
            processStatus: status,
            acsFromBody,
            challengeUrl,
            secondaryUrl,
            decoupled,
            validationError: Boolean(validationError),
            txt,
            note: validationError
              ? `validation=${validationError.code} path=${validationError.details?.path ?? "?"} : ${txt.slice(0, 280)}`
              : `frictionless=${frictionless} status=${status} decoupled=${decoupled} challenge=${Boolean(challengeUrl)} host=${challengeHost || "-"} pending=${String(status).toLowerCase() === "pending"} id=${String(charge3dsId).slice(0, 8)}… : ${txt.slice(0, 200)}`,
          };
        };

        if (paydockJwt && charge3dsId) {
          await tStep("paydock_3ds_process", async () => {
            const out = await runPaydockProcess("paydock_process");
            processFrictionless = out.frictionless;
            processStatus = out.processStatus;
            processRawNote = out.note;
            processHttpStatus = out.status;
            processDecoupled = out.decoupled;
            processValidationError = out.validationError;
            if (out.acsFromBody) challengeAcsUrl = out.acsFromBody;
            if (out.challengeUrl) processChallengeUrl = out.challengeUrl;
            if (out.secondaryUrl) processSecondaryUrl = out.secondaryUrl;
            return { status: out.status, ok: out.ok, note: out.note };
          }).catch((e) => steps.push({ step: "paydock_3ds_process:error", ok: false, note: e?.message ?? String(e) }));
        } else {
          steps.push({ step: "paydock_3ds_process", ok: false, note: "skipped: no paydockJwt/charge3dsId" });
        }

        // ONLY wait for Revolut/bank when process says pending + decoupled/challenge.
        // Blind waits (old bug) hung Railway for minutes → UI "failed to fetch", no push.
        const processPending = String(processStatus || "").toLowerCase() === "pending";
        const acsPick = pickAcsEntryUrl({
          handleLocation,
          authorizationUrl: processChallengeUrl || challengeAcsUrl || threeDsAuthUrl,
          charge3dsId,
          paydockJwt,
        });
        const wantAcs =
          !processFrictionless &&
          task.acsChallenge !== false &&
          !processValidationError &&
          processHttpStatus !== 400 &&
          (processDecoupled || Boolean(processChallengeUrl) || processPending);

        if (wantAcs) {
          const acsTimeoutMs = Math.min(Math.max(Number(task.acsTimeoutMs) || 75_000, 30_000), 90_000);
          const acsMode = processDecoupled ? "decoupled" : processChallengeUrl ? "challenge" : "decoupled";
          await tStep("paydock_3ds_acs", async () => {
            steps.push({
              step: "paydock_3ds_acs:hint",
              ok: true,
              note:
                acsMode === "challenge"
                  ? `Challenge iframe loading — approve in Revolut/bank app if prompted (~${Math.round(acsTimeoutMs / 1000)}s). Do not re-call /process until AuthResultReady.`
                  : `Decoupled — approve Revolut/bank app push NOW (~${Math.round(acsTimeoutMs / 1000)}s)`,
            });
            const acs = await completeAcsChallenge({
              mode: acsMode,
              secondaryUrl: processSecondaryUrl || threeDsSecondaryUrl,
              // Load challenge_url even on GPayments API hosts (SDK does this in an iframe).
              challengeUrl: processChallengeUrl || null,
              authorizationUrl: null,
              proxy: task.proxy ?? null,
              timeoutMs: acsTimeoutMs,
              referer: origin + "/checkout/payment",
              paydockJwt,
              // ONLY poll /process for decoupled. Challenge must wait on secondary AuthResultReady.
              pollProcess:
                acsMode === "decoupled"
                  ? async () => {
                      const out = await runPaydockProcess("paydock_process_poll");
                      processFrictionless = out.frictionless || processFrictionless;
                      processStatus = out.processStatus ?? processStatus;
                      processRawNote = out.note;
                      processHttpStatus = out.status;
                      processValidationError = out.validationError || processValidationError;
                      if (out.decoupled) processDecoupled = true;
                      if (out.challengeUrl) processChallengeUrl = out.challengeUrl;
                      if (out.secondaryUrl) processSecondaryUrl = out.secondaryUrl;
                      return out;
                    }
                  : null,
            });
            acsOk = acs.ok || processFrictionless || acs.authReady === true;
            acsCertError = Boolean(acs.certError);
            return {
              status: acsOk ? 200 : acs.certError ? 495 : 408,
              ok: acsOk,
              note: `${acs.note} mode=${acsMode} challengeHost=${acs.challengeHost || "?"} loaded=${acs.challengeLoadOk ?? "n/a"}`,
            };
          }).catch((e) => steps.push({ step: "paydock_3ds_acs:error", ok: false, note: e?.message ?? String(e) }));

          if (acsOk && !processFrictionless) {
            await tStep("paydock_3ds_process#2", async () => {
              const out = await runPaydockProcess("paydock_process_after_acs");
              processFrictionless = out.frictionless;
              processStatus = out.processStatus;
              processRawNote = out.note;
              processHttpStatus = out.status;
              return { status: out.status, ok: out.ok, note: out.note };
            }).catch((e) =>
              steps.push({ step: "paydock_3ds_process#2:error", ok: false, note: e?.message ?? String(e) }),
            );
          } else if (processFrictionless) {
            steps.push({ step: "paydock_3ds_process#2", ok: true, note: "skipped: already authenticated" });
          } else {
            steps.push({
              step: "paydock_3ds_process#2",
              ok: false,
              note: acsCertError
                ? "skipped: challenge TLS/client-cert failure"
                : "skipped: ACS did not reach AuthResultReady — calling /process now would token_inactive",
            });
          }
        } else if (!processFrictionless && paydockJwt && charge3dsId) {
          steps.push({
            step: "paydock_3ds_acs",
            ok: false,
            note: processValidationError || processHttpStatus === 400
              ? `skipped fail-fast: process invalid (status=${processHttpStatus}). ${String(processRawNote).slice(0, 160)}`
              : `skipped: process not pending/decoupled/challenge (status=${processStatus}). ${String(processRawNote).slice(0, 120)}`,
          });
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
              note: acsCertError
                ? "skipped: GPayments API host needs client TLS cert — use method+decoupled flow"
                : processValidationError
                  ? "skipped: 3DS session never established (process ValidationError) — Revolut will not ping"
                  : `skipped: 3DS not authenticated (status=${processStatus}, decoupled=${processDecoupled}).`,
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
            note: "skipped: task.placeOrder !== true (dry-run stop) — toggle Attempt real place order + fill card to charge",
          });
        }

        const paymentSummary = {
          card: cardNorm.ok ? `last4=${cardNumber.slice(-4)} mm=${cardMonth} yy=${cardYear}` : "missing",
          paydockPk: Boolean(paydockPublicKey),
          oneTimeToken: Boolean(oneTimeToken),
          charge3dsId: charge3dsId ? charge3dsId.slice(0, 8) + "…" : null,
          frictionless: processFrictionless,
          processStatus,
          acsAttempted: wantAcs === true,
          acsOk,
          acsCertError,
          acsSource: wantAcs ? acsPick.source : null,
          decoupled: processDecoupled,
          processValidationError,
          processHttpStatus,
          acsUrl: Boolean(acsPick.url || challengeAcsUrl || processChallengeUrl),
          placeOrder: task.placeOrder === true,
          orderNumber,
          paymentStatus,
        };
        steps.push({
          step: "payment_summary",
          ok: Boolean(orderNumber) || (task.placeOrder !== true && processFrictionless),
          note: JSON.stringify(paymentSummary),
        });

        ctx.__kmart_order = { orderNumber, orderId, paymentStatus, paymentSummary };
      }
    }


    const orderInfo = ctx.__kmart_order ?? {};
    const cartInfo = ctx.__kmart_cart ?? {};
    const paymentStepNames = new Set([
      "paydock_pk",
      "paydock_pk_script",
      "place_order_gate",
      "paydock_tokenize",
      "create_3ds_token",
      "paydock_3ds_init",
      "paydock_3ds_method",
      "paydock_3ds_handle",
      "paydock_3ds_process",
      "paydock_3ds_acs",
      "paydock_3ds_acs:hint",
      "paydock_3ds_process#2",
      "checkout_soh_event",
      "place_order",
      "payment_summary",
    ]);
    const paymentTail = steps
      .filter((s) => paymentStepNames.has(s.step) || String(s.step).startsWith("paydock_"))
      .map((s) => ({
        step: s.step,
        ok: s.ok,
        status: s.status ?? null,
        note: String(s.note ?? "").slice(0, 220),
      }));
    const lastSteps = steps.slice(-12).map((s) => ({
      step: s.step,
      ok: s.ok,
      status: s.status ?? null,
      note: String(s.note ?? "").slice(0, 180),
    }));
    let checkoutStage = "pre_cart";
    if (orderInfo.orderNumber) checkoutStage = "ordered";
    else if (paymentTail.some((s) => s.step === "place_order")) checkoutStage = "place_order";
    else if (paymentTail.some((s) => s.step.startsWith("paydock_3ds") || s.step === "create_3ds_token")) checkoutStage = "3ds";
    else if (paymentTail.some((s) => s.step === "paydock_tokenize")) checkoutStage = "tokenize";
    else if (steps.some((s) => s.step === "checkout_set_billing" && s.ok)) checkoutStage = "billing";
    else if (steps.some((s) => s.step === "checkout_set_address" && s.ok)) checkoutStage = "address";
    else if (cartInfo.cartVerifyHasSku) checkoutStage = "cart_verified";
    else if (cartInfo.cartAtcOk) checkoutStage = "cart_atc";

    return {
      ok: pdpStatus > 0 && pdpStatus < 400 && cartInfo.cartAtcOk === true && cartInfo.cartVerifyHasSku === true,
      steps,
      // Compact fields first so truncated JSON pastes still show the payment answer.
      checkoutStage,
      paymentSummary: orderInfo.paymentSummary ?? null,
      paymentTail,
      lastSteps,
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
