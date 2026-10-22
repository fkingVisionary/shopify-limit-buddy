/**
 * Provider-agnostic captcha / antibot solver layer for the Shopify path.
 *
 * Scope: the *pre-payment* storefront leg only (warm home, cart, checkout
 * page). It clears an interactive challenge so the HTTP chain can reach the
 * cart / checkout page — it never submits payment and never touches Shopify's
 * private checkout-completion API.
 *
 * What it does:
 *   detectChallenge(res, body) → classify Turnstile / Cloudflare-WAF /
 *     reCAPTCHA (v2/v3/enterprise) / hCaptcha / DataDome / Akamai + sitekey.
 *   solveChallenge(challenge, opts) → route to a configured provider and
 *     return { token?, cookies?, userAgent? }.
 *
 * Providers (opt-in via env keys; task.captchaProvider forces one):
 *   • 2captcha    TWOCAPTCHA_API_KEY   — reCAPTCHA / hCaptcha / Turnstile
 *   • capsolver   CAPSOLVER_API_KEY    — reCAPTCHA / hCaptcha / Turnstile / Cloudflare
 *   • uncaptcha   UNCAPTCHA_API_KEY    — Cloudflare Turnstile + WAF (uncaptcha.io)
 *   • hyper       HYPER_API_KEY        — Akamai / Incapsula / DataDome (rare for Shopify)
 *
 * IMPORTANT (Cloudflare): a cf_clearance cookie is bound to the egress IP + UA.
 * The solver MUST run through the same proxy the executor uses (pass opts.proxy)
 * and the returned userAgent MUST be reused on subsequent requests, or the
 * clearance is rejected. A hard 403 from a datacenter IP is an IP-reputation
 * block, not a solvable challenge — use a residential/ISP proxy first.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Env helpers ──────────────────────────────────────────────────────────
export const twocaptchaKey = () => String(process.env.TWOCAPTCHA_API_KEY || "").trim();
export const capsolverApiKey = () => String(process.env.CAPSOLVER_API_KEY || "").trim();
export const uncaptchaKey = () => String(process.env.UNCAPTCHA_API_KEY || "").trim();
export const hyperKey = () => String(process.env.HYPER_API_KEY || "").trim();
// Account-specific Cloudflare-WAF task string for uncaptcha.io. Varies by plan,
// so it is configured rather than guessed; unset → WAF via uncaptcha is skipped.
export const uncaptchaWafTaskType = () => String(process.env.UNCAPTCHA_WAF_TASK_TYPE || "").trim();

export function providerKeyPresent(provider) {
  switch (provider) {
    case "2captcha":
      return Boolean(twocaptchaKey());
    case "capsolver":
      return Boolean(capsolverApiKey());
    case "uncaptcha":
      return Boolean(uncaptchaKey());
    case "hyper":
      return Boolean(hyperKey());
    default:
      return false;
  }
}

export function anyProviderConfigured() {
  return ["2captcha", "capsolver", "uncaptcha", "hyper"].some(providerKeyPresent);
}

// ── Detection ──────────────────────────────────────────────────────────────

const RE = {
  turnstile: /challenges\.cloudflare\.com\/turnstile|cf-turnstile|data-sitekey="(0x[0-9a-zA-Z_-]+)"/i,
  turnstileKey: /(?:cf-turnstile[^>]*data-sitekey|data-sitekey)="(0x[0-9a-zA-Z_-]+)"/i,
  cfChallenge:
    /__cf_chl_|cf-challenge|challenge-platform|turnstile\/if\/ov2|window\._cf_chl_opt|<title>\s*(?:Just a moment|Attention Required|Access denied)/i,
  recaptchaEnterprise: /recaptcha\/enterprise\.js|grecaptcha\.enterprise/i,
  recaptcha: /www\.google\.com\/recaptcha\/|g-recaptcha|grecaptcha/i,
  recaptchaKey: /(?:data-sitekey|render=)["']?([0-9A-Za-z_-]{30,50})["']?/i,
  recaptchaV3Render: /recaptcha\/(?:api|enterprise)\.js\?render=([0-9A-Za-z_-]{30,50})/i,
  hcaptcha: /hcaptcha\.com\/1\/api\.js|h-captcha/i,
  hcaptchaKey: /(?:h-captcha[^>]*data-sitekey|data-sitekey)="([0-9a-f-]{36})"/i,
  datadome: /geo\.captcha-delivery\.com|datadome|dd\.?cid/i,
  akamai: /\/_bm\/|_abck|bm_sz|ak_bmsc/i,
};

function headerSetCookie(res) {
  try {
    return res?.headers?.getSetCookie?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * Classify a response. Returns { type, siteKey, action, scriptUrl } where type
 * is one of: turnstile | cloudflare_waf | recaptcha_v3 | recaptcha_v2 |
 * hcaptcha | datadome | akamai | none.
 */
