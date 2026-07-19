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

/** Rotate sticky-session username so edge-denied retries mint a fresh exit. */
function rotateProxySession(proxy, attempt, { rotate } = {}) {
  if (!proxy?.username || !rotate) return proxy;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const username = /session-[A-Za-z0-9_-]+/i.test(proxy.username)
    ? proxy.username.replace(/session-[A-Za-z0-9_-]+/i, `session-${stamp}`)
    : `${proxy.username}-session-${stamp}`;
  return { ...proxy, username };
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

function markerLike(value) {
  const v = String(value ?? "");
  if (!v) return "(none)";
  const m = v.match(/~(-?\d+)~/);
  return `${v.length}b ind=${m?.[1] ?? "?"}`;
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

async function waitForAbck(context, { timeoutMs = 40_000 } = {}) {
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

function playwrightProxyToUrl(proxy) {
  if (!proxy?.server) return null;
  const host = String(proxy.server).replace(/^https?:\/\//i, "");
  if (proxy.username != null) {
    return `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || "")}@${host}`;
  }
  return `http://${host}`;
}

/**
 * When hyper-sdk-playwright leaves _abck at ind=-1 after WWW 200, run the same
 * Hyper HTTP sensor loop the kmart adapter uses (that path does reach ~0~).
 */
async function httpSensorAssist({
  cookies,
  html,
  pageUrl,
  proxy,
  egressIp,
  userAgent,
  push,
  attemptTag,
}) {
  const { parseAkamaiPath } = await import("hyper-sdk-js");
  const { makeDispatcher, createJar, request } = await import("../http.js");
  const { solveAkamaiSensor } = await import("../antibot.js");

  const scriptPath = parseAkamaiPath(html || "");
  if (!scriptPath) {
    push(`${attemptTag}:http_sensor`, false, "no akamai script path in warm HTML");
    return { ok: false, cookies };
  }

  const proxyUrl = playwrightProxyToUrl(proxy);
  const jar = createJar();
  jar.load(cookies || {});
  const dispatcher = makeDispatcher(proxyUrl, { forceUndici: true });
  const ctx = { dispatcher, jar };
  const origin = "https://www.kmart.com.au";
  const scriptUrl = origin + scriptPath;
  const acceptLang = "en-AU,en;q=0.9";

  let ip = egressIp;
  if (!ip || ip === "1.1.1.1") {
    try {
      const { resolveEgressIp } = await import("../ip-resolve.js");
      ip = (await resolveEgressIp(ctx, { force: true })) || ip;
      push(`${attemptTag}:http_sensor_ip`, Boolean(ip), ip || "(none)");
    } catch (e) {
      push(`${attemptTag}:http_sensor_ip`, false, e?.message?.slice(0, 80) ?? "ip failed");
    }
  }

  try {
    const scriptRes = await request(
      scriptUrl,
      {
        method: "GET",
        headers: {
          "user-agent": userAgent,
          "accept-language": acceptLang,
          accept: "*/*",
          referer: pageUrl,
          "sec-fetch-dest": "script",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-site": "same-origin",
        },
      },
      ctx,
    );
    const scriptBody = await scriptRes.text();
    push(`${attemptTag}:http_sensor_script`, scriptRes.status < 400, `${scriptBody.length}b path=${scriptPath}`);

    let prevContext = null;
    for (let i = 0; i < 3; i++) {
      const r = await solveAkamaiSensor({
        jar,
        pageUrl,
        userAgent,
        ip: ip,
        acceptLanguage: acceptLang,
        scriptUrl,
        scriptBody,
        prevContext,
        version: "3",
      });
      prevContext = r.context;
      const res = await request(
        r.postUrl,
        {
          method: "POST",
          headers: {
            "user-agent": userAgent,
            "content-type": "application/json",
            accept: "*/*",
            "accept-language": acceptLang,
            origin,
            referer: pageUrl,
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
          },
          body: JSON.stringify({ sensor_data: r.payload }),
        },
        ctx,
      );
      await res.text().catch(() => "");
      const abck = jar.get("_abck") || "";
      const ind = (abck.match(/~(-?\d+)~/) || [])[1] || "?";
      push(
        `${attemptTag}:http_sensor#${i + 1}`,
        res.status < 400,
        `status=${res.status} abck=${abck.length}b ind=${ind}`,
      );
      if (/~0~/.test(abck)) {
        push(`${attemptTag}:http_sensor:solved`, true, `rounds=${i + 1}`);
        return { ok: true, cookies: jar.dump() };
      }
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 200));
    }
    push(`${attemptTag}:http_sensor:unsolved`, false, "HTTP Hyper sensor rounds left _abck without ~0~");
    return { ok: false, cookies: jar.dump() };
  } finally {
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
  }
}

const now = () => Date.now();
function recordStep(steps, name, ok, note, startedAt = null, onProgress = null) {
  const ms = startedAt != null ? now() - startedAt : undefined;
  steps.push({ step: name, ok, ...(ms != null ? { ms } : {}), note });
  if (typeof onProgress === "function") {
    try {
      onProgress(name, note ? String(note).slice(0, 120) : null);
    } catch {
      /* ignore */
    }
  }
}

async function run(task, ctx) {
  // Share steps with checkout.js's catch handler so errors don't lose progress.
  const steps = ctx?.steps ?? [];
  if (ctx && !ctx.steps) ctx.steps = steps;
  const push = (name, ok, note, startedAt = null) =>
    recordStep(steps, name, ok, note, startedAt, ctx?.onProgress);
  const t0 = now();
  const dryRun = task.dryRun !== false;
  const storeUrl = String(task.storeUrl || "").replace(/\/$/, "");
  const origin = "https://www.kmart.com.au";
  const maxEdgeRetries = Math.max(1, Math.min(Number(task.pwEdgeRetries) || 3, 5));

  const apiKey = process.env.HYPER_API_KEY;
  if (!apiKey) {
    push("antibot_misconfigured", false, "HYPER_API_KEY missing on executor");
    return { ok: false, steps, finalUrl: storeUrl, cookies: {}, dryRun };
  }

  let browser = null;
  try {
    let s0 = now();
    const { playwright, hyperPw, hyperSdk } = await loadDeps();
    push("deps_loaded", true, "playwright + hyper-sdk-playwright ready", s0);

    const rawLen = task.proxy ? String(task.proxy).length : 0;
    const proxy = parseProxy(task.proxy);
    push("proxy_config", Boolean(proxy) || rawLen === 0, maskProxy(proxy, rawLen));
    if (rawLen > 0 && !proxy) {
      push("proxy_parse", false, `unrecognized proxy string (len=${rawLen})`);
      return { ok: false, steps, finalUrl: storeUrl, cookies: {}, dryRun };
    }

    // Desktop (no FLY_APP_NAME): headed Chrome clears Akamai more reliably than
    // headless. Fly/CI stay headless unless PW_HEADED=1.
    const headed =
      process.env.PW_HEADED === "1" ||
      (!process.env.FLY_APP_NAME && process.env.PW_HEADLESS !== "1");
    const launchOpts = {
      headless: headed ? false : true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      // Proxy is applied per-context so sticky sessions can rotate on edge deny.
    };
    s0 = now();
    let launchChannel = "bundled";
    // Prefer installed Chrome when available — on this Windows host it cleared
    // WWW warm_home (200) while bundled Chromium was edge-403'd on the same
    // residential pool. Fall back to Playwright's bundled build.
    try {
      browser = await playwright.chromium.launch({ channel: "chrome", ...launchOpts });
      launchChannel = "chrome";
      push("browser_launch", true, `channel=chrome headed=${headed} proxy=context proxyConfigured=${Boolean(proxy)}`, s0);
    } catch (e) {
      browser = await playwright.chromium.launch(launchOpts);
      launchChannel = "bundled";
      push(
        "browser_launch",
        true,
        `channel=bundled headed=${headed} proxy=context note=${e?.message?.slice(0, 100)}`,
        s0,
      );
    }

    // Keep the caller's sticky session. Noontide (session-…-sessTime-N) rejects
    // randomly minted session ids (CONNECT/SSL fail); only rotate on later
    // edge-deny retries, and never invent a sid for sessTime- providers.
    const baseProxy = proxy;
    const sessTimePinned = /sessTime-\d+/i.test(String(proxy?.username || ""));
    if (sessTimePinned) {
      push("proxy_session_keep", true, `sessTime pin — ${maskProxy(baseProxy, rawLen)}`);
    }

    const browserVersion = browser.version();
    const userAgent = chromeUaFromVersion(browserVersion);
    push("browser_ua", true, `version=${browserVersion} ua=${userAgent.slice(0, 90)} channel=${launchChannel}`);

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
    // Keep the sticky session when warm_home was 200 but _abck stayed ~-1~
    // (sensor_unsolved) — that IP already cleared the edge.
    for (let attempt = 1; attempt <= maxEdgeRetries; attempt++) {
      const attemptTag = `pw_attempt#${attempt}`;
      // sessTime- providers: keep the same session across retries (sid invent fails).
      const doRotate =
        attempt > 1 && lastFailureKind !== "sensor_unsolved" && !sessTimePinned;
      const attemptProxy = rotateProxySession(baseProxy, attempt, { rotate: doRotate });
      if (doRotate && attemptProxy?.username && attemptProxy.username !== baseProxy?.username) {
        push(`${attemptTag}:proxy_rotate`, true, `reason=${lastFailureKind} ${maskProxy(attemptProxy, rawLen)}`);
      } else if (attempt > 1 && sessTimePinned) {
        push(`${attemptTag}:proxy_keep`, true, `reason=${lastFailureKind} sessTime pin — same session`);
      }
      s0 = now();
      const context = await browser.newContext({
        userAgent,
        locale: "en-AU",
        timezoneId: "Australia/Sydney",
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: { "accept-language": "en-AU,en;q=0.9" },
        ...(attemptProxy ? { proxy: attemptProxy } : {}),
      });

      let ipAddress = "1.1.1.1";
      try {
        const ipPage = await context.newPage();
        const { ip, source } = await fetchEgressIp(ipPage, apiKey);
        ipAddress = ip;
        await ipPage.close();
        push( `${attemptTag}:egress_ip`, true, `${ipAddress} via=${source}`, s0);
      } catch (e) {
        push( `${attemptTag}:egress_ip`, false, e?.message?.slice(0, 120) ?? "failed", s0);
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
      push( `${attemptTag}:handlers`, true, handlers.map((h) => h.name).join("+"), s0);

      s0 = now();
      let homeStatus = 0;
      let homeHtml = "";
      try {
        const homeRes = await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
        homeStatus = homeRes?.status() ?? 0;
        homeHtml = await page.content().catch(() => "");
        push( `${attemptTag}:warm_home`, homeStatus > 0 && homeStatus < 400, `status=${homeStatus}`, s0);
      } catch (e) {
        const msg = e?.message?.slice(0, 200) ?? "goto failed";
        const connClosed = /ERR_CONNECTION_CLOSED|ERR_PROXY|ERR_TUNNEL|ECONNRESET|ECONNREFUSED/i.test(msg);
        push( `${attemptTag}:warm_home`, false, msg, s0);
        if (connClosed) {
          push(
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
        push(
          `${attemptTag}:edge_deny`,
          false,
          `IP ${ipAddress} blocked before Bot Manager (no sensor script for Hyper). cookies=[${Object.keys(lastCookies).join(",")}] markers=${markers.join(",") || "none"} — rotating context`,
        );
        lastFailureKind = "edge_deny";
        if (protectionEvents.length) push( `${attemptTag}:protection_events`, true, protectionEvents.join(" | "));
        await context.close().catch(() => {});
        continue;
      }

      // Give Hyper's route interceptor time to post sensors and mint ~0~.
      s0 = now();
      const abckWait = await waitForAbck(context, { timeoutMs: 40_000 });
      lastCookies = abckWait.cookies;
      push(
        `${attemptTag}:abck_wait`,
        abckWait.ok,
        abckWait.ok
          ? `_abck ~0~ after ${now() - s0}ms`
          : `_abck=${(lastCookies._abck || "").slice(0, 48)}… bm=${hasBotManagerSeed(lastCookies)}`,
        s0,
      );
      if (protectionEvents.length) push( `${attemptTag}:protection_events`, true, protectionEvents.join(" | "));

      if (!abckWait.ok) {
        // Playwright Hyper handlers posted sensors (often 200) but left ind=-1.
        // Fall back to the HTTP Hyper sensor loop that clears ~0~ on this lane.
        let assist = { ok: false, cookies: lastCookies };
        try {
          assist = await httpSensorAssist({
            cookies: lastCookies,
            html: homeHtml,
            pageUrl: `${origin}/`,
            proxy: attemptProxy,
            egressIp: ipAddress,
            userAgent,
            push,
            attemptTag,
          });
        } catch (e) {
          push(`${attemptTag}:http_sensor`, false, e?.message?.slice(0, 160) ?? "http sensor assist failed");
        }
        if (assist.ok) {
          const cookieList = Object.entries(assist.cookies || {})
            .filter(([name, value]) => {
              if (!name || value == null || String(value).length === 0) return false;
              // Only Bot Manager / Akamai cookies — other jar entries can trip
              // Playwright's Storage.setCookies validation.
              return /^(?:_abck|bm_[a-z0-9_]+|ak_bmsc|sbsd_o)$/i.test(name);
            })
            .map(([name, value]) => ({
              name,
              value: String(value).replace(/[\r\n\0]/g, ""),
              url: "https://www.kmart.com.au/",
            }));
          if (cookieList.length) {
            try {
              await context.addCookies(cookieList);
            } catch (e) {
              // Retry one-by-one so a single bad cookie doesn't abort the assist.
              let okN = 0;
              for (const c of cookieList) {
                try {
                  await context.addCookies([c]);
                  okN++;
                } catch {
                  /* skip invalid */
                }
              }
              push(`${attemptTag}:cookie_inject`, okN > 0, `injected=${okN}/${cookieList.length} err=${e?.message?.slice(0, 80)}`);
            }
          }
          lastCookies = cookieMap(await context.cookies());
          if (/~0~/.test(lastCookies._abck || "")) {
            push(`${attemptTag}:abck_http_assist`, true, "_abck ~0~ via HTTP Hyper sensor after Playwright warm");
            successContext = { context, page, handlers, ipAddress, protectionEvents, proxyUrl: playwrightProxyToUrl(attemptProxy) };
            push("warm_home_ok", true, `attempt=${attempt}/${maxEdgeRetries} ip=${ipAddress} via=http_sensor_assist`);
            break;
          }
          // Browser inject failed but HTTP jar has ~0~ — continue with HTTP-only handoff seed.
          if (/~0~/.test(String(assist.cookies?._abck || ""))) {
            push(`${attemptTag}:abck_http_assist`, true, "_abck ~0~ in HTTP jar; using assist cookies for handoff seed");
            successContext = {
              context,
              page,
              handlers,
              ipAddress,
              protectionEvents,
              seedCookies: assist.cookies,
              proxyUrl: playwrightProxyToUrl(attemptProxy),
            };
            push("warm_home_ok", true, `attempt=${attempt}/${maxEdgeRetries} ip=${ipAddress} via=http_sensor_assist_jar`);
            break;
          }
          push(
            `${attemptTag}:abck_http_assist`,
            false,
            `HTTP solved but browser jar missing ~0~ (browserAbck=${markerLike(lastCookies._abck)})`,
          );
        }
        lastFailureKind = "sensor_unsolved";
        push( `${attemptTag}:sensor_unsolved`, false, "Hyper handlers + HTTP assist left _abck without ~0~ — retrying fresh context");
        await context.close().catch(() => {});
        continue;
      }

      successContext = { context, page, handlers, ipAddress, protectionEvents, proxyUrl: playwrightProxyToUrl(attemptProxy) };
      push("warm_home_ok", true, `attempt=${attempt}/${maxEdgeRetries} ip=${ipAddress}`);
      break;
    }

    if (!successContext) {
      const proxyHint =
        lastFailureKind === "proxy_connect"
          ? `all ${maxEdgeRetries} Playwright attempts failed proxy CONNECT (ERR_CONNECTION_CLOSED). Chrome cannot tunnel this proxy — sticky HTTPS residential required, or leave Playwright off and use the HTTP lane (direct Fly egress currently clears cart_get/create).`
          : lastFailureKind === "sensor_unsolved"
            ? `all ${maxEdgeRetries} Playwright attempts got WWW 200 but _abck stayed ~-1~ (Hyper sensors did not solve). Try bundled Chromium + fresh sticky AU session, or leave Playwright off.`
            : `all ${maxEdgeRetries} Playwright attempts hard-denied at WWW edge (Hyper scriptUrl never captured). Use a sticky AU residential session, or leave Playwright off and keep the HTTP lane.`;
      push("warm_home", false, proxyHint);
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

    const { context, page, handlers, ipAddress, seedCookies, proxyUrl: solvedProxyUrl } = successContext;

    // Prefer HTTP-assist cookies when browser inject was partial.
    if (seedCookies && typeof seedCookies === "object") {
      const cookieList = Object.entries(seedCookies)
        .filter(([name, value]) => name && value != null && /^(?:_abck|bm_[a-z0-9_]+|ak_bmsc|sbsd_o)$/i.test(name))
        .map(([name, value]) => ({
          name,
          value: String(value).replace(/[\r\n\0]/g, ""),
          url: "https://www.kmart.com.au/",
        }));
      for (const c of cookieList) {
        try {
          await context.addCookies([c]);
        } catch {
          /* ignore */
        }
      }
    }

    // 2) PDP.
    const pdpUrl = /^https?:\/\//i.test(storeUrl) ? storeUrl : `${origin}/`;
    s0 = now();
    let pdpStatus = 0;
    try {
      const pdpRes = await page.goto(pdpUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      pdpStatus = pdpRes?.status() ?? 0;
      push("pdp_get", pdpStatus < 400, `status=${pdpStatus} url=${page.url()} ip=${ipAddress}`, s0);
      if (pdpStatus >= 400) {
        const html = await page.content().catch(() => "");
        const markers = ["akamai", "_abck", "bm_sz", "sbsd", "sec-cpt", "Access Denied"]
          .filter((m) => html.toLowerCase().includes(m.toLowerCase()));
        push("pdp_block", false, markers.length ? `markers=${markers.join(",")}` : html.replace(/\s+/g, " ").slice(0, 140));
      }
    } catch (e) {
      push("pdp_get", false, e?.message?.slice(0, 200) ?? "goto failed", s0);
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
    push("pdp_sku", Boolean(sku), sku ?? "sku not found in URL");

    // 3) Add-to-cart in page context so api GraphQL runs inside Chromium.
    let cartOk = false;
    s0 = now();
    // Expand ATC selectors — Kmart AU labels vary; also try bag / buy now.
    try {
      const btn = page
        .locator(
          [
            'button:has-text("Add to cart")',
            'button:has-text("ADD TO CART")',
            'button:has-text("Add to bag")',
            'button:has-text("ADD TO BAG")',
            'button:has-text("Add to Cart")',
            '[data-testid*="add-to-cart" i]',
            '[data-testid*="addToCart" i]',
            'button[aria-label*="add to cart" i]',
            'button[aria-label*="Add to bag" i]',
            'form[action*="cart"] button[type="submit"]',
          ].join(", "),
        )
        .first();
      await btn.waitFor({ state: "visible", timeout: 12_000 });
      await btn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400 + Math.random() * 600);
      await btn.click();
      await page.waitForTimeout(2500);
      cartOk = true;
      push("cart_add_click", true, "clicked add-to-cart", s0);
    } catch (e) {
      push("cart_add_click", false, e?.message?.slice(0, 160) ?? "click failed", s0);
    }

    // Fallback: GraphQL ATC from the page so api.kmart.com.au trust is minted
    // inside Chromium (HTTP handoff often 403s on cart_get without this).
    if (!cartOk && sku) {
      s0 = now();
      try {
        const gqlResult = await page.evaluate(async (skuCode) => {
          const endpoint = "https://api.kmart.com.au/gateway/graphql";
          const headers = {
            accept: "application/json",
            "content-type": "application/json",
            "apollographql-client-name": "kmart-web",
          };
          const post = async (operationName, query, variables) => {
            const res = await fetch(endpoint, {
              method: "POST",
              credentials: "include",
              headers: { ...headers, "x-operation-name": operationName },
              body: JSON.stringify({ operationName, query, variables }),
            });
            const text = await res.text();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* ignore */
            }
            return { status: res.status, json, text: text.slice(0, 200) };
          };
          const createQ =
            "mutation createMyCart($draft: MyCartDraft!) { createMyCart(draft: $draft) { id version __typename } }";
          const created = await post("createMyCart", createQ, {
            draft: { currency: "AUD", country: "AU", shippingAddress: { country: "AU" } },
          });
          const cart = created.json?.data?.createMyCart;
          if (!cart?.id) {
            return { ok: false, stage: "create", status: created.status, body: created.text };
          }
          const updateQ =
            "mutation updateMyCart($id: String!, $version: Long!, $actions: [MyCartUpdateAction!]!) { updateMyCart(id: $id, version: $version, actions: $actions) { id version lineItems { quantity variant { sku } } } }";
          const updated = await post("updateMyCart", updateQ, {
            id: cart.id,
            version: cart.version,
            actions: [{ addLineItem: { sku: skuCode, quantity: 1, addToCartSource: "PDP" } }],
          });
          const lines = updated.json?.data?.updateMyCart?.lineItems || [];
          const hasSku = lines.some((l) => l?.variant?.sku === skuCode);
          return {
            ok: updated.status < 400 && hasSku,
            stage: "update",
            status: updated.status,
            cartId: cart.id,
            hasSku,
            body: updated.text,
          };
        }, sku);
        cartOk = Boolean(gqlResult?.ok);
        push(
          "cart_add_gql",
          cartOk,
          `stage=${gqlResult?.stage} status=${gqlResult?.status} hasSku=${gqlResult?.hasSku} cart=${gqlResult?.cartId || "null"} ${String(gqlResult?.body || "").slice(0, 80)}`,
          s0,
        );
      } catch (e) {
        push("cart_add_gql", false, e?.message?.slice(0, 160) ?? "gql atc failed", s0);
      }
    }

    // 4) Checkout warm in browser.
    if (cartOk) {
      s0 = now();
      try {
        const coRes = await page.goto(`${origin}/checkout`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const coStatus = coRes?.status() ?? 0;
        push("checkout_page", coStatus < 400, `status=${coStatus} url=${page.url()}`, s0);
      } catch (e) {
        push("checkout_page", false, e?.message?.slice(0, 200) ?? "goto failed", s0);
      }
    }

    const finalUrl = page.url();
    let cookies = cookieMap(await context.cookies());
    if (seedCookies && /~0~/.test(String(seedCookies._abck || "")) && !/~0~/.test(cookies._abck || "")) {
      cookies = { ...cookies, ...seedCookies };
    }
    const abck = cookies._abck || "";
    const abckValid = /~0~/.test(abck);
    push("abck_check", abckValid, abckValid ? "_abck valid (~0~)" : `_abck=${abck.slice(0, 60)}…`);

    const hyperStatus = Object.fromEntries(handlers.map(({ name, handler }) => [name, handler.getStatus?.() ?? null]));

    // Try to scrape Paydock public key from the payment page while the
    // browser session is still warm — HTTP scrape often misses thin shells.
    let paydockPublicKey = null;
    try {
      const payRes = await page.goto(`${origin}/checkout/payment`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      const payHtml = await page.content().catch(() => "");
      const pkMatch =
        payHtml.match(/"(?:publicKey|public_key|paydockPublicKey)"\s*:\s*"([^"]{16,})"/i) ||
        payHtml.match(/publicKey\\?":\\?"([a-zA-Z0-9._-]{16,})/i) ||
        payHtml.match(/data-public-key=["']([a-zA-Z0-9._-]{16,})["']/i);
      paydockPublicKey = pkMatch?.[1] || null;
      push(
        "paydock_pk_browser",
        Boolean(paydockPublicKey) && (payRes?.status() ?? 0) < 400,
        paydockPublicKey
          ? `pk=${paydockPublicKey.slice(0, 12)}… status=${payRes?.status()}`
          : `status=${payRes?.status() ?? "?"} html=${payHtml.length}b`,
      );
    } catch (e) {
      push("paydock_pk_browser", false, e?.message?.slice(0, 120) ?? "payment goto failed");
    }

    // 5) Hybrid handoff → HTTP GraphQL checkout.
    // PDP 200 + valid _abck is enough — HTTP lane can ATC if the browser click missed.
    const wantHandoff = task.httpHandoff !== false && abckValid && ctx?.jar && pdpStatus < 400;
    if (wantHandoff) {
      try {
        await browser?.close?.();
      } catch {
        /* ignore */
      }
      browser = null;
      s0 = now();
      push(
        "http_handoff_start",
        true,
        cartOk
          ? "closing browser; resuming GraphQL checkout via kmart HTTP adapter"
          : "closing browser; HTTP adapter will ATC then checkout (browser click missed)",
      );
      try {
        if (solvedProxyUrl) {
          const { makeDispatcher } = await import("../http.js");
          try {
            await ctx.dispatcher?.close?.();
          } catch {
            /* ignore */
          }
          ctx.dispatcher = makeDispatcher(solvedProxyUrl, { forceUndici: true });
        }
        const { kmartAdapter } = await import("./kmart.js");
        const cont = await kmartAdapter.run(
          {
            ...task,
            proxy: solvedProxyUrl || task.proxy,
            resumeFrom: "api",
            seedCookies: cookies,
            skipAtc: cartOk === true,
            keycode: sku ?? undefined,
            ...(paydockPublicKey ? { paydockPublicKey } : {}),
          },
          ctx,
        );
        push("http_handoff", cont?.ok !== false, `ok=${Boolean(cont?.ok)} order=${cont?.orderNumber ?? "null"}`, s0);
        return {
          ok: Boolean(cont?.ok),
          steps,
          finalUrl: cont?.finalUrl ?? finalUrl,
          cookies: cont?.cookies ?? cookies,
          dryRun: cont?.dryRun ?? dryRun,
          orderNumber: cont?.orderNumber ?? null,
          orderId: cont?.orderId ?? null,
          paymentStatus: cont?.paymentStatus ?? null,
          paymentSummary: cont?.paymentSummary ?? null,
          checkoutStage: cont?.checkoutStage ?? null,
          paymentTail: cont?.paymentTail ?? null,
          lastSteps: cont?.lastSteps ?? null,
          trace: {
            elapsedMs: now() - t0,
            hyperStatus,
            httpHandoff: true,
            httpTrace: cont?.trace,
          },
        };
      } catch (e) {
        push("http_handoff", false, e?.message?.slice(0, 200) ?? "handoff failed", s0);
      }
    } else if (task.httpHandoff !== false && cartOk && !abckValid) {
      push("http_handoff", false, "skipped: _abck not valid (~0~) — fix proxy/Akamai before GraphQL resume");
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
