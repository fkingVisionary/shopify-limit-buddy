// Paydock / GPayments 3DS helper — matches @paydock/client-sdk GPaymentsService.
//
// Correct flow (NOT top-level navigation to authorization_url):
//   1. Hidden iframes: initialization_url + secondary_url (3DS Method)
//   2. POST /standalone-3ds/handle event=InitAuthTimedOut (method done/timeout)
//   3. POST /standalone-3ds/process { charge_3ds_id }
//   4a. success / frictionless → done
//   4b. pending + decoupled_challenge → Revolut app push; poll process
//   4c. pending + challenge → load challenge_url iframe + poll
//
// Never page.goto paydock.api.as*.gpayments.net (client TLS cert required).

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

/**
 * One Playwright session: method iframes → InitAuthTimedOut handle.
 * Uses context.request (no CORS) for the Paydock handle POST.
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

    await page.goto(`${storeOrigin}/checkout/payment`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    }).catch(() =>
      page.goto("https://widget.paydock.com/", { waitUntil: "domcontentloaded", timeout: 30_000 }),
    );

    let iframeNote = "no-init-urls";
    if (initializationUrl || secondaryUrl) {
      const frameResults = await page.evaluate(
        async ({ init, secondary }) => {
          const root = document.body;
          const out = [];
          async function add(id, src) {
            if (!src) return;
            await new Promise((resolve) => {
              const f = document.createElement("iframe");
              f.id = id;
              f.title = id;
              f.style.cssText = "width:1px;height:1px;opacity:0;border:0;position:absolute;";
              f.onload = () => resolve({ id, ok: true });
              f.onerror = () => resolve({ id, ok: false });
              setTimeout(() => resolve({ id, ok: false, timeout: true }), 8000);
              f.src = src;
              root.appendChild(f);
            }).then((r) => out.push(r));
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

    const requestorTransId = globalThis.crypto.randomUUID();
    const param = Buffer.from(
      JSON.stringify(buildBrowserInfo(egressIp, userAgent)),
      "utf8",
    ).toString("base64");
    const body = new URLSearchParams({
      requestorTransId,
      event: "InitAuthTimedOut",
      param,
    }).toString();
    const handleUrl = `https://api.paydock.com/v1/charges/standalone-3ds/handle?x-access-token=${encodeURIComponent(paydockJwt)}`;

    // Playwright APIRequestContext bypasses CORS and uses the browser TLS stack.
    const handleRes = await context.request.post(handleUrl, {
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded",
        origin: storeOrigin,
        referer: `${storeOrigin}/checkout/payment`,
      },
      data: body,
      maxRedirects: 0,
      failOnStatusCode: false,
      timeout: 30_000,
    });
    const handleStatus = handleRes.status();
    const loc = handleRes.headers()?.location || handleRes.headers()?.Location || "";
    const idMatch = String(loc).match(/charge_3ds_id=([a-f0-9-]{20,})/i);
    const returnedId = idMatch?.[1] ?? null;

    return {
      ok: handleStatus >= 200 && handleStatus < 400,
      note: `iframes=${iframeNote} handle=${handleStatus} loc=${String(loc).slice(0, 120)}`,
      handleStatus,
      handleLocation: loc || null,
      returnedCharge3dsId: returnedId,
      requestorTransId,
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
 * Decoupled / challenge wait with process polling. Only call when /process
 * already returned pending + decoupled/challenge — never as a blind 2min hang.
 */
export async function completeAcsChallenge({
  authorizationUrl,
  initializationUrl = null,
  secondaryUrl = null,
  challengeUrl = null,
  proxy = null,
  timeoutMs = 60_000,
  referer = "https://www.kmart.com.au/checkout/payment",
  pollProcess = null,
} = {}) {
  const challenge =
    challengeUrl ||
    (authorizationUrl && !isGpaymentsApiHost(authorizationUrl) ? authorizationUrl : null);

  if (!challenge && typeof pollProcess !== "function") {
    return {
      ok: false,
      note: "no challenge_url and no pollProcess — refusing blind ACS wait",
      certError: false,
    };
  }

  let browser;
  try {
    const launched = await launchBrowser(proxy);
    browser = launched.browser;
    const { page } = launched;
    page.setDefaultTimeout(Math.min(timeoutMs, 45_000));

    await page.goto("https://widget.paydock.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
      referer,
    });

    if (secondaryUrl) {
      await page.evaluate((src) => {
        const f = document.createElement("iframe");
        f.id = "paydock_secondary_iframe";
        f.src = src;
        f.style.cssText = "width:1px;height:1px;opacity:0;border:0;";
        document.body.appendChild(f);
      }, secondaryUrl);
    }

    if (challenge) {
      if (isGpaymentsApiHost(challenge)) {
        return {
          ok: false,
          note: `refusing challenge_url on GPayments API host (client cert): ${String(challenge).slice(0, 80)}`,
          certError: true,
        };
      }
      await page.evaluate((url) => {
        const f = document.createElement("iframe");
        f.id = "paydock_challenge_iframe";
        f.title = "Authentication Challenge";
        f.style.cssText = "width:100%;height:90vh;border:0;";
        f.src = url;
        document.body.appendChild(f);
      }, challenge);
    }

    const deadline = Date.now() + timeoutMs;
    let lastPollNote = "";
    while (Date.now() < deadline) {
      if (typeof pollProcess === "function") {
        try {
          const p = await pollProcess();
          if (p?.frictionless) {
            return {
              ok: true,
              note: `authenticated via poll (${p.note || "ok"})`,
              mode: "poll_process",
              certError: false,
              finalUrl: page.url(),
            };
          }
          // Hard fail: ValidationError will never become Revolut push.
          if (/validation=/i.test(String(p?.note || "")) || p?.status === 400) {
            return {
              ok: false,
              note: `abort ACS wait — process still invalid: ${String(p?.note || "").slice(0, 180)}`,
              mode: "process_invalid",
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

    return {
      ok: false,
      note: `3DS wait timeout after ${timeoutMs}ms. lastPoll=${String(lastPollNote).slice(0, 140)}`,
      mode: challenge ? "challenge" : "decoupled",
      certError: false,
      finalUrl: page.url(),
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
