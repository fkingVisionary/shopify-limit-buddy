// Paydock / GPayments 3DS helper — matches @paydock/client-sdk GPaymentsService.
//
// Flow:
//   1. Method iframes (initialization_url + secondary_url)
//   2. POST /handle event=InitAuthTimedOut
//   3. POST /process { charge_3ds_id }
//   4a. success → done
//   4b. pending + challenge_url → load challenge iframe, poll secondary until
//       AuthResultReady, THEN process again (do NOT process-poll during challenge)
//   4c. pending + decoupled_challenge → poll process while user approves app push
//
// Important: during a Visa/Mastercard challenge, calling /process again early
// returns invalid_transaction / token_inactive and kills the Revolut push.

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

function isUuidLike(id) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(id || ""));
}

function isGpaymentsApiHost(url) {
  try {
    return /\.api\.as\d*\.gpayments\.net$/i.test(new URL(url).hostname);
  } catch {
    return /api\.as\d*\.gpayments\.net/i.test(String(url || ""));
  }
}

export function pickAcsEntryUrl({ handleLocation, authorizationUrl, charge3dsId, paydockJwt } = {}) {
  if (handleLocation && /widget\.paydock\.com\/3ds\/standalone-3ds/i.test(handleLocation)) {
    return { url: handleLocation, source: "handle_location" };
  }
  if (charge3dsId && paydockJwt && isUuidLike(charge3dsId)) {
    const u = new URL("https://widget.paydock.com/3ds/standalone-3ds");
    u.searchParams.set("charge_3ds_id", charge3dsId);
    u.searchParams.set("info", "InitAuthTimedOut");
    u.searchParams.set("token", paydockJwt);
    return { url: u.toString(), source: "synthesized_widget" };
  }
  if (authorizationUrl && !isGpaymentsApiHost(authorizationUrl)) {
    return { url: authorizationUrl, source: "authorization_url" };
  }
  return { url: null, source: "none" };
}

async function launchBrowser(proxy) {
  const playwright = await import("playwright");
  const proxyCfg = parseProxy(proxy);
  const launchOpts = {
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--ignore-certificate-errors",
    ],
    ...(proxyCfg ? { proxy: proxyCfg } : {}),
  };
  let browser;
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
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  return { browser, context, page };
}

function buildBrowserInfo(egressIp, userAgent) {
  return {
    browserAcceptHeader:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    browserIP: egressIp || "0.0.0.0",
    browserJavaEnabled: false,
    browserLanguage: "en-AU",
    browserJavascriptEnabled: true,
    browserColorDepth: "24",
    browserScreenHeight: "900",
    browserScreenWidth: "1280",
    browserTZ: "-600",
    browserUserAgent: userAgent || "Mozilla/5.0",
  };
}

async function postHandleInitAuthTimedOut(context, { paydockJwt, egressIp, userAgent, storeOrigin }) {
  const requestorTransId = globalThis.crypto.randomUUID();
  const param = Buffer.from(JSON.stringify(buildBrowserInfo(egressIp, userAgent)), "utf8").toString("base64");
  // Prefer header token (SDK style). Query-token alone was 403'ing from Fly.
  const handleRes = await context.request.post("https://api.paydock.com/v1/charges/standalone-3ds/handle", {
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      "x-access-token": paydockJwt,
      origin: storeOrigin,
      referer: `${storeOrigin}/checkout/payment`,
    },
    form: {
      requestorTransId,
      event: "InitAuthTimedOut",
      param,
    },
    maxRedirects: 0,
    failOnStatusCode: false,
    timeout: 30_000,
  });
  const handleStatus = handleRes.status();
  const headers = handleRes.headers();
  const loc = headers.location || headers.Location || "";
  const idMatch = String(loc).match(/charge_3ds_id=([a-f0-9-]{20,})/i);
  return {
    handleStatus,
    handleLocation: loc || null,
    returnedCharge3dsId: idMatch?.[1] ?? null,
    requestorTransId,
    bodySnippet: (await handleRes.text().catch(() => "")).slice(0, 160),
  };
}

/**
 * One Playwright session: method iframes → InitAuthTimedOut handle.
 */