export function detectChallenge(res, body = "", url = "") {
  const status = res?.status ?? 0;
  const html = String(body || "");
  const cookies = headerSetCookie(res).join("; ");
  const cfMitigated = /challenge/i.test(String(res?.headers?.get?.("cf-mitigated") || ""));

  // A normal 200 page frequently *references* a captcha script (the payment
  // step loads reCAPTCHA, etc.) without being gated by one. Only treat the
  // interactive types as a live challenge when the response is actually
  // blocking — otherwise we'd spuriously burn a solve on a good page.
  const blocking = status === 403 || status === 429 || status === 503 || cfMitigated;

  // Cloudflare managed / under-attack interstitial (may embed a Turnstile).
  if (cfMitigated || (blocking && RE.cfChallenge.test(html))) {
    const siteKey = html.match(RE.turnstileKey)?.[1] ?? null;
    return { type: "cloudflare_waf", siteKey, action: null, scriptUrl: null };
  }

  if (!blocking) return { type: "none", siteKey: null, action: null, scriptUrl: null };

  // Standalone Turnstile gate (blocking, but not a full CF interstitial).
  if (RE.turnstile.test(html)) {
    return { type: "turnstile", siteKey: html.match(RE.turnstileKey)?.[1] ?? null, action: null, scriptUrl: null };
  }

  if (RE.hcaptcha.test(html)) {
    return { type: "hcaptcha", siteKey: html.match(RE.hcaptchaKey)?.[1] ?? null, action: null, scriptUrl: null };
  }

  if (RE.recaptcha.test(html) || RE.recaptchaEnterprise.test(html)) {
    const v3 = html.match(RE.recaptchaV3Render);
    const siteKey = v3?.[1] ?? html.match(RE.recaptchaKey)?.[1] ?? null;
    const enterprise = RE.recaptchaEnterprise.test(html);
    return {
      type: v3 ? "recaptcha_v3" : "recaptcha_v2",
      siteKey,
      action: null,
      enterprise,
      scriptUrl: null,
    };
  }

  if (RE.datadome.test(html) || RE.datadome.test(cookies)) {
    return { type: "datadome", siteKey: null, action: null, scriptUrl: null };
  }

  if (RE.akamai.test(html) || RE.akamai.test(cookies)) {
    return { type: "akamai", siteKey: null, action: null, scriptUrl: null };
  }

  return { type: "none", siteKey: null, action: null, scriptUrl: null };
}

/** True when the response is a challenge we might be able to solve. */
export function isSolvableChallenge(challenge) {
  return challenge && challenge.type && challenge.type !== "none";
}

// ── Provider routing ─────────────────────────────────────────────────────

const PROVIDER_CAPS = {
  "2captcha": ["turnstile", "recaptcha_v2", "recaptcha_v3", "hcaptcha", "datadome"],
  capsolver: ["turnstile", "cloudflare_waf", "recaptcha_v2", "recaptcha_v3", "hcaptcha", "datadome"],
  uncaptcha: ["turnstile", "cloudflare_waf"],
  hyper: ["akamai", "datadome"],
};

// Preference order per challenge type (first configured provider wins on "auto").
const AUTO_ORDER = {
  turnstile: ["uncaptcha", "capsolver", "2captcha"],
  cloudflare_waf: ["uncaptcha", "capsolver"],
  recaptcha_v2: ["2captcha", "capsolver"],
  recaptcha_v3: ["capsolver", "2captcha"],
  hcaptcha: ["2captcha", "capsolver"],
  datadome: ["capsolver", "2captcha", "hyper"],
  akamai: ["hyper"],
};

