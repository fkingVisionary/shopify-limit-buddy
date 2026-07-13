// Paydock / GPayments ACS challenge helper.
//
// Revolut (and many AU issuers) enrol cards in 3DS. Sometimes the bank
// frictionlessly fingerprints the device; sometimes it step-ups to an ACS
// page + Revolut app push / OTP. Raw HTTP cannot finish that step-up — we
// open Chromium and wait for the ACS to settle while the cardholder
// approves on their phone.
//
// IMPORTANT: `paydock.api.as1.gpayments.net` presents a cert chained to the
// private "GPayments Root CA" (not in public trust stores). Real checkout
// loads ACS through widget.paydock.com (public DigiCert) with that API host
// in an iframe — Chromium still needs ignoreHTTPSErrors for the nested
// private-CA frame, otherwise you get net::ERR_CERT_AUTHORITY_INVALID.

function parseProxy(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  if (!/^https?:\/\//i.test(s) && !s.includes("@")) {
    const parts = s.split(":");
    if (parts.length >= 4) {
      const [host, port, user, ...rest] = parts;
      return {
        server: `http://${host}:${port || "80"}`,
        username: user,
        password: rest.join(":"),
      };
    }
  }

  const withScheme = /^https?:\/\//i.test(s) ? s : "http://" + s;
  try {
    const u = new URL(withScheme);
    const out = { server: `http://${u.hostname}:${u.port || "80"}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return null;
  }
}

function looksSettled(url, bodyText) {
  const u = String(url || "");
  const t = String(bodyText || "").slice(0, 4000);
  if (/net::ERR_CERT|ERR_CERT_AUTHORITY_INVALID|Your connection is not private/i.test(t)) {
    return false;
  }
  if (/threeDSMethodData|creq=|challengeWindowSize/i.test(t) && /Approve|OTP|One.?Time|push notification|Open your.*app/i.test(t)) {
    // Still on the challenge UI — not settled.
    return false;
  }
  if (/\/3ds\/.*(?:success|complete|result|return)/i.test(u)) return true;
  if (/standalone-3ds/i.test(u) && /info=(?:Auth|Success|Complete|ChallengeComplete)/i.test(u)) return true;
  if (/authenticated|authentication.?success|challenge.?complet|transaction.?approved/i.test(t)) return true;
  if (/paydock\.com\/v1\/charges\/standalone-3ds/i.test(u)) return true;
  return false;
}

function isUuidLike(id) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(id || ""));
}

/**
 * Prefer the Paydock widget URL from /handle's 302 Location (public cert).
 * Fall back to raw GPayments authorization_url (private CA — needs ignoreHTTPSErrors).
 */
export function pickAcsEntryUrl({ handleLocation, authorizationUrl, charge3dsId, paydockJwt } = {}) {
  if (handleLocation && /widget\.paydock\.com\/3ds\/standalone-3ds/i.test(handleLocation)) {
    return { url: handleLocation, source: "handle_location" };
  }
  if (authorizationUrl) {
    return { url: authorizationUrl, source: "authorization_url" };
  }
  // Last resort: synthesize widget URL the way /handle redirects.
  if (charge3dsId && paydockJwt && isUuidLike(charge3dsId)) {
    const u = new URL("https://widget.paydock.com/3ds/standalone-3ds");
    u.searchParams.set("charge_3ds_id", charge3dsId);
    u.searchParams.set("info", "InitAuthTimedOut");
    // Widget reads access token from query in the HAR redirect.
    u.searchParams.set("x-access-token", paydockJwt);
    return { url: u.toString(), source: "synthesized_widget" };
  }
  return { url: null, source: "none" };
}

/**
 * Open ACS / Paydock standalone-3ds and wait for issuer completion.
 * @returns {{ ok: boolean, note: string, finalUrl?: string, certError?: boolean }}
 */
export async function completeAcsChallenge({
  authorizationUrl,
  proxy = null,
  timeoutMs = 120_000,
  referer = "https://www.kmart.com.au/checkout/payment",
} = {}) {
  if (!authorizationUrl) {
    return { ok: false, note: "no authorization_url", certError: false };
  }

  let playwright;
  try {
    playwright = await import("playwright");
  } catch (e) {
    return { ok: false, note: `playwright import failed: ${e?.message ?? e}`, certError: false };
  }

  const proxyCfg = parseProxy(proxy);
  const launchOpts = {
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // GPayments ActiveServer API hosts use a private root CA.
      "--ignore-certificate-errors",
    ],
    ...(proxyCfg ? { proxy: proxyCfg } : {}),
  };

  let browser;
  try {
    try {
      browser = await playwright.chromium.launch({ channel: "chrome", ...launchOpts });
    } catch {
      browser = await playwright.chromium.launch(launchOpts);
    }

    const context = await browser.newContext({
      locale: "en-AU",
      timezoneId: "Australia/Sydney",
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { "accept-language": "en-AU,en;q=0.9" },
      // Required: nested ACS iframes hit paydock.api.as1.gpayments.net
      // which chains to private "GPayments Root CA".
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(timeoutMs, 60_000));

    await page.goto(authorizationUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(timeoutMs, 45_000),
      referer,
    });

    const deadline = Date.now() + timeoutMs;
    let settled = false;
    let lastUrl = page.url();
    let lastSnippet = "";

    while (Date.now() < deadline) {
      lastUrl = page.url();
      try {
        lastSnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || "");
      } catch {
        lastSnippet = "";
      }
      if (looksSettled(lastUrl, lastSnippet)) {
        settled = true;
        break;
      }
      // Revolut / bank-app step-up: ACS page sits on "approve in app" until
      // the phone push is accepted, then redirects. Poll gently.
      await page.waitForTimeout(1500);
    }

    // Brief settle after redirect so Paydock cookies/callbacks land.
    if (settled) {
      try {
        await page.waitForTimeout(1200);
        lastUrl = page.url();
      } catch {
        /* ignore */
      }
    }

    return {
      ok: settled,
      note: settled
        ? `acs settled url=${lastUrl.slice(0, 160)}`
        : `acs timeout after ${timeoutMs}ms — approve in Revolut/bank app while ACS is open. lastUrl=${lastUrl.slice(0, 120)} body=${lastSnippet.slice(0, 80).replace(/\s+/g, " ")}`,
      finalUrl: lastUrl,
      certError: false,
    };
  } catch (e) {
    const msg = e?.message ?? String(e);
    const certError = /ERR_CERT|CERT_AUTHORITY|SSL|certificate/i.test(msg);
    return {
      ok: false,
      note: `acs error: ${msg}`,
      certError,
    };
  } finally {
    try {
      await browser?.close?.();
    } catch {
      /* ignore */
    }
  }
}

export { isUuidLike };
