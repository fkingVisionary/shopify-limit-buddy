#!/usr/bin/env node
/**
 * Summarize / diff bot vs manual Bandai HARs for dual-Revolut pivot #3.
 *
 * Focus: HandleCredit count, CCPaymentRedirect tx ids, Forter/iovation/risk hosts,
 * issuer Sec-Fetch / CH headers — not PAN fields.
 *
 * Usage:
 *   node executor/scripts/bandai-dual-har-summary.mjs --bot %TEMP%/bandai-full-dual.har
 *   node executor/scripts/bandai-dual-har-summary.mjs --bot bot.har --manual manual.har
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const RISK_HOST_RE =
  /forter|iovation|threatmetrix|sardine|sift|riskified|kount|clearsale|datadome|perimeterx|akamai|sensor|fp\.js|fingerprint/i;
const GE_RE = /global-e\.com|globale/i;
const ISSUER_RE = /HandleCreditCard/i;
const REDIRECT_RE = /CCPaymentRedirect/i;
const THREE_DS_METHOD_RE = /methodurl|three.?ds.?method|3dsmethod/i;
const ACS_RE = /creq|pareq|\/acs|cardinalcommerce/i;
const ALT_CHARGE_RE = /Authorize|ProcessPayment|CompleteOrder|SubmitPayment/i;

function headerMap(headers) {
  const out = {};
  for (const h of headers || []) {
    const n = String(h?.name || "").toLowerCase();
    if (n) out[n] = String(h?.value ?? "");
  }
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function summarize(harPath, label) {
  if (!harPath || !fs.existsSync(harPath)) {
    return { label, error: harPath ? `missing:${harPath}` : "no_path" };
  }
  const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
  const entries = har?.log?.entries || [];
  const issuers = [];
  const redirects = [];
  const riskHosts = new Map();
  const geMutates = [];
  const threeDsMethod = [];
  const acsChallenge = [];
  const altCharge = [];
  let firstIssuerStarted = null;

  for (const e of entries) {
    const req = e?.request || {};
    const res = e?.response || {};
    const url = String(req.url || "");
    const method = String(req.method || "GET").toUpperCase();
    const host = hostOf(url);
    const started =
      e?.startedDateTime != null ? Date.parse(e.startedDateTime) : null;
    if (ISSUER_RE.test(url) && method !== "GET" && method !== "OPTIONS" && method !== "HEAD") {
      if (firstIssuerStarted == null && started) firstIssuerStarted = started;
      const h = headerMap(req.headers);
      issuers.push({
        method,
        status: res.status ?? null,
        host,
        path: (() => {
          try {
            return new URL(url).pathname.slice(0, 120);
          } catch {
            return url.slice(0, 120);
          }
        })(),
        bodyBytes: Number(req.bodySize ?? req.postData?.text?.length ?? 0) || null,
        secFetchMode: h["sec-fetch-mode"] || null,
        secFetchSite: h["sec-fetch-site"] || null,
        secFetchDest: h["sec-fetch-dest"] || null,
        secChUa: h["sec-ch-ua"] ? String(h["sec-ch-ua"]).slice(0, 80) : null,
        secChPlatform: h["sec-ch-ua-platform"] || null,
        contentType: h["content-type"] || null,
      });
    }
    if (REDIRECT_RE.test(url) || REDIRECT_RE.test(String(res.redirectURL || ""))) {
      const loc = String(res.redirectURL || url);
      const m = loc.match(/TransactionId["']?\s*[:=]\s*["']?(\d+)/i);
      redirects.push({
        status: res.status ?? null,
        url: loc.slice(0, 180),
        transactionIdHint: m?.[1] || null,
      });
    }
    if (THREE_DS_METHOD_RE.test(url)) {
      threeDsMethod.push({
        method,
        status: res.status ?? null,
        host,
        url: url.slice(0, 180),
        msAfterIssuer:
          firstIssuerStarted && started != null ? started - firstIssuerStarted : null,
      });
    }
    if (ACS_RE.test(url)) {
      acsChallenge.push({
        method,
        status: res.status ?? null,
        host,
        url: url.slice(0, 160),
      });
    }
    if (ALT_CHARGE_RE.test(url) && method !== "GET" && method !== "OPTIONS") {
      altCharge.push({
        method,
        status: res.status ?? null,
        host,
        url: url.slice(0, 160),
      });
    }
    if (host && RISK_HOST_RE.test(host + url)) {
      riskHosts.set(host, (riskHosts.get(host) || 0) + 1);
    }
    if (
      GE_RE.test(url) &&
      method !== "GET" &&
      method !== "OPTIONS" &&
      method !== "HEAD" &&
      !/WriteContextualLog|collectCheckout|prefetcher|\.js(?:\?|$)|\/css\//i.test(url)
    ) {
      geMutates.push({
        method,
        host,
        path: (() => {
          try {
            return new URL(url).pathname.slice(0, 100);
          } catch {
            return url.slice(0, 100);
          }
        })(),
        status: res.status ?? null,
      });
    }
  }

  return {
    label,
    path: harPath,
    entries: entries.length,
    handleCreditPosts: issuers.length,
    issuers,
    redirects: redirects.slice(0, 8),
    threeDsMethodCount: threeDsMethod.length,
    threeDsMethod: threeDsMethod.slice(0, 12),
    acsChallengeCount: acsChallenge.length,
    acsChallenge: acsChallenge.slice(0, 8),
    altChargeCount: altCharge.length,
    altCharge: altCharge.slice(0, 8),
    riskHosts: [...riskHosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([host, n]) => ({ host, n })),
    geMutateCount: geMutates.length,
    geMutatesTail: geMutates.slice(-12),
    lead3ds:
      threeDsMethod.length === 0 && issuers.length >= 1
        ? "NO_3DS_METHOD_AFTER_ISSUER — strongest silent-skip candidate"
        : threeDsMethod.length > 0
          ? "3DS_METHOD_SEEN"
          : null,
  };
}

function diff(bot, manual) {
  if (bot.error || manual.error) return { skipped: true };
  const botRisk = new Set((bot.riskHosts || []).map((r) => r.host));
  const manRisk = new Set((manual.riskHosts || []).map((r) => r.host));
  const onlyBot = [...botRisk].filter((h) => !manRisk.has(h));
  const onlyManual = [...manRisk].filter((h) => !botRisk.has(h));
  const botIssuer = bot.issuers?.[0] || null;
  const manIssuer = manual.issuers?.[0] || null;
  return {
    handleCreditPosts: { bot: bot.handleCreditPosts, manual: manual.handleCreditPosts },
    riskHostsOnlyBot: onlyBot,
    riskHostsOnlyManual: onlyManual,
    issuerHeaderDelta: {
      secFetchMode: {
        bot: botIssuer?.secFetchMode || null,
        manual: manIssuer?.secFetchMode || null,
      },
      secFetchSite: {
        bot: botIssuer?.secFetchSite || null,
        manual: manIssuer?.secFetchSite || null,
      },
      secFetchDest: {
        bot: botIssuer?.secFetchDest || null,
        manual: manIssuer?.secFetchDest || null,
      },
      secChPlatform: {
        bot: botIssuer?.secChPlatform || null,
        manual: manIssuer?.secChPlatform || null,
      },
      bodyBytes: {
        bot: botIssuer?.bodyBytes || null,
        manual: manIssuer?.bodyBytes || null,
      },
    },
  };
}

const botPath =
  arg("--bot") ||
  process.env.BANDAI_BROWSER_HAR_PATH ||
  path.join(os.tmpdir(), "bandai-full-dual.har");
const manualPath = arg("--manual");

const bot = summarize(botPath, "bot");
const manual = manualPath ? summarize(manualPath, "manual") : null;
const out = {
  bot,
  manual,
  diff: manual && !manual.error && !bot.error ? diff(bot, manual) : null,
  note:
    "Dual shape: HandleCreditPosts=1 on both is expected. 3DS lead: compare threeDsMethodCount / altChargeCount after issuer. Owner locked: Revolut lines same amount, ~same merchant, seconds apart; GE tx id always 1.",
};

console.log(JSON.stringify(out, null, 2));