/** Choose a provider for a challenge. `override` forces one (if it is capable + keyed). */
export function pickProvider(challengeType, override = "auto") {
  if (override && override !== "auto") {
    const capable = (PROVIDER_CAPS[override] || []).includes(challengeType);
    if (capable && providerKeyPresent(override)) return override;
    return null;
  }
  for (const p of AUTO_ORDER[challengeType] || []) {
    if (providerKeyPresent(p)) return p;
  }
  return null;
}

// ── Proxy formatting ───────────────────────────────────────────────────────

/** Parse a raw proxy into { scheme, host, port, user, pass } or null. */
export function parseProxy(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      return {
        scheme: u.protocol.replace(":", "") || "http",
        host: u.hostname,
        port: u.port || "80",
        user: u.username ? decodeURIComponent(u.username) : null,
        pass: u.password ? decodeURIComponent(u.password) : null,
      };
    }
  } catch {
    /* fall through */
  }
  const parts = s.split(":");
  if (parts.length === 2) return { scheme: "http", host: parts[0], port: parts[1], user: null, pass: null };
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    const [host, port, user, ...rest] = parts;
    return { scheme: "http", host, port, user, pass: rest.join(":") };
  }
  if (parts.length >= 4) {
    // host:port:user:pass where host may be non-numeric already handled; also user:pass:host:port
    const [user, pass, host, port] = parts;
    if (/^\d+$/.test(port)) return { scheme: "http", host, port, user, pass };
  }
  return null;
}

function proxyUrl(raw) {
  const p = parseProxy(raw);
  if (!p) return null;
  const auth = p.user ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass || "")}@` : "";
  return `${p.scheme}://${auth}${p.host}:${p.port}`;
}

// ── Shared createTask/getTaskResult poller (2captcha + capsolver share schema) ──

