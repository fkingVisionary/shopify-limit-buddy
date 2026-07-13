// Kmart AU — Playwright fallback lane.
//
// Runs a real Chromium via Playwright and lets `hyper-sdk-playwright`
// auto-handle Akamai sensor / SBSD challenges. Purpose: absolute backup
// when the raw-HTTP kmart adapter is blocked by Akamai (typically the
// api.kmart.com.au api-host `_abck` seeding that raw HTTP can't reproduce).
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

const UA_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

// Parse "user:pass@host:port" | "host:port" | "http://user:pass@host:port"
// into the shape Playwright's launch({proxy}) wants.
// Accepts:
//   http(s)://user:pass@host:port
//   user:pass@host:port
//   host:port
//   host:port:user:pass       (common residential-provider format)
//   host:port:user:pass:extra (e.g. sticky-session token appended to pass)
function parseProxy(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // host:port:user:pass[:...] — no scheme, no `@`, 4+ colon-parts
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
    const launchOpts = {
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
      ...(proxy ? { proxy } : {}),
    };
    s0 = now();
    try {
      browser = await playwright.chromium.launch({ channel: "chrome", ...launchOpts });
      step(steps, "browser_launch", true, `channel=chrome proxy=${Boolean(proxy)}`, s0);
    } catch (e) {
      browser = await playwright.chromium.launch(launchOpts);
      step(steps, "browser_launch", true, `channel=bundled proxy=${Boolean(proxy)} note=${e?.message?.slice(0, 80)}`, s0);
    }

    const context = await browser.newContext({
      userAgent: UA_WIN,
      locale: "en-AU",
      timezoneId: "Australia/Sydney",
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { "accept-language": "en-AU,en;q=0.9" },
    });

    // Resolve egress IP for the Hyper session context. Hyper recommends its
    // own helper endpoint because the IP passed to the solver must exactly
    // match the proxy egress used by the browser session.
    let ipAddress = "1.1.1.1";
    s0 = now();
    try {
      const ipPage = await context.newPage();
      let r = await ipPage.goto("https://api.hypersolutions.co/ip", { timeout: 15_000 });
      if (r?.ok()) {
        const body = (await r.text()).trim();
        const j = body.startsWith("{") ? JSON.parse(body) : null;
        ipAddress = j?.ip || j?.origin || body.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] || ipAddress;
      } else {
        r = await ipPage.goto("https://api.ipify.org?format=json", { timeout: 15_000 });
        if (r?.ok()) {
          const j = await r.json();
          if (j?.ip) ipAddress = j.ip;
        }
      }
      await ipPage.close();
      step(steps, "egress_ip", true, ipAddress, s0);
    } catch (e) {
      step(steps, "egress_ip", false, e?.message?.slice(0, 120) ?? "failed", s0);
    }

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const protectionEvents = [];
    page.on("response", async (res) => {
      const url = res.url();
      if (/akamai|bm_|_abck|sensor|sbsd|sec-cpt|ips\.js|datadome|reese|incapsula|kasada/i.test(url)) {
        protectionEvents.push(`${res.status()} ${url.slice(0, 120)}`);
        if (protectionEvents.length > 8) protectionEvents.shift();
      }
    });

    const session = new hyperSdk.Session(apiKey);
    const handlerConfigs = { session, ipAddress, acceptLanguage: "en-AU,en;q=0.9" };
    const handlers = [
      ["akamai", hyperPw.AkamaiHandler, { ...handlerConfigs, userAgent: UA_WIN }],
      ["datadome", hyperPw.DataDomeHandler, handlerConfigs],
      ["incapsula", hyperPw.IncapsulaHandler, handlerConfigs],
      ["kasada", hyperPw.KasadaHandler, handlerConfigs],
    ].filter(([, Handler]) => typeof Handler === "function")
      .map(([name, Handler, config]) => ({ name, handler: new Handler(config) }));

    s0 = now();
    await Promise.all(handlers.map(({ handler }) => handler.initialize(page, context)));
    step(steps, "protection_handlers_ready", true, `${handlers.map((h) => h.name).join("+")} interceptors installed`, s0);

    // 1) Warm home — catch network errors so earlier steps survive in the timeline.
    s0 = now();
    let homeRes = null;
    try {
      homeRes = await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      step(steps, "warm_home", homeRes?.ok() ?? false, `status=${homeRes?.status()}`, s0);
      if (homeRes && homeRes.status() >= 400) {
        const html = await page.content().catch(() => "");
        const markers = ["akamai", "_abck", "bm_sz", "sbsd", "sec-cpt", "Access Denied"]
          .filter((m) => html.toLowerCase().includes(m.toLowerCase()));
        step(steps, "warm_home_block", false, markers.length ? `markers=${markers.join(",")}` : html.replace(/\s+/g, " ").slice(0, 140));
      }
    } catch (e) {
      step(steps, "warm_home", false, e?.message?.slice(0, 200) ?? "goto failed", s0);
      return {
        ok: false,
        steps,
        finalUrl: storeUrl,
        cookies: {},
        dryRun,
        trace: {
          elapsedMs: now() - t0,
          hyperStatus: Object.fromEntries(handlers.map(({ name, handler }) => [name, handler.getStatus?.() ?? null])),
          hint: "warm_home failed — run POST /health/diagnose with the same proxy to separate CONNECT/auth from Playwright.",
        },
      };
    }
    await page.waitForTimeout(1500 + Math.random() * 1500);

    // 2) PDP.
    const pdpUrl = /^https?:\/\//i.test(storeUrl) ? storeUrl : `${origin}/`;
    s0 = now();
    let pdpStatus = 0;
    try {
      const pdpRes = await page.goto(pdpUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      pdpStatus = pdpRes?.status() ?? 0;
      step(steps, "pdp_get", pdpStatus < 400, `status=${pdpStatus} url=${page.url()}`, s0);
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
        cookies: Object.fromEntries((await context.cookies()).map((c) => [c.name, c.value])),
        dryRun,
        trace: {
          elapsedMs: now() - t0,
          hyperStatus: Object.fromEntries(handlers.map(({ name, handler }) => [name, handler.getStatus?.() ?? null])),
        },
      };
    }
    if (protectionEvents.length) step(steps, "protection_events", true, protectionEvents.join(" | "));

    const sku = extractSkuFromUrl(page.url()) ?? extractSkuFromUrl(pdpUrl);
    step(steps, "pdp_sku", Boolean(sku), sku ?? "sku not found in URL");

    // 3) Add-to-cart: click the real button so browser executes Kmart's own
    // GraphQL mutation from the page context. Selector is intentionally
    // permissive — Kmart's markup shifts.
    let cartOk = false;
    s0 = now();
    try {
      const btn = page.locator(
        'button:has-text("Add to cart"), button:has-text("ADD TO CART"), [data-testid*="add-to-cart" i]'
      ).first();
      await btn.waitFor({ state: "visible", timeout: 15_000 });
      await btn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400 + Math.random() * 600);
      await btn.click();
      // Wait briefly for the mini-cart / GraphQL round trip.
      await page.waitForTimeout(2500);
      cartOk = true;
      step(steps, "cart_add_click", true, "clicked add-to-cart", s0);
    } catch (e) {
      step(steps, "cart_add_click", false, e?.message?.slice(0, 160) ?? "click failed", s0);
    }

    // 4) Checkout warm in browser (keeps referer chain / cookies fresh).
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
    const jarArr = await context.cookies();
    const cookies = Object.fromEntries(jarArr.map((c) => [c.name, c.value]));
    const abck = cookies["_abck"] || "";
    const abckValid = /~0~/.test(abck);
    step(steps, "abck_check", abckValid, abckValid ? "_abck valid (~0~)" : `_abck=${abck.slice(0, 60)}…`);

    const hyperStatus = Object.fromEntries(handlers.map(({ name, handler }) => [name, handler.getStatus?.() ?? null]));

    // 5) Hybrid handoff: close Chromium, seed the HTTP jar, resume the
    //    GraphQL checkout chain (address → Paydock → 3DS → placeOrder).
    //    Opt out with task.httpHandoff === false.
    const wantHandoff = task.httpHandoff !== false && cartOk && abckValid && ctx?.jar;
    if (wantHandoff) {
      try { await browser?.close?.(); } catch { /* ignore */ }
      browser = null;
      s0 = now();
      step(steps, "http_handoff_start", true, "closing browser; resuming GraphQL checkout via kmart HTTP adapter");
      try {
        const { kmartAdapter } = await import("./kmart.js");
        // Shares ctx.steps / ctx.jar so continuation appends to this timeline.
        const cont = await kmartAdapter.run(
          {
            ...task,
            resumeFrom: "api",
            seedCookies: cookies,
            // Re-run GraphQL ATC with the seeded jar. Browser cart state is
            // not always visible to api.kmart.com.au via cookies alone.
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
    try { await browser?.close?.(); } catch { /* ignore */ }
  }
}

export const kmartPlaywrightAdapter = {
  id: "kmart-playwright",
  matches: (host) => host === "www.kmart.com.au" || host === "kmart.com.au",
  run,
};
