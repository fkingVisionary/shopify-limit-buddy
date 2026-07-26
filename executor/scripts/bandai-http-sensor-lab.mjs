// Lab: mint F5 p8komysnbc-* via short Chromium warm, apply to undici login/ATC.
// Not product code — proves whether HTTP checkout is realistic after sensor mint.
import fs from "node:fs";
import { chromium } from "playwright";
import { request, createJar, makeDispatcher } from "../http.js";
import {
  createBandaiSession,
  BANDAI_BASE,
  BANDAI_ORIGIN,
} from "../adapters/bandai-session.js";

function loadEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv("/tmp/bandai-lab-creds.env");

const email = process.env.BANDAI_EMAIL;
const password = process.env.BANDAI_PASSWORD;
const proxyRaw = process.env.BANDAI_PROXY;
if (!email || !password || !proxyRaw) {
  console.error("missing BANDAI_EMAIL/PASSWORD/PROXY");
  process.exit(1);
}

function parseProxy(raw) {
  // host:port:user:pass
  const parts = String(raw).split(":");
  if (parts.length < 4) throw new Error("bad proxy");
  const [host, port, user, ...rest] = parts;
  return {
    server: `http://${host}:${port}`,
    username: user,
    password: rest.join(":"),
    undici: raw,
  };
}

const proxy = parseProxy(proxyRaw);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function pushCookie(jar, name, value) {
  // createJar set API varies — use load dump merge
  const dump = jar.dump?.() || {};
  dump[name] = value;
  jar.load?.(dump);
}

async function mintSensorsInBrowser() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: UA,
      proxy: {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
      },
      locale: "en-AU",
    });
    const page = await context.newPage();
    const captured = { loginHeaders: null, cookies: null, seed: null };

    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      const u = req.url();
      if (!/\/login\/?$/.test(new URL(u).pathname)) return;
      const h = req.headers();
      const sensor = {};
      for (const [k, v] of Object.entries(h)) {
        if (/^p8komysnbc-/i.test(k)) sensor[k] = v;
      }
      if (Object.keys(sensor).length) {
        captured.loginHeaders = { ...h, _sensor: sensor };
      }
    });

    await page.goto(`${BANDAI_BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Give async common.js time to hook XHR/fetch
    await page.waitForTimeout(2500);

    const seedInfo = await page.evaluate(() => {
      const scripts = [...document.scripts].map((s) => s.src).filter(Boolean);
      const asyncSrc = scripts.find((s) => /common\.js\?async/i.test(s)) || null;
      return {
        asyncSrc,
        inlineVolt: Boolean(document.querySelector('script[src*="common.js?single"]')),
        cookie: document.cookie,
      };
    });
    captured.seed = seedInfo;

    // Trigger a real login fetch so the hook attaches sensor headers
    await page.evaluate(
      async ({ email: em, password: pw }) => {
        const csrf =
          window.USER_DATA?.csrfToken ||
          document.querySelector('meta[name="csrf-token"]')?.content ||
          "";
        await fetch("/login", {
          method: "POST",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/x-www-form-urlencoded;charset=utf-8",
            "x-g1-area-code": "au",
            "x-requested-with": "XMLHttpRequest",
            ...(csrf ? { "x-csrf-token": csrf } : {}),
          },
          body: new URLSearchParams({
            grantType: "password",
            memberId: em,
            password: pw,
            saveLoginId: "false",
            autoLogin: "false",
          }).toString(),
          credentials: "include",
        });
      },
      { email, password },
    );

    await page.waitForTimeout(1000);
    const cookies = await context.cookies();
    captured.cookies = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
    return captured;
  } finally {
    await browser.close();
  }
}

async function undiciLoginWithSensors(sensorHeaders, browserCookies) {
  const jar = createJar();
  const dispatcher = makeDispatcher(proxy.undici, { forceUndici: true });
  const ctx = { jar, dispatcher };
  const session = createBandaiSession(ctx, { userAgent: UA });

  // Seed jar with browser cookies (same sticky proxy / hopefully same exit)
  if (browserCookies && jar.load) jar.load(browserCookies);

  const warm = await session.warm();
  console.log("warm", warm);

  const body = new URLSearchParams({
    grantType: "password",
    memberId: email,
    password,
    saveLoginId: "false",
    autoLogin: "false",
  }).toString();

  const headers = {
    "user-agent": UA,
    accept: "application/json, text/plain, */*",
    "accept-language": "en",
    "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    "x-g1-area-code": "au",
    "x-requested-with": "XMLHttpRequest",
    origin: BANDAI_ORIGIN,
    referer: `${BANDAI_BASE}/login`,
    "sec-ch-ua": `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"macOS"`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
  if (session.state.csrfToken) headers["x-csrf-token"] = session.state.csrfToken;

  // Attach sensor headers from browser mint
  const sensor = sensorHeaders?._sensor || {};
  for (const [k, v] of Object.entries(sensor)) headers[k] = v;
  // Also try non-_sensor keys matching p8*
  if (sensorHeaders) {
    for (const [k, v] of Object.entries(sensorHeaders)) {
      if (/^p8komysnbc-/i.test(k)) headers[k] = v;
    }
  }

  console.log(
    "sensor keys",
    Object.keys(headers).filter((k) => /^p8komysnbc-/i.test(k)),
    "lens",
    Object.entries(headers)
      .filter(([k]) => /^p8komysnbc-/i.test(k))
      .map(([k, v]) => [k, String(v).length]),
  );

  const res = await request(
    `${BANDAI_ORIGIN}/login`,
    { method: "POST", headers, body },
    ctx,
  );
  const text = await res.text();
  jar.ingest?.(res.headers);
  console.log("login status", res.status);
  console.log("restricted", res.headers?.get?.("x-restricted-type"));
  console.log("body head", text.slice(0, 180).replace(/\s+/g, " "));
  console.log("jar keys", Object.keys(jar.dump()));

  // If login ok, try ATC
  if (res.status >= 200 && res.status < 300) {
    const atc = await session.apiJson("POST", "/api/cart/addToCart", {
      body: [{ areaItemNo: "AAI0013787AU", qty: 1 }],
      referer: `${BANDAI_BASE}/item/A2880191001`,
    });
    const atcText = atc.json ? JSON.stringify(atc.json).slice(0, 200) : await atc.res.text().then((t) => t.slice(0, 200));
    console.log("ATC", atc.status, atcText.replace(/\s+/g, " "));
  }

  await dispatcher.close?.();
}

const mode = process.argv[2] || "mint-and-http";
console.log("mode", mode);

if (mode === "mint-and-http") {
  const captured = await mintSensorsInBrowser();
  console.log("seedInfo", {
    asyncSrc: captured.seed?.asyncSrc?.slice(0, 140),
    inlineVolt: captured.seed?.inlineVolt,
    cookieNames: Object.keys(captured.cookies || {}),
  });
  console.log(
    "captured sensor keys",
    Object.keys(captured.loginHeaders?._sensor || {}),
  );
  fs.mkdirSync("/tmp/bandai-f5", { recursive: true });
  fs.writeFileSync(
    "/tmp/bandai-f5/captured-sensors.json",
    JSON.stringify(
      {
        sensor: captured.loginHeaders?._sensor || {},
        cookieNames: Object.keys(captured.cookies || {}),
        asyncSrc: captured.seed?.asyncSrc || null,
      },
      null,
      2,
    ),
  );
  await undiciLoginWithSensors(captured.loginHeaders, captured.cookies);
} else if (mode === "http-bare") {
  await undiciLoginWithSensors(null, null);
}