async function createTaskPoll({ base, clientKey, task, timeoutMs = 150_000 }) {
  const start = Date.now();
  let createRes;
  try {
    createRes = await fetch(`${base}/createTask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey, task }),
    });
  } catch (e) {
    return { ok: false, error: `createTask network: ${e?.message || e}` };
  }
  const created = await createRes.json().catch(() => ({}));
  if (created.errorId && created.errorId !== 0) {
    return { ok: false, error: `${created.errorCode || "ERROR"}: ${created.errorDescription || "create failed"}` };
  }
  const taskId = created.taskId;
  if (!taskId) return { ok: false, error: "no taskId" };

  const firstDelay = Number(process.env.CAPTCHA_FIRST_POLL_MS || 3000);
  const pollInterval = Number(process.env.CAPTCHA_POLL_MS || 2500);
  await sleep(firstDelay);
  while (Date.now() - start < timeoutMs) {
    let poll;
    try {
      const r = await fetch(`${base}/getTaskResult`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey, taskId }),
      });
      poll = await r.json().catch(() => ({}));
    } catch {
      await sleep(pollInterval);
      continue;
    }
    if (poll.errorId && poll.errorId !== 0) {
      return { ok: false, error: `${poll.errorCode || "ERROR"}: ${poll.errorDescription || "poll failed"}` };
    }
    if (poll.status === "ready") return { ok: true, solution: poll.solution || {}, elapsedMs: Date.now() - start };
    if (poll.status === "failed") return { ok: false, error: "task failed" };
    await sleep(pollInterval);
  }
  return { ok: false, error: "solver timeout" };
}

/** Normalise any provider's solution object into { token, cookies, userAgent }. */
function normalizeSolution(sol = {}) {
  const token = sol.token || sol.gRecaptchaResponse || sol.solution || null;
  const userAgent = sol.userAgent || sol.user_agent || sol.ua || null;
  let cookies = null;
  // cf_clearance can arrive as a string, a {name:value} map, or a cookie array.
  const cf = sol.cf_clearance || sol.cfClearance;
  if (cf) cookies = { cf_clearance: typeof cf === "string" ? cf : cf.value };
  if (!cookies && sol.cookies) {
    if (Array.isArray(sol.cookies)) {
      cookies = {};
      for (const c of sol.cookies) if (c?.name) cookies[c.name] = c.value;
    } else if (typeof sol.cookies === "object") {
      cookies = { ...sol.cookies };
    }
  }
  return { token, cookies, userAgent };
}

// ── Provider: capsolver / 2captcha (same schema, different base + task names) ──

function cnTaskFor(provider, challenge, { pageUrl, proxyParsed }) {
  const isCap = provider === "capsolver";
  const proxyless = !proxyParsed;
  const withProxy = (t) => {
    if (proxyParsed) {
      t.proxyType = proxyParsed.scheme.startsWith("http") ? "http" : proxyParsed.scheme;
      t.proxyAddress = proxyParsed.host;
      t.proxyPort = Number(proxyParsed.port);
      if (proxyParsed.user) {
        t.proxyLogin = proxyParsed.user;
        t.proxyPassword = proxyParsed.pass || "";
      }
    }
    return t;
  };
  const sfx = proxyless ? "Proxyless" : "";
  const capSfx = proxyless ? "ProxyLess" : "";

  switch (challenge.type) {
    case "turnstile":
      return withProxy(
        isCap
          ? { type: `AntiTurnstileTask${capSfx}`, websiteURL: pageUrl, websiteKey: challenge.siteKey }
          : { type: `TurnstileTask${sfx}`, websiteURL: pageUrl, websiteKey: challenge.siteKey },
      );
    case "cloudflare_waf":
      // Only CapSolver exposes a generic Cloudflare challenge task in this schema.
      return isCap
        ? withProxy({ type: "AntiCloudflareTask", websiteURL: pageUrl, proxy: undefined })
        : null;
    case "recaptcha_v3":
      return withProxy({
        type: isCap ? `ReCaptchaV3Task${capSfx}` : `RecaptchaV3Task${sfx}`,
        websiteURL: pageUrl,
        websiteKey: challenge.siteKey,
        pageAction: challenge.action || "verify",
        minScore: 0.7,
        isEnterprise: Boolean(challenge.enterprise),
      });
    case "recaptcha_v2":
      return withProxy({
        type: isCap ? `ReCaptchaV2Task${capSfx}` : `RecaptchaV2Task${sfx}`,
        websiteURL: pageUrl,
        websiteKey: challenge.siteKey,
        isEnterprise: Boolean(challenge.enterprise),
      });
    case "hcaptcha":
      return withProxy({
        type: isCap ? `HCaptchaTask${capSfx}` : `HCaptchaTask${sfx}`,
        websiteURL: pageUrl,
        websiteKey: challenge.siteKey,
      });
    case "datadome":
      return isCap
        ? withProxy({ type: "DatadomeSliderTask", websiteURL: pageUrl, captchaUrl: pageUrl, userAgent: undefined })
        : null;
    default:
      return null;
  }
}

async function solveViaCnSchema(provider, challenge, { pageUrl, proxy, userAgent }) {
  const base =
    provider === "capsolver"
      ? process.env.CAPSOLVER_BASE || "https://api.capsolver.com"
      : process.env.TWOCAPTCHA_BASE || "https://api.2captcha.com";
  const clientKey = provider === "capsolver" ? capsolverApiKey() : twocaptchaKey();
  if (!clientKey) return { ok: false, error: `${provider} key missing` };
  if (!challenge.siteKey && !["cloudflare_waf", "datadome"].includes(challenge.type)) {
    return { ok: false, error: `${challenge.type}: no sitekey found in page` };
  }
  const proxyParsed = parseProxy(proxy);
  const task = cnTaskFor(provider, challenge, { pageUrl, proxyParsed });
  if (!task) return { ok: false, error: `${provider} cannot solve ${challenge.type}` };
  if (userAgent && task.userAgent === undefined) task.userAgent = userAgent;
  const out = await createTaskPoll({ base, clientKey, task });
  if (!out.ok) return { ok: false, error: `${provider}: ${out.error}`, via: task.type };
  const norm = normalizeSolution(out.solution);
  if (!norm.token && !norm.cookies) return { ok: false, error: `${provider}: empty solution`, via: task.type };
  return { ok: true, ...norm, via: `${provider}:${task.type}`, elapsedMs: out.elapsedMs };
}

// ── Provider: uncaptcha.io ───────────────────────────────────────────────

async function solveViaUncaptcha(challenge, { pageUrl, proxy }) {
  const key = uncaptchaKey();
  if (!key) return { ok: false, error: "uncaptcha key missing" };

  let task_type;
  const task_data = { url: pageUrl };
  if (challenge.type === "turnstile") {
    task_type = "turnstile";
    task_data.sitekey = challenge.siteKey;
    if (challenge.action) task_data.action = challenge.action;
  } else if (challenge.type === "cloudflare_waf") {
    task_type = uncaptchaWafTaskType();
    if (!task_type) {
      return {
        ok: false,
        error: "uncaptcha WAF task_type not set (export UNCAPTCHA_WAF_TASK_TYPE=<your account's string>)",
      };
    }
  } else {
    return { ok: false, error: `uncaptcha cannot solve ${challenge.type}` };
  }
  const px = proxyUrl(proxy);
  if (px) task_data.proxy = px;

  let res;
  const endpoint = `${process.env.UNCAPTCHA_BASE || "https://api.uncaptcha.io"}/v1/task/execute`;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": key },
      body: JSON.stringify({ task_type, task_data }),
      signal: AbortSignal.timeout?.(35_000),
    });
  } catch (e) {
    return { ok: false, error: `uncaptcha network: ${e?.message || e}` };
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) {
    return { ok: false, error: `uncaptcha HTTP ${res.status}: ${j.error || j.message || "failed"}` };
  }
  const sol = j.data?.solution || j.solution || j.data || {};
  const norm = normalizeSolution(sol);
  if (!norm.token && !norm.cookies) return { ok: false, error: "uncaptcha: empty solution" };
  return { ok: true, ...norm, via: `uncaptcha:${task_type}`, elapsedMs: null };
}

// ── Provider: hyper (Akamai / Incapsula / DataDome) ──────────────────────
// Delegates to the existing antibot.js Hyper integration. Shopify is almost
// always Cloudflare, so this rarely fires — kept for the odd Akamai-fronted shop.

async function solveViaHyper(challenge, { pageUrl, jar, html, userAgent, ip, acceptLanguage, ctx, scriptUrl }) {
  const { hyperConfigured, solveAkamaiSensor } = await import("../antibot.js");
  if (!hyperConfigured()) return { ok: false, error: "HYPER_API_KEY missing" };
  if (challenge.type !== "akamai") return { ok: false, error: `hyper cannot solve ${challenge.type}` };
  try {
    // antibot.solveAkamaiSensor posts the sensor itself and upgrades _abck in the jar.
    await solveAkamaiSensor({ jar, pageUrl, scriptUrl, userAgent, ip, acceptLanguage, ctx });
    return { ok: true, token: null, cookies: null, userAgent: userAgent || null, via: "hyper:akamai" };
  } catch (e) {
    return { ok: false, error: `hyper: ${e?.message || e}` };
  }
}

/**
 * Solve a detected challenge. Returns { ok, token?, cookies?, userAgent?, via, provider, error? }.
 *
 * @param challenge  result of detectChallenge()
 * @param opts { pageUrl, proxy, provider? ("auto"), userAgent?, jar?, html?, ctx?, ip?, acceptLanguage?, scriptUrl? }
 */
export async function solveChallenge(challenge, opts = {}) {
  if (!isSolvableChallenge(challenge)) return { ok: false, error: "no challenge", provider: null };
  const provider = pickProvider(challenge.type, opts.provider || "auto");
  if (!provider) {
    return {
      ok: false,
      provider: null,
      error: `no configured solver for ${challenge.type} (set a provider key / captchaProvider)`,
    };
  }
  let out;
  if (provider === "uncaptcha") out = await solveViaUncaptcha(challenge, opts);
  else if (provider === "hyper") out = await solveViaHyper(challenge, opts);
  else out = await solveViaCnSchema(provider, challenge, opts);
  return { provider, ...out };
}

export default {
  detectChallenge,
  isSolvableChallenge,
  solveChallenge,
  pickProvider,
  anyProviderConfigured,
  providerKeyPresent,
};
