// Kmart AU — Playwright fallback lane.
//
// Runs Chromium via Playwright and lets `hyper-sdk-playwright` auto-handle
// Akamai sensor / SBSD challenges. Purpose: absolute backup when the raw-HTTP
// kmart adapter clears WWW but api GraphQL stays Access Denied.
//
// Enabled per-task via `kmartMode: "playwright"`.
//
// Scope (v2): browser seeds Akamai trust (home → PDP → ATC → checkout warm),
// then hands cookies to the HTTP kmart adapter (`resumeFrom:"api"`) which
// runs address → Paydock → 3DS → placeOrder. Set `httpHandoff:false` to stop
// after the browser recon only.

let _playwright = null;
let _hyperPw = null;
let _hyperSdk = null;
async function loadDeps() {
  if (!_playwright) _playwright = await import("playwright");
  if (!_hyperPw) _hyperPw = await import("hyper-sdk-playwright");
  if (!_hyperSdk) _hyperSdk = await import("hyper-sdk-js");
  return { playwright: _playwright, hyperPw: _hyperPw, hyperSdk: _hyperSdk };
}

// Parse "user:pass@host:port" | "host:port" | "http://user:pass@host:port"
// into the shape Playwright's launch({proxy}) wants.
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

function maskProxy(proxy, rawLen) {
  if (!proxy) return `parsed=false rawLen=${rawLen}`;
  const user = proxy.username ? `${proxy.username.slice(0, 3)}…` : "(no-auth)";
  return `parsed=true server=${proxy.server} user=${user} rawLen=${rawLen}`;
}