export async function runMethodThenHandle({
  initializationUrl = null,
  secondaryUrl = null,
  paydockJwt,
  charge3dsId,
  egressIp = null,
  userAgent = null,
  proxy = null,
  methodWaitMs = 10_000,
  storeOrigin = "https://www.kmart.com.au",
} = {}) {
  if (!paydockJwt || !isUuidLike(charge3dsId)) {
    return { ok: false, note: "missing jwt/charge3dsId", handleStatus: 0, handleLocation: null };
  }

  let browser;
  try {
    const launched = await launchBrowser(proxy);
    browser = launched.browser;
    const { context, page } = launched;

    await page
      .goto(`${storeOrigin}/checkout/payment`, { waitUntil: "domcontentloaded", timeout: 45_000 })
      .catch(() => page.goto("https://widget.paydock.com/", { waitUntil: "domcontentloaded", timeout: 30_000 }));

    let iframeNote = "no-init-urls";
    if (initializationUrl || secondaryUrl) {
      const frameResults = await page.evaluate(
        async ({ init, secondary }) => {
          const root = document.body;
          const out = [];
          async function add(id, src) {
            if (!src) return;
            const r = await new Promise((resolve) => {
              const f = document.createElement("iframe");
              f.id = id;
              f.title = id;
              f.style.cssText = "width:1px;height:1px;opacity:0;border:0;position:absolute;";
              f.onload = () => resolve({ id, ok: true });
              f.onerror = () => resolve({ id, ok: false });
              setTimeout(() => resolve({ id, ok: false, timeout: true }), 8000);
              f.src = src;
              root.appendChild(f);
            });
            out.push(r);
          }
          await add("paydock_authorization_iframe", init);
          await add("paydock_secondary_iframe", secondary);
          return out;
        },
        { init: initializationUrl, secondary: secondaryUrl },
      );
      iframeNote = JSON.stringify(frameResults).slice(0, 160);
      await page.waitForTimeout(methodWaitMs);
    }

    const handle = await postHandleInitAuthTimedOut(context, {
      paydockJwt,
      egressIp,
      userAgent,
      storeOrigin,
    });

    return {
      ok: handle.handleStatus >= 200 && handle.handleStatus < 400,
      note: `iframes=${iframeNote} handle=${handle.handleStatus} loc=${String(handle.handleLocation || "").slice(0, 100)} body=${handle.bodySnippet}`,
      handleStatus: handle.handleStatus,
      handleLocation: handle.handleLocation,
      returnedCharge3dsId: handle.returnedCharge3dsId,
      requestorTransId: handle.requestorTransId,
    };
  } catch (e) {
    return {
      ok: false,
      note: `method+handle error: ${e?.message ?? e}`,
      handleStatus: 0,
      handleLocation: null,
    };
  } finally {
    try {
      await browser?.close?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Challenge / decoupled wait.
 * - challenge: load challenge_url iframe (incl. GPayments host via ignoreHTTPSErrors),
 *   poll secondary_url for AuthResultReady — do NOT call /process until ready.
 * - decoupled: poll /process while user approves bank app.
 */
export async function completeAcsChallenge({
  authorizationUrl,
  secondaryUrl = null,
  challengeUrl = null,
  proxy = null,
  timeoutMs = 75_000,
  referer = "https://www.kmart.com.au/checkout/payment",
  mode = null, // "challenge" | "decoupled" | null
  pollProcess = null,
  paydockJwt = null,
} = {}) {
  const challenge = challengeUrl || authorizationUrl || null;
  const effectiveMode = mode || (challenge ? "challenge" : "decoupled");

  if (effectiveMode === "challenge" && !challenge) {
    return { ok: false, note: "challenge mode but no challenge_url", certError: false };
  }
  if (effectiveMode === "decoupled" && typeof pollProcess !== "function") {
    return { ok: false, note: "decoupled mode requires pollProcess", certError: false };
  }

  let browser;
  try {
    const launched = await launchBrowser(proxy);
    browser = launched.browser;
    const { context, page } = launched;
    page.setDefaultTimeout(Math.min(timeoutMs, 45_000));

    await page.goto("https://widget.paydock.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
      referer,
    });

    // Secondary monitor (SDK doPolling target).
    if (secondaryUrl) {
      await page.evaluate((src) => {
        const f = document.createElement("iframe");
        f.id = "paydock_secondary_iframe";
        f.src = src;
        f.style.cssText = "width:1px;height:1px;opacity:0;border:0;";
        document.body.appendChild(f);
      }, secondaryUrl);
    }

    let challengeHost = "";
    let challengeLoadOk = false;
    if (effectiveMode === "challenge" && challenge) {
      try {
        challengeHost = new URL(challenge).hostname;
      } catch {
        challengeHost = String(challenge).slice(0, 40);
      }
      // SDK loads challenge_url in an iframe even when it is on GPayments API
      // hosts. ignoreHTTPSErrors covers private CA; client-cert is best-effort.
      const load = await page.evaluate(async (url) => {
        return await new Promise((resolve) => {
          const f = document.createElement("iframe");
          f.id = "paydock_challenge_iframe";
          f.title = "Authentication Challenge";
          f.style.cssText = "width:100%;height:90vh;border:0;";
          const t = setTimeout(() => resolve({ ok: false, reason: "timeout" }), 15_000);
          f.onload = () => {
            clearTimeout(t);
            resolve({ ok: true });
          };
          f.onerror = () => {
            clearTimeout(t);
            resolve({ ok: false, reason: "error" });
          };
          f.src = url;
          document.body.innerHTML = "";
          document.body.appendChild(f);
        });
      }, challenge);
      challengeLoadOk = Boolean(load?.ok);
      if (!challengeLoadOk) {
        // Fallback: top-level navigation (still ignoreHTTPSErrors).
        try {
          const res = await page.goto(challenge, { waitUntil: "domcontentloaded", timeout: 30_000 });
          challengeLoadOk = Boolean(res && res.status() < 500);
        } catch (e) {
          const msg = e?.message ?? String(e);
          const certError = /ERR_CERT|CERT_AUTHORITY|BAD_SSL_CLIENT_AUTH|SSL|certificate/i.test(msg);
          return {
            ok: false,
            note: `challenge load failed host=${challengeHost} iframe=${load?.reason || "fail"} nav=${msg.slice(0, 120)}`,
            certError,
            mode: "challenge",
          };
        }
      }
    }

    const deadline = Date.now() + timeoutMs;
    let lastPollNote = `challengeHost=${challengeHost} loaded=${challengeLoadOk}`;
    let authReady = false;

    while (Date.now() < deadline) {
      if (effectiveMode === "challenge" && secondaryUrl) {
        try {
          const sec = await context.request.get(secondaryUrl, {
            headers: { accept: "application/json, text/plain, */*" },
            failOnStatusCode: false,
            timeout: 10_000,
          });
          const txt = await sec.text();
          let event = null;
          try {
            event = JSON.parse(txt)?.event ?? null;
          } catch {
            if (/AuthResultReady/i.test(txt)) event = "AuthResultReady";
          }
          lastPollNote = `secondary status=${sec.status()} event=${event || "?"} body=${txt.slice(0, 80)}`;
          if (event === "AuthResultReady") {
            authReady = true;
            break;
          }
        } catch (e) {
          lastPollNote = `secondary err: ${e?.message ?? e}`;
        }
      }

      if (effectiveMode === "decoupled" && typeof pollProcess === "function") {
        try {
          const p = await pollProcess();
          if (p?.frictionless) {
            return {
              ok: true,
              note: `authenticated via decoupled poll (${p.note || "ok"})`,
              mode: "decoupled",
              certError: false,
              finalUrl: page.url(),
            };
          }
          if (p?.status === 403 || /token_inactive/i.test(String(p?.note || ""))) {
            return {
              ok: false,
              note: `decoupled aborted — token dead: ${String(p?.note || "").slice(0, 160)}`,
              mode: "decoupled",
              certError: false,
            };
          }
          lastPollNote = p?.note || lastPollNote;
        } catch (e) {
          lastPollNote = e?.message ?? String(e);
        }
      }

      await page.waitForTimeout(2000);
    }

    // After challenge AuthResultReady, SDK calls GET /handle then considers auth done.
    if (authReady && paydockJwt) {
      try {
        const h = await context.request.get("https://api.paydock.com/v1/charges/standalone-3ds/handle", {
          headers: {
            accept: "application/json, text/plain, */*",
            "x-access-token": paydockJwt,
            origin: "https://www.kmart.com.au",
            referer: "https://www.kmart.com.au/checkout/payment",
          },
          failOnStatusCode: false,
          timeout: 20_000,
        });
        lastPollNote += ` getHandle=${h.status()}`;
      } catch (e) {
        lastPollNote += ` getHandleErr=${e?.message ?? e}`;
      }
    }

    if (authReady) {
      return {
        ok: true,
        note: `AuthResultReady — ${lastPollNote}`,
        mode: "challenge",
        certError: false,
        finalUrl: page.url(),
        authReady: true,
      };
    }

    return {
      ok: false,
      note: `3DS ${effectiveMode} timeout after ${timeoutMs}ms. ${lastPollNote}`.slice(0, 280),
      mode: effectiveMode,
      certError: false,
      finalUrl: page.url(),
      authReady: false,
      challengeLoadOk,
      challengeHost,
    };
  } catch (e) {
    const msg = e?.message ?? String(e);
    const certError = /ERR_CERT|CERT_AUTHORITY|BAD_SSL_CLIENT_AUTH|SSL|certificate/i.test(msg);
    return { ok: false, note: `acs error: ${msg}`, certError };
  } finally {
    try {
      await browser?.close?.();
    } catch {
      /* ignore */
    }
  }
}

export { isUuidLike, isGpaymentsApiHost };
