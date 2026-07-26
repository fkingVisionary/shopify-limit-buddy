/**
 * Disney Store AU — harvest one Akamai-warm sticky session (+ optional CapSolver).
 *
 * Pattern borrowed from Toymate (serializable cookie jar + captcha TTL) rather
 * than Bandai (live Playwright F5 bridges). Disney has no F5 login tax; the
 * off-path wins are Hyper `_abck` warm + AddToCart reCAPTCHA Enterprise.
 *
 * Critical-path claim → skip warm (and CapSolver if token fresh) → ATC → GE pay.
 */

import { createJar, makeDispatcher } from "../http.js";
import {
  createDisneySession,
  DISNEY_ORIGIN,
  DISNEY_DEFAULT_PDP_PATH,
  DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
} from "./disney-session.js";
import { warmDisneyAkamai } from "./disney-akamai.js";
import {
  capsolverKey,
  solveDisneyRecaptchaEnterprise,
} from "./disney-recaptcha.js";
import { hyperConfigured } from "../antibot.js";
import { resolveEgressIp } from "../ip-resolve.js";

/** Akamai cookie usefulness window on sticky ISP (conservative). */
export const DISNEY_ABCK_TTL_MS = 3 * 60_000;
/** CapSolver / reCAPTCHA Enterprise token window. */
export const DISNEY_CAPTCHA_TTL_MS = 100_000;

function toProxyUrl(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const parts = String(raw).split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  return raw;
}

function proxyHost(raw) {
  try {
    const url = toProxyUrl(raw);
    if (url) return new URL(url).hostname;
  } catch {
    /* ignore */
  }
  return String(raw || "").split(":")[0] || null;
}

function abckValid(jar) {
  const v = jar?.get?.("_abck") || "";
  return /~0~/.test(String(v));
}

export function isDisneyHarvestFresh(session, { requireCaptcha = false } = {}) {
  if (!session || typeof session !== "object") return false;
  if (!session.cookies || typeof session.cookies !== "object") return false;
  const t = Date.now();
  if (session.abckExpiresAt != null && Number(session.abckExpiresAt) <= t) return false;
  if (requireCaptcha) {
    if (!session.captchaToken) return false;
    if (session.captchaExpiresAt != null && Number(session.captchaExpiresAt) <= t) {
      return false;
    }
  }
  const abck = session.cookies._abck || "";
  return /~0~/.test(String(abck));
}

/**
 * Mint one warm Disney session on a sticky proxy.
 * @returns {{ ok, session?, error?, ms }}
 */
export async function harvestDisneySession({
  proxyRaw,
  solveCaptcha = true,
  pdpUrl = `${DISNEY_ORIGIN}${DISNEY_DEFAULT_PDP_PATH}`,
  sitekey = DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
  maxWarmRounds,
} = {}) {
  const t0 = Date.now();
  if (!hyperConfigured()) {
    return { ok: false, error: "HYPER_API_KEY missing", ms: 0 };
  }
  const proxyUrl = toProxyUrl(proxyRaw);
  if (!proxyUrl) {
    return { ok: false, error: "proxy required (sticky AU ISP/resi)", ms: 0 };
  }

  const dispatcher = makeDispatcher(proxyUrl, { forceTls: true });
  const jar = createJar();
  const ctx = { dispatcher, jar, steps: [] };
  const session = createDisneySession(ctx, {});

  try {
    const guessed = proxyHost(proxyRaw);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(guessed || "")) {
      ctx.egressIp = guessed;
    } else {
      try {
        ctx.egressIp = await resolveEgressIp(ctx);
      } catch {
        /* optional */
      }
    }

    const warm = await warmDisneyAkamai(session, ctx, {
      egressIp: ctx.egressIp,
      maxRounds: maxWarmRounds,
    });
    if (!warm.ok || !abckValid(jar)) {
      return {
        ok: false,
        error: warm.note || "Akamai warm failed",
        ms: Date.now() - t0,
        warm,
      };
    }

    let captchaToken = null;
    let captchaNote = "skipped";
    let captchaMs = 0;
    if (solveCaptcha !== false && capsolverKey()) {
      const c0 = Date.now();
      const solved = await solveDisneyRecaptchaEnterprise({
        pageUrl: pdpUrl,
        sitekey,
        action: "AddToCart",
        proxyRaw: proxyRaw || null,
        proxyless: true,
      });
      captchaMs = Date.now() - c0;
      if (solved.ok) {
        captchaToken = solved.token;
        captchaNote = `ok via ${solved.via || "capsolver"} ${captchaMs}ms`;
      } else {
        captchaNote = solved.error || "capsolver failed";
        // Soft: warm jar still useful; checkout can mint captcha on demand.
      }
    } else if (solveCaptcha !== false) {
      captchaNote = "CAPSOLVER_API_KEY missing";
    }

    const harvestedAt = Date.now();
    const cookies = jar.dump?.() || {};
    return {
      ok: true,
      ms: Date.now() - t0,
      session: {
        id: `dhv_${harvestedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        store: "disney",
        origin: DISNEY_ORIGIN,
        proxy: String(proxyRaw).trim(),
        proxyHost: proxyHost(proxyRaw),
        userAgent: session.state.userAgent,
        cookies,
        captchaToken,
        captchaSitekey: sitekey,
        captchaAction: "AddToCart",
        pdpUrl,
        harvestedAt,
        abckExpiresAt: harvestedAt + DISNEY_ABCK_TTL_MS,
        captchaExpiresAt: captchaToken ? harvestedAt + DISNEY_CAPTCHA_TTL_MS : null,
        abckValid: true,
        abckLen: String(cookies._abck || "").length,
        warmNote: warm.note,
        captchaNote,
        captchaMs,
        egressIp: ctx.egressIp || null,
        transport: dispatcher.transport || "tls",
      },
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), ms: Date.now() - t0 };
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
  }
}

export default {
  harvestDisneySession,
  isDisneyHarvestFresh,
  DISNEY_ABCK_TTL_MS,
  DISNEY_CAPTCHA_TTL_MS,
};
