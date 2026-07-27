/**
 * Pokémon Centre AU — harvest one Incapsula+DataDome warm sticky session
 * (+ optional CapSolver hCaptcha).
 *
 * Disney/Toymate-shaped: serializable cookie jar + TTL (not Bandai live F5 bridges).
 * Claim at Autocheckout → skip edge warm on critical path → Cortex ATC → GE pay
 * on the SAME sticky exit (IP-bound queue + jar).
 *
 * PC carts do NOT hold ~30 min — harvest buys edge-clear time only.
 */

import { createJar, makeDispatcher, makeRemoteTlsDispatcher } from "../http.js";
import { createPcSession, PC_ORIGIN } from "./pokemoncentre-session.js";
import { warmPokemonCentre } from "./pokemoncentre-edge.js";
import {
  capsolverKey,
  extractHcaptchaSitekey,
  looksLikeHcaptcha,
  solveHcaptcha,
} from "./pokemoncentre-hcaptcha.js";
import { hyperConfigured } from "../antibot.js";
import { resolveEgressIp } from "../ip-resolve.js";
import {
  isPcHarvestFresh,
  PC_EDGE_TTL_MS,
  PC_HCAPTCHA_TTL_MS,
} from "./pokemoncentre-harvest-fresh.js";

export { isPcHarvestFresh, PC_EDGE_TTL_MS, PC_HCAPTCHA_TTL_MS };

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

/**
 * Mint one warm PC edge session on a sticky proxy (tls-worker preferred).
 * @returns {{ ok, session?, error?, ms }}
 */
export async function harvestPokemonCentreSession({
  proxyRaw,
  solveCaptcha = false,
  locale = "en-au",
  pageUrl,
  transport = "tls-worker",
} = {}) {
  const t0 = Date.now();
  if (!hyperConfigured()) {
    return { ok: false, error: "HYPER_API_KEY missing", ms: 0 };
  }
  const proxyUrl = toProxyUrl(proxyRaw);
  if (!proxyUrl) {
    return { ok: false, error: "proxy required (sticky AU ISP/resi)", ms: 0 };
  }

  const useTlsWorker = String(transport || "tls-worker").toLowerCase() !== "undici";
  let dispatcher;
  try {
    dispatcher = useTlsWorker
      ? await makeRemoteTlsDispatcher(proxyRaw)
      : makeDispatcher(proxyUrl, { forceUndici: true });
  } catch (e) {
    // Fall back to undici if native TLS bake missing.
    dispatcher = makeDispatcher(proxyUrl, { forceUndici: true });
  }
  const jar = createJar();
  const ctx = { dispatcher, jar, steps: [] };
  const session = createPcSession(ctx, { locale: locale || "en-au" });
  const homeUrl = pageUrl || `${session.state.base}/`;

  try {
    try {
      ctx.egressIp = await resolveEgressIp(ctx);
    } catch {
      /* optional */
    }

    const warm = await warmPokemonCentre(session, ctx, {});
    if (!warm.ok) {
      return {
        ok: false,
        error: warm.note || "edge warm failed",
        ms: Date.now() - t0,
        warm,
        isIpBanned: Boolean(warm.datadome?.isIpBanned || /t=bv|isIpBanned/i.test(String(warm.note || ""))),
      };
    }

    const cookies = jar.dump?.() || {};
    if (!cookies.reese84 || !cookies.datadome) {
      return {
        ok: false,
        error: "edge warm missing reese84/datadome cookies",
        ms: Date.now() - t0,
        warm,
      };
    }

    let captchaToken = null;
    let captchaNote = "skipped";
    let captchaMs = 0;
    let captchaSitekey = null;
    if (solveCaptcha === true && capsolverKey()) {
      const c0 = Date.now();
      // Probe home HTML for hCaptcha sitekey (drop escalation). Soft-fail.
      let html = "";
      try {
        const res = await session.get(homeUrl, { headers: { referer: homeUrl } });
        html = await session.readText(res);
      } catch {
        html = "";
      }
      captchaSitekey = extractHcaptchaSitekey(html);
      if (captchaSitekey || looksLikeHcaptcha(html)) {
        const solved = await solveHcaptcha({
          pageUrl: homeUrl,
          sitekey: captchaSitekey,
          proxyRaw: proxyRaw || null,
        });
        captchaMs = Date.now() - c0;
        if (solved.ok) {
          captchaToken = solved.token;
          captchaNote = `ok ${captchaMs}ms`;
          captchaSitekey = captchaSitekey || solved.sitekey || null;
        } else {
          captchaNote = solved.error || solved.note || "capsolver failed";
        }
      } else {
        captchaNote = "no hCaptcha on home — warm jar banked";
        captchaMs = Date.now() - c0;
      }
    } else if (solveCaptcha === true) {
      captchaNote = "CAPSOLVER_API_KEY missing";
    }

    const harvestedAt = Date.now();
    return {
      ok: true,
      ms: Date.now() - t0,
      session: {
        id: `pch_${harvestedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        store: "pokemoncentre",
        origin: PC_ORIGIN,
        locale: session.state.locale || "en-au",
        proxy: String(proxyRaw).trim(),
        proxyHost: proxyHost(proxyRaw),
        userAgent: session.state.userAgent,
        cookies,
        captchaToken,
        captchaSitekey,
        harvestedAt,
        edgeExpiresAt: harvestedAt + PC_EDGE_TTL_MS,
        captchaExpiresAt: captchaToken ? harvestedAt + PC_HCAPTCHA_TTL_MS : null,
        warmNote: warm.note,
        captchaNote,
        captchaMs,
        egressIp: ctx.egressIp || null,
        transport: dispatcher.transport || (useTlsWorker ? "tls-worker" : "undici"),
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
  harvestPokemonCentreSession,
  isPcHarvestFresh,
  PC_EDGE_TTL_MS,
  PC_HCAPTCHA_TTL_MS,
};
