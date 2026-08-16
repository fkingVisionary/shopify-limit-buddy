// Harvest one Toymate CF session (+ optional checkout spam reCAPTCHA).
// Used by POST /toymate/harvest — desktop Harvest tab pools these off the
// critical path so checkout can skip CapSolver CF warm (~45s) + spam (~30s).

import { makeDispatcher, createJar, request, UA } from "../http.js";
import {
  solveCloudflareChallenge,
  solveRecaptchaV2,
  looksLikeCfChallenge,
  capsolverKey,
} from "./toymate-cf-solve.js";

const TOYMATE_SPAM_SITEKEY = "6LcjX0sbAAAAACp92-MNpx66FT4pbIWh-FTDmkkz";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function navHeaders({ referer, userAgent } = {}) {
  return {
    "user-agent": userAgent || UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    "cache-control": "no-cache",
    "upgrade-insecure-requests": "1",
    ...(referer ? { referer } : {}),
  };
}

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

function applyCookiesToJar(jar, cookies) {
  if (!jar || !cookies || typeof cookies !== "object") return;
  if (typeof jar.load === "function") {
    jar.load(cookies);
    return;
  }
  for (const [name, value] of Object.entries(cookies)) {
    if (!name || value == null || value === "") continue;
    jar.set?.(String(name), String(value));
  }
}

async function readText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Mint one CF-warmed jar on a sticky proxy, optionally solve spam reCAPTCHA.
 * @returns {{ ok, session?, error?, ms }}
 */
export async function harvestToymateSession({
  proxyRaw,
  solveSpam = true,
  spamSitekey = TOYMATE_SPAM_SITEKEY,
  maxCfAttempts = 3,
} = {}) {
  const t0 = Date.now();
  if (!capsolverKey()) {
    return { ok: false, error: "CAPSOLVER_API_KEY missing", ms: 0 };
  }
  const proxyUrl = toProxyUrl(proxyRaw);
  if (!proxyUrl) {
    return { ok: false, error: "proxy required (sticky AU ISP/resi)", ms: 0 };
  }

  const attempts = Math.max(1, Math.min(5, Number(maxCfAttempts) || 3));
  let lastFail = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(800 * attempt + 400);
    const out = await harvestToymateSessionOnce({
      proxyUrl,
      solveSpam,
      spamSitekey,
      t0,
      attempt,
    });
    if (out.ok) return out;
    lastFail = out;
    const err = String(out.error || "");
    const retryable =
      /ERROR_INVALID_TASK_DATA|ERROR_PROXY|proxy timeout|proxy connect|timeout/i.test(err);
    if (!retryable) return out;
  }
  return lastFail || { ok: false, error: "harvest failed", ms: Date.now() - t0 };
}

async function harvestToymateSessionOnce({
  proxyUrl,
  solveSpam,
  spamSitekey,
  t0,
  attempt = 0,
}) {
  const dispatcher = makeDispatcher(proxyUrl, { forceUndici: true });
  const jar = createJar();
  const ctx = { dispatcher, jar, extraHeaders: {} };

  try {
    const candidates = [
      "https://www.toymate.com.au/",
      "https://toymate.com.au/",
      "https://www.toymate.com.au/login.php",
      "https://toymate.com.au/login.php",
    ];

    let pageUrl = candidates[0];
    let html = "";
    let status = 0;
    let challenged = false;
    let lastErr = null;

    for (const url of candidates) {
      try {
        const res = await request(url, { headers: navHeaders() }, ctx);
        status = res.status;
        html = await readText(res);
        pageUrl = url;
        challenged = looksLikeCfChallenge(html, status);
        if (!challenged && status > 0 && status < 400 && html.length > 500) {
          // Already clear — still capture jar cookies.
          challenged = false;
          break;
        }
        if (challenged) break;
      } catch (e) {
        lastErr = e?.message || String(e);
      }
    }

    let solvedUa = UA;
    let cfNote = "no challenge";

    if (challenged) {
      const solved = await solveCloudflareChallenge({
        pageUrl,
        html,
        proxyRaw: proxyUrl,
        userAgent: UA,
      });
      if (!solved.ok) {
        return {
          ok: false,
          error: solved.error || "CF solve failed",
          ms: Date.now() - t0,
          attempt,
        };
      }
      applyCookiesToJar(jar, solved.cookies);
      solvedUa = solved.userAgent || UA;
      ctx.extraHeaders = { "user-agent": solvedUa };
      cfNote = solved.note || "cf_clearance minted";

      const res2 = await request("https://toymate.com.au/", {
        headers: navHeaders({ referer: pageUrl, userAgent: solvedUa }),
      }, ctx);
      const html2 = await readText(res2);
      if (looksLikeCfChallenge(html2, res2.status)) {
        return {
          ok: false,
          error: "CF still challenging after CapSolver solve",
          ms: Date.now() - t0,
          attempt,
        };
      }
      status = res2.status;
    } else if (lastErr && !html) {
      return { ok: false, error: `warm fetch failed: ${lastErr}`, ms: Date.now() - t0, attempt };
    }

    const cookies = jar.dump?.() || {};
    if (!cookies.cf_clearance && challenged) {
      return { ok: false, error: "cf_clearance missing after solve", ms: Date.now() - t0, attempt };
    }

    let captchaToken = null;
    let spamMs = null;
    let spamNote = "skipped";
    if (solveSpam) {
      const spamStart = Date.now();
      let spam = await solveRecaptchaV2({
        pageUrl: "https://toymate.com.au/checkout",
        sitekey: spamSitekey,
        proxyRaw: proxyUrl,
      });
      if (!spam.ok) {
        spam = await solveRecaptchaV2({
          pageUrl: "https://toymate.com.au/checkout",
          sitekey: spamSitekey,
          proxyless: true,
        });
      }
      spamMs = Date.now() - spamStart;
      if (spam.ok) {
        captchaToken = spam.token;
        spamNote = `ok via ${spam.via || "capsolver"}`;
      } else {
        spamNote = spam.error || "spam solve failed";
        // Soft: CF session still useful; checkout can solve spam on demand.
      }
    }

    const harvestedAt = Date.now();
    // CF clearance typically lasts longer than reCAPTCHA (~2 min).
    const cfExpiresAt = harvestedAt + 25 * 60_000;
    const spamExpiresAt = captchaToken ? harvestedAt + 100_000 : null;

    return {
      ok: true,
      ms: Date.now() - t0,
      session: {
        id: `hv_${harvestedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        proxy: proxyUrl,
        proxyHost: (() => {
          try {
            return new URL(proxyUrl).hostname;
          } catch {
            return null;
          }
        })(),
        userAgent: solvedUa,
        cookies,
        captchaToken,
        spamSitekey,
        harvestedAt,
        cfExpiresAt,
        spamExpiresAt,
        cfNote,
        spamNote,
        spamMs,
        status,
        attempt,
      },
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), ms: Date.now() - t0, attempt };
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
  }
}

export { TOYMATE_SPAM_SITEKEY, sleep };
