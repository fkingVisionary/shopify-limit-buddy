// Paydock / GPayments 3DS helper — matches @paydock/client-sdk GPaymentsService.
//
// Correct flow (NOT top-level navigation to authorization_url):
//   1. Hidden iframes: initialization_url + secondary_url (3DS Method)
//   2. POST /standalone-3ds/process { charge_3ds_id }
//   3a. success / frictionless → done
//   3b. pending + decoupled_challenge → Revolut/bank app push; poll secondary_url
//       until AuthResultReady, then process again
//   3c. pending + challenge → load challenge_url in a visible iframe + poll
//
// Why Revolut never prompted before:
//   We page.goto'd paydock.api.as1.gpayments.net/authorization_url which demands
//   a client TLS cert (ERR_BAD_SSL_CLIENT_AUTH_CERT). Revolut uses *decoupled*
//   challenge — the push is triggered only after a successful method+process.

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

/**
 * Pick a browser entry URL. Never return paydock.api.as*.gpayments.net —
 * that host requests a client TLS cert and cannot be page.goto'd.
 */
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
  // Deliberately ignore authorizationUrl when it is the GPayments API host.
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

/**
 * Run GPayments 3DS Method iframes (initialization + secondary), then optionally
 * drive challenge / decoupled (Revolut) wait while caller re-processes.
 *
 * @returns {{ ok: boolean, note: string, mode?: string, certError?: boolean, finalUrl?: string }}
 */
export async function completeAcsChallenge({
  authorizationUrl, // legacy name — treated as optional challenge_url only if non-api host
  initializationUrl = null,
  secondaryUrl = null,
  challengeUrl = null,
  proxy = null,
  timeoutMs = 120_000,
  referer = "https://www.kmart.com.au/checkout/payment",
  // Called every ~2s during decoupled/challenge wait. Return { frictionless:true } to stop.
  pollProcess = null,
} = {}) {
  const methodInit = initializationUrl;
  const methodSecondary = secondaryUrl;
  const challenge =
    challengeUrl ||
    (authorizationUrl && !isGpaymentsApiHost(authorizationUrl) ? authorizationUrl : null);

  if (!methodInit && !challenge && !pollProcess) {
    return {
      ok: false,
      note: "no initialization_url/challenge_url — cannot run GPayments method/ACS (refusing api.as* client-cert host)",
      certError: false,
    };
  }

  let browser;
  try {
    const launched = await launchBrowser(proxy);
    browser = launched.browser;
    const { page } = launched;
    page.setDefaultTimeout(Math.min(timeoutMs, 60_000));

    // Bootstrap a same-origin-ish shell so we can inject iframes.
    await page.goto("https://widget.paydock.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
      referer,
    });

    if (methodInit || methodSecondary) {
      await page.evaluate(
        ({ init, secondary }) => {
          const root = document.body;
          root.innerHTML = "";
          if (init) {
            const f = document.createElement("iframe");
            f.id = "paydock_authorization_iframe";
            f.title = "3ds-method";
            f.src = init;
            f.style.cssText = "width:1px;height:1px;opacity:0;border:0;position:absolute;";
            root.appendChild(f);
          }
          if (secondary) {
            const f = document.createElement("iframe");
            f.id = "paydock_secondary_iframe";
            f.title = "3ds-monitor";
            f.src = secondary;
            f.style.cssText = "width:1px;height:1px;opacity:0;border:0;position:absolute;";
            root.appendChild(f);
          }
        },
        { init: methodInit, secondary: methodSecondary },
      );
      // 3DS Method collection window (ActiveServer monitor timeout ~15s).
      await page.waitForTimeout(12_000);
    }

    // Method-only warm (no challenge / no poll): return so caller can /process.
    if (!challenge && typeof pollProcess !== "function") {
      return {
        ok: true,
        note: `method iframes loaded init=${Boolean(methodInit)} secondary=${Boolean(methodSecondary)}`,
        mode: "method_only",
        certError: false,
        finalUrl: page.url(),
      };
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
        let f = document.getElementById("paydock_challenge_iframe");
        if (!f) {
          f = document.createElement("iframe");
          f.id = "paydock_challenge_iframe";
          f.title = "Authentication Challenge";
          f.style.cssText = "width:100%;height:100%;border:0;";
          document.body.appendChild(f);
        }
        f.src = url;
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
              note: `authenticated via poll while ACS/method open (${p.note || "process ok"})`,
              mode: "poll_process",
              certError: false,
              finalUrl: page.url(),
            };
          }
          lastPollNote = p?.note || lastPollNote;
        } catch (e) {
          lastPollNote = e?.message ?? String(e);
        }
      }

      // Decoupled: secondary monitor may expose AuthResultReady in frame URL/body.
      try {
        const ready = await page.evaluate(() => {
          const frames = [...document.querySelectorAll("iframe")];
          return frames.some((f) => {
            try {
              const u = f.contentWindow?.location?.href || f.src || "";
              return /AuthResultReady|authenticated|success/i.test(u);
            } catch {
              return /AuthResultReady/i.test(f.src || "");
            }
          });
        });
        if (ready) {
          return {
            ok: true,
            note: "secondary iframe signaled AuthResultReady",
            mode: "secondary_ready",
            certError: false,
            finalUrl: page.url(),
          };
        }
      } catch {
        /* ignore */
      }

      await page.waitForTimeout(2000);
    }

    return {
      ok: false,
      note: `3DS wait timeout after ${timeoutMs}ms — approve Revolut/bank app push while method/challenge is open. lastPoll=${String(lastPollNote).slice(0, 120)}`,
      mode: challenge ? "challenge" : "method_decoupled",
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