function extractSkuFromUrl(pdpUrl) {
  const m = String(pdpUrl).match(/-(\d{6,9})(?:\/|\?|#|$)/);
  return m ? m[1] : null;
}

function chromeUaFromVersion(version) {
  // Match the real Chromium build Playwright launched. Lying about Chrome/138
  // while the binary is 149+ is an instant Akamai tell (kmart-mriyj1y1).
  const major = String(version || "149").split(".")[0] || "149";
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function isHardAccessDenied(html, status) {
  if (status === 403 && /access denied|errors\.edgesuite\.net|AkamaiGHost/i.test(html || "")) return true;
  return false;
}

function cookieMap(jarArr) {
  return Object.fromEntries((jarArr || []).map((c) => [c.name, c.value]));
}

function hasBotManagerSeed(cookies) {
  return Boolean(cookies.bm_sz || cookies.ak_bmsc || cookies._abck || cookies.bm_ss);
}

async function fetchEgressIp(page, apiKey) {
  // Prefer Hyper's authenticated IP endpoint (must match proxy egress exactly
  // for sensor generation). Fall back to ipify.
  try {
    const ip = await page.evaluate(async (key) => {
      const response = await fetch("https://ip.hypersolutions.co/ip", {
        method: "GET",
        headers: {
          "x-api-key": key,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) throw new Error(`hyper-ip ${response.status}`);
      const j = await response.json();
      return j?.ip || null;
    }, apiKey);
    if (ip) return { ip, source: "ip.hypersolutions.co" };
  } catch {
    /* fall through */
  }
  const r = await page.goto("https://api.ipify.org?format=json", { timeout: 15_000, waitUntil: "domcontentloaded" });
  if (r?.ok()) {
    const j = await r.json();
    if (j?.ip) return { ip: j.ip, source: "ipify" };
  }
  throw new Error("egress IP resolve failed");
}

async function waitForAbck(context, { timeoutMs = 25_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const cookies = cookieMap(await context.cookies());
    if (/~0~/.test(cookies._abck || "")) return { ok: true, cookies };
    if (cookies._abck && hasBotManagerSeed(cookies)) {
      // Sensor posts in flight — keep waiting for ~0~.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, cookies: cookieMap(await context.cookies()) };
}

const now = () => Date.now();
function step(steps, name, ok, note, startedAt = null) {
  const ms = startedAt != null ? now() - startedAt : undefined;
  steps.push({ step: name, ok, ...(ms != null ? { ms } : {}), note });
}

async function run(task, ctx) {
  // Share steps with checkout.js's catch handler so errors don't lose progress.
  const steps = ctx?.steps ?? [];
  if (ctx && !ctx.steps) ctx.steps = steps;
  const t0 = now();
  const dryRun = task.dryRun !== false;
  const storeUrl = String(task.storeUrl || "").replace(/\/$/, "");
  const origin = "https://www.kmart.com.au";
  const maxEdgeRetries = Math.max(1, Math.min(Number(task.pwEdgeRetries) || 3, 5));

  const apiKey = process.env.HYPER_API_KEY;
  if (!apiKey) {
    step(steps, "antibot_misconfigured", false, "HYPER_API_KEY missing on executor");
    return { ok: false, steps, finalUrl: storeUrl, cookies: {}, dryRun };
  }

  let browser = null;
  try {
    let s0 = now();
    const { playwright, hyperPw, hyperSdk } = await loadDeps();
    step(steps, "deps_loaded", true, "playwright + hyper-sdk-playwright ready", s0);

    const rawLen = task.proxy ? String(task.proxy).length : 0;
    const proxy = parseProxy(task.proxy);
    step(steps, "proxy_config", Boolean(proxy) || rawLen === 0, maskProxy(proxy, rawLen));
    if (rawLen > 0 && !proxy) {
      step(steps, "proxy_parse", false, `unrecognized proxy string (len=${rawLen})`);
      return { ok: false, steps, finalUrl: storeUrl, cookies: {}, dryRun };
    }

    const launchOpts = {
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      ...(proxy ? { proxy } : {}),
    };
    s0 = now();
    let launchChannel = "bundled";
    try {
      browser = await playwright.chromium.launch({ channel: "chrome", ...launchOpts });
      launchChannel = "chrome";
      step(steps, "browser_launch", true, `channel=chrome proxy=${Boolean(proxy)}`, s0);
    } catch (e) {
      browser = await playwright.chromium.launch(launchOpts);
      launchChannel = "bundled";
      step(
        steps,
        "browser_launch",
        true,
        `channel=bundled proxy=${Boolean(proxy)} note=${e?.message?.slice(0, 100)} — install google-chrome-stable on the image for channel=chrome`,
        s0,
      );
    }

    const browserVersion = browser.version();
    const userAgent = chromeUaFromVersion(browserVersion);
    step(steps, "browser_ua", true, `version=${browserVersion} ua=${userAgent.slice(0, 90)} channel=${launchChannel}`);

    const session = new hyperSdk.Session(apiKey);
    let lastCookies = {};
    let lastHyperStatus = {};
    let lastUrl = storeUrl;
    let successContext = null;
    let lastFailureKind = "edge_deny";

    // Rotating residential pools often hand Playwright a different egress than
    // undici (kmart-mriyj1y1: 202.87.* edge-denied; HTTP lane got 1.147.* AU).
    // Hard Access Denied means BM never loaded — Hyper cannot solve it. Retry
    // with a fresh context so the proxy can mint a new exit IP.
    for (let attempt = 1; attempt <= maxEdgeRetries; attempt++) {
      const attemptTag = `pw_attempt#${attempt}`;
      s0 = now();
      const context = await browser.newContext({
        userAgent,
        locale: "en-AU",
        timezoneId: "Australia/Sydney",
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: { "accept-language": "en-AU,en;q=0.9" },
      });

      let ipAddress = "1.1.1.1";
      try {
        const ipPage = await context.newPage();
        const { ip, source } = await fetchEgressIp(ipPage, apiKey);
        ipAddress = ip;
        await ipPage.close();
        step(steps, `${attemptTag}:egress_ip`, true, `${ipAddress} via=${source}`, s0);
      } catch (e) {
        step(steps, `${attemptTag}:egress_ip`, false, e?.message?.slice(0, 120) ?? "failed", s0);
      }

      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      const protectionEvents = [];
      page.on("response", (res) => {
        const url = res.url();
        if (/akamai|bm_|_abck|sensor|sbsd|sec-cpt|\/[A-Za-z0-9_\-/]{20,}$/i.test(url) && res.url().includes("kmart.com.au")) {
          protectionEvents.push(`${res.status()} ${url.slice(0, 120)}`);
          if (protectionEvents.length > 10) protectionEvents.shift();
        }
      });

      const handlerConfigs = { session, ipAddress, acceptLanguage: "en-AU,en;q=0.9", userAgent };
      const handlers = [
        ["akamai", hyperPw.AkamaiHandler, { ...handlerConfigs }],
        ["datadome", hyperPw.DataDomeHandler, handlerConfigs],
        ["incapsula", hyperPw.IncapsulaHandler, handlerConfigs],
        ["kasada", hyperPw.KasadaHandler, handlerConfigs],
      ]
        .filter(([, Handler]) => typeof Handler === "function")
        .map(([name, Handler, config]) => ({ name, handler: new Handler(config) }));

      s0 = now();
      await Promise.all(handlers.map(({ handler }) => handler.initialize(page, context)));
      step(steps, `${attemptTag}:handlers`, true, handlers.map((h) => h.name).join("+"), s0);

      s0 = now();
      let homeStatus = 0;
      let homeHtml = "";
      try {
        const homeRes = await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
        homeStatus = homeRes?.status() ?? 0;
        homeHtml = await page.content().catch(() => "");
        step(steps, `${attemptTag}:warm_home`, homeStatus > 0 && homeStatus < 400, `status=${homeStatus}`, s0);
      } catch (e) {
        const msg = e?.message?.slice(0, 200) ?? "goto failed";
        const connClosed = /ERR_CONNECTION_CLOSED|ERR_PROXY|ERR_TUNNEL|ECONNRESET|ECONNREFUSED/i.test(msg);
        step(steps, `${attemptTag}:warm_home`, false, msg, s0);
        if (connClosed) {
          step(
            steps,
            `${attemptTag}:proxy_connect`,
            false,
            `Playwright Chrome cannot CONNECT via this proxy (${msg.split("\n")[0]}). HTTP undici may still work — use sticky HTTPS-capable residential, or leave Playwright off.`,
          );
          lastFailureKind = "proxy_connect";
        } else {
          lastFailureKind = "nav_error";
        }
        lastHyperStatus = Object.fromEntries(handlers.map(({ name, handler }) => [name, handler.getStatus?.() ?? null]));
        await context.close().catch(() => {});
        continue;
      }

      lastCookies = cookieMap(await context.cookies());
      lastHyperStatus = Object.fromEntries(handlers.map(({ name, handler }) => [name, handler.getStatus?.() ?? null]));
      lastUrl = page.url();

      if (isHardAccessDenied(homeHtml, homeStatus) || (homeStatus >= 400 && !hasBotManagerSeed(lastCookies))) {
        const htmlLc = homeHtml.toLowerCase();
        const markers = ["access denied", "akamai", "bm_sz", "_abck", "edgesuite"]
          .filter((m) => htmlLc.includes(m));
        step(
          steps,
          `${attemptTag}:edge_deny`,
          false,
          `IP ${ipAddress} blocked before Bot Manager (no sensor script for Hyper). cookies=[${Object.keys(lastCookies).join(",")}] markers=${markers.join(",") || "none"} — rotating context`,
        );
        lastFailureKind = "edge_deny";
        if (protectionEvents.length) step(steps, `${attemptTag}:protection_events`, true, protectionEvents.join(" | "));
        await context.close().catch(() => {});
        continue;
      }

      // Give Hyper's route interceptor time to post sensors and mint ~0~.
      s0 = now();
      const abckWait = await waitForAbck(context, { timeoutMs: 25_000 });
      lastCookies = abckWait.cookies;
      step(
        steps,
        `${attemptTag}:abck_wait`,
        abckWait.ok,
        abckWait.ok
          ? `_abck ~0~ after ${now() - s0}ms`
          : `_abck=${(lastCookies._abck || "").slice(0, 48)}… bm=${hasBotManagerSeed(lastCookies)}`,
        s0,
      );
      if (protectionEvents.length) step(steps, `${attemptTag}:protection_events`, true, protectionEvents.join(" | "));

      if (!abckWait.ok) {
        step(steps, `${attemptTag}:sensor_unsolved`, false, "Hyper handlers installed but _abck never reached ~0~ — retrying fresh context");
        await context.close().catch(() => {});
        continue;
      }

      successContext = { context, page, handlers, ipAddress, protectionEvents };
      step(steps, "warm_home_ok", true, `attempt=${attempt}/${maxEdgeRetries} ip=${ipAddress}`);
      break;
    }

    if (!successContext) {
      const proxyHint =
        lastFailureKind === "proxy_connect"
          ? `all ${maxEdgeRetries} Playwright attempts failed proxy CONNECT (ERR_CONNECTION_CLOSED). Chrome cannot tunnel this proxy — sticky HTTPS residential required, or leave Playwright off and use the HTTP lane (direct Fly egress currently clears cart_get/create).`
          : `all ${maxEdgeRetries} Playwright attempts hard-denied at WWW edge (Hyper scriptUrl never captured). Use a sticky AU residential session, or leave Playwright off and keep the HTTP lane.`;
      step(steps, "warm_home", false, proxyHint);
      return {
        ok: false,
        steps,
        finalUrl: lastUrl,
        cookies: lastCookies,
        dryRun,
        trace: {
          elapsedMs: now() - t0,
          hyperStatus: lastHyperStatus,
          httpHandoff: false,
          hint:
            lastFailureKind === "proxy_connect"
              ? "Playwright proxy CONNECT failed — not Akamai ATC; fix proxy tunnel or use HTTP lane without proxy"
              : "edge Access Denied before BM — not an ATC/header problem; rotate sticky AU proxy or stay on HTTP lane for WWW",
        },
      };
    }

    const { context, page, handlers, ipAddress } = successContext;

    // 2) PDP.
    const pdpUrl = /^https?:\/\//i.test(storeUrl) ? storeUrl : `${origin}/`;
    s0 = now();
    let pdpStatus = 0;
    try {
      const pdpRes = await page.goto(pdpUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      pdpStatus = pdpRes?.status() ?? 0;
      step(steps, "pdp_get", pdpStatus < 400, `status=${pdpStatus} url=${page.url()} ip=${ipAddress}`, s0);
      if (pdpStatus >= 400) {
        const html = await page.content().catch(() => "");
        const markers = ["akamai", "_abck", "bm_sz", "sbsd", "sec-cpt", "Access Denied"]
          .filter((m) => html.toLowerCase().includes(m.toLowerCase()));
        step(steps, "pdp_block", false, markers.length ? `markers=${markers.join(",")}` : html.replace(/\s+/g, " ").slice(0, 140));
      }
    } catch (e) {
      step(steps, "pdp_get", false, e?.message?.slice(0, 200) ?? "goto failed", s0);
      return {
        ok: false,
        steps,
        finalUrl: page.url(),
        cookies: cookieMap(await context.cookies()),
        dryRun,
        trace: {
          elapsedMs: now() - t0,
          hyperStatus: Object.fromEntries(handlers.map(({ name, handler }) => [name, handler.getStatus?.() ?? null])),
        },
      };
    }

    // Re-check trust after PDP nav (sensor may refresh).
    await waitForAbck(context, { timeoutMs: 12_000 });

    const sku = extractSkuFromUrl(page.url()) ?? extractSkuFromUrl(pdpUrl);
    step(steps, "pdp_sku", Boolean(sku), sku ?? "sku not found in URL");

    // 3) Add-to-cart in page context so api GraphQL runs inside Chromium.
    let cartOk = false;
    s0 = now();
    try {
      const btn = page
        .locator(
          'button:has-text("Add to cart"), button:has-text("ADD TO CART"), [data-testid*="add-to-cart" i], button:has-text("Add to bag"), button:has-text("ADD TO BAG")',
        )
        .first();
      await btn.waitFor({ state: "visible", timeout: 20_000 });
      await btn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400 + Math.random() * 600);
      await btn.click();
      await page.waitForTimeout(2500);
      cartOk = true;
      step(steps, "cart_add_click", true, "clicked add-to-cart", s0);
    } catch (e) {
      step(steps, "cart_add_click", false, e?.message?.slice(0, 160) ?? "click failed", s0);
    }

    // 4) Checkout warm in browser.
    if (cartOk) {
      s0 = now();
      try {
        const coRes = await page.goto(`${origin}/checkout`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const coStatus = coRes?.status() ?? 0;
        step(steps, "checkout_page", coStatus < 400, `status=${coStatus} url=${page.url()}`, s0);
      } catch (e) {
        step(steps, "checkout_page", false, e?.message?.slice(0, 200) ?? "goto failed", s0);
      }
    }

    const finalUrl = page.url();
    const cookies = cookieMap(await context.cookies());
    const abck = cookies._abck || "";
    const abckValid = /~0~/.test(abck);
    step(steps, "abck_check", abckValid, abckValid ? "_abck valid (~0~)" : `_abck=${abck.slice(0, 60)}…`);

    const hyperStatus = Object.fromEntries(handlers.map(({ name, handler }) => [name, handler.getStatus?.() ?? null]));

    // 5) Hybrid handoff → HTTP GraphQL checkout.
    const wantHandoff = task.httpHandoff !== false && cartOk && abckValid && ctx?.jar;
    if (wantHandoff) {
      try {
        await browser?.close?.();
      } catch {
        /* ignore */
      }
      browser = null;
      s0 = now();
      step(steps, "http_handoff_start", true, "closing browser; resuming GraphQL checkout via kmart HTTP adapter");
      try {
        const { kmartAdapter } = await import("./kmart.js");
        const cont = await kmartAdapter.run(
          {
            ...task,
            resumeFrom: "api",
            seedCookies: cookies,
            skipAtc: task.skipAtc === true,
            keycode: sku ?? undefined,
          },
          ctx,
        );
        step(steps, "http_handoff", cont?.ok !== false, `ok=${Boolean(cont?.ok)} order=${cont?.orderNumber ?? "null"}`, s0);
        return {
          ok: Boolean(cont?.ok),
          steps,
          finalUrl: cont?.finalUrl ?? finalUrl,
          cookies: cont?.cookies ?? cookies,
          dryRun: cont?.dryRun ?? dryRun,
          orderNumber: cont?.orderNumber ?? null,
          orderId: cont?.orderId ?? null,
          paymentStatus: cont?.paymentStatus ?? null,
          trace: {
            elapsedMs: now() - t0,
            hyperStatus,
            httpHandoff: true,
            httpTrace: cont?.trace,
          },
        };
      } catch (e) {
        step(steps, "http_handoff", false, e?.message?.slice(0, 200) ?? "handoff failed", s0);
      }
    } else if (task.httpHandoff !== false && cartOk && !abckValid) {
      step(steps, "http_handoff", false, "skipped: _abck not valid (~0~) — fix proxy/Akamai before GraphQL resume");
    }

    return {
      ok: cartOk && abckValid,
      steps,
      finalUrl,
      cookies,
      dryRun,
      trace: {
        elapsedMs: now() - t0,
        hyperStatus,
        httpHandoff: false,
      },
    };
  } finally {
    try {
      await browser?.close?.();
    } catch {
      /* ignore */
    }
  }
}

export const kmartPlaywrightAdapter = {
  id: "kmart-playwright",
  matches: (host) => host === "www.kmart.com.au" || host === "kmart.com.au",
  run,
};
