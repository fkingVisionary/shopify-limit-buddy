/**
 * Compare wall→ATC for:
 *   A) login → ATC  (current product order)
 *   B) ATC → login  (guest ATC first — expected 501, then login + retry)
 */
import fs from "node:fs";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { runCheckout } from "../checkout.js";
import { createBandaiF5Bridge, parseBandaiProxy } from "../adapters/bandai-f5.js";

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
const sku = process.env.BANDAI_SKU || "A2849039001";
const pool = fs
  .readFileSync(process.env.BANDAI_PROXY_POOL || "/tmp/bandai-proxy-pool.txt", "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const usedPath = "/tmp/bandai-proxy-used.json";
const used = fs.existsSync(usedPath) ? JSON.parse(fs.readFileSync(usedPath, "utf8")) : {};

function sessionTag(raw) {
  const m = String(raw).match(/session-([^-]+)/);
  return m ? m[1] : raw.slice(-12);
}

function nextProxy() {
  for (const line of pool) {
    const tag = sessionTag(line);
    if (!used[tag]) return { tag, proxy: line };
  }
  throw new Error("no free proxy");
}

function markUsed(tag, row) {
  used[tag] = { ...row, at: new Date().toISOString() };
  fs.writeFileSync(usedPath, JSON.stringify(used, null, 2));
}

const aest = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function runLoginThenAtc(proxy, tag) {
  const t0 = Date.now();
  const res = await runCheckout({
    taskId: `order-A-${tag}-${Date.now()}`,
    storeUrl: `https://p-bandai.com/au/item/${sku}`,
    pdpUrl: `https://p-bandai.com/au/item/${sku}`,
    qty: 1,
    proxy,
    dryRun: false,
    placeOrder: false,
    forceUndici: true,
    bandaiMode: "checkout",
    bandaiStopAtCart: true,
    bandaiFastAtc: true,
    account: { email, password },
  });
  const steps = (res.steps || [])
    .filter((s) => /f5_bridge|login|product_get|addToCart|cart_hold/.test(s.step))
    .map((s) => ({ step: s.step, ok: s.ok, ms: s.ms, note: String(s.note || "").slice(0, 100) }));
  return {
    order: "login → ATC",
    ok: Boolean(res.ok || steps.some((s) => s.step === "cart_hold" && s.ok)),
    atcWallMs: res.atcWallMs ?? steps.find((s) => s.step === "cart_hold")?.ms ?? null,
    wallMs: Date.now() - t0,
    fail: res.failedStep,
    cartSn: res.cartSn,
    steps,
  };
}

async function runAtcThenLogin(proxy, tag) {
  const t0 = Date.now();
  const marks = [];
  const mark = (k, extra = {}) => {
    const row = { ms: Date.now() - t0, k, ...extra };
    marks.push(row);
    console.log(`  B +${row.ms}ms ${k}`, extra.note || "");
    return row;
  };

  const bridge = await createBandaiF5Bridge({ proxy, area: "au" });
  await bridge.goto("https://p-bandai.com/au/login", { settleMs: 1400 });
  mark("f5_ready");

  let csrf = await bridge.csrfToken();
  // Use the F5 bridge page for all guest/logged-in XHRs so we share the same
  // proxy/TLS as Playwright (avoids undici ProxyAgent URL edge cases).
  async function api(method, path, { body, contentType } = {}) {
    const result = await bridge.page.evaluate(
      async ({ method: meth, path: p, body: b, contentType: ct, csrf: tok, areaCode }) => {
        try {
          const res = await fetch(p, {
            method: meth,
            credentials: "include",
            headers: {
              accept: "application/json, text/plain, */*",
              "x-g1-area-code": areaCode,
              "x-requested-with": "XMLHttpRequest",
              ...(tok ? { "x-csrf-token": tok } : {}),
              ...(b != null ? { "content-type": ct || "application/json" } : {}),
            },
            body: b == null ? undefined : typeof b === "string" ? b : JSON.stringify(b),
          });
          const text = await res.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* ignore */
          }
          return { status: res.status, json, text: text.slice(0, 160) };
        } catch (e) {
          return { status: 0, json: null, text: String(e?.message || e).slice(0, 160) };
        }
      },
      {
        method,
        path: path.startsWith("http") ? path : path,
        body: body ?? null,
        contentType: contentType || null,
        csrf,
        areaCode: "au",
      },
    );
    return result;
  }

  const prod = await api("GET", `/api/products/${sku}`);
  const areaItemNo = prod.json?.areaItemNo || prod.json?.product?.areaItemNo;
  mark("product_get", {
    note: `status=${prod.status} areaItemNo=${areaItemNo}`,
  });

  const atcBody = [{ areaItemNo, qty: 1 }];
  // Guest ATC via real browser XHR (common.js attaches sensors itself).
  const atc1 = await api("POST", "/api/cart/addToCart", { body: atcBody });
  const guestOk =
    atc1.status >= 200 &&
    atc1.status < 300 &&
    !/CouldNotAddToCart|PAGE NOT AVAILABLE|NETWORK CONGESTION/i.test(
      JSON.stringify(atc1.json || atc1.text),
    );
  const atcWallMsGuest = Date.now() - t0;
  mark("addToCart_before_login", {
    note: `ok=${guestOk} status=${atc1.status} ${JSON.stringify(atc1.json || atc1.text).slice(0, 100)}`,
  });

  // Login after guest ATC attempt (browser form POST — sensors via common.js).
  const loginBody = new URLSearchParams({
    grantType: "password",
    memberId: email,
    password,
    saveLoginId: "false",
    autoLogin: "false",
  }).toString();
  csrf = (await bridge.csrfToken()) || csrf;
  const login = await api("POST", "/login", {
    body: loginBody,
    contentType: "application/x-www-form-urlencoded;charset=UTF-8",
  });
  mark("login_after_atc", { note: `status=${login.status}` });

  const mem = await api("GET", "/api/context/member/refresh");
  if (mem.json?.csrfToken) csrf = mem.json.csrfToken;
  mark("member_refresh", {
    note: `status=${mem.status} member=${mem.json?.memberNo || "-"}`,
  });

  const atc2 = await api("POST", "/api/cart/addToCart", { body: atcBody });
  const loggedInOk =
    atc2.status >= 200 &&
    atc2.status < 300 &&
    !/CouldNotAddToCart|PAGE NOT AVAILABLE/i.test(JSON.stringify(atc2.json || atc2.text));
  const atcWallMsAfterLogin = Date.now() - t0;
  mark("addToCart_after_login", {
    note: `ok=${loggedInOk} status=${atc2.status} ${JSON.stringify(atc2.json || atc2.text).slice(0, 100)}`,
  });

  await bridge.close();
  return {
    order: "ATC → login → ATC retry",
    okGuestAtc: guestOk,
    ok: loggedInOk,
    atcWallMsGuest,
    atcWallMs: loggedInOk ? atcWallMsAfterLogin : atcWallMsGuest,
    wallMs: Date.now() - t0,
    guestStatus: atc1.status,
    guestNote: JSON.stringify(atc1.json || atc1.text).slice(0, 140),
    marks: marks.map((m) => `+${m.ms}ms ${m.k}`),
  };
}

console.log(`[${aest()} AEST] LOGIN_ATC_ORDER_LAB start sku=${sku}`);

let a = null;
if (process.env.BANDAI_ORDER_LAB_ONLY_B !== "1") {
  const aProxy = nextProxy();
  console.log(`\n=== A login→ATC proxy=${aProxy.tag} ===`);
  a = await runLoginThenAtc(aProxy.proxy, aProxy.tag);
  markUsed(aProxy.tag, { orderLab: "login_first", ok: a.ok });
  console.log("RESULT_A", JSON.stringify(a, null, 2));
} else {
  a = JSON.parse(fs.readFileSync("/tmp/bandai-login-atc-order-lab.json","utf8")).A_login_then_ATC;
  a = { order: "login → ATC", ok: a.ok, atcWallMs: a.atcWallMs, wallMs: a.wallMs, fail: a.fail, steps: a.steps, cartSn: null };
  console.log("RESULT_A (cached)", JSON.stringify(a, null, 2));
}

const bProxy = nextProxy();
console.log(`\n=== B ATC→login proxy=${bProxy.tag} ===`);
const b = await runAtcThenLogin(bProxy.proxy, bProxy.tag);
markUsed(bProxy.tag, { orderLab: "atc_first", ok: b.ok, guestOk: b.okGuestAtc });
console.log("RESULT_B", JSON.stringify(b, null, 2));

const summary = {
  at: new Date().toISOString(),
  aest: aest(),
  sku,
  currentProductOrder: "login → ATC (guest ATC is 501)",
  A_login_then_ATC: {
    ok: a.ok,
    atcWallMs: a.atcWallMs,
    wallMs: a.wallMs,
    fail: a.fail,
    steps: a.steps,
  },
  B_ATC_then_login: {
    okGuestAtc: b.okGuestAtc,
    okFinalAtc: b.ok,
    atcWallMsGuest: b.atcWallMsGuest,
    atcWallMsFinal: b.atcWallMs,
    wallMs: b.wallMs,
    guestStatus: b.guestStatus,
    guestNote: b.guestNote,
    marks: b.marks,
  },
  verdict:
    a.ok && !b.okGuestAtc
      ? "Keep login→ATC. Guest ATC before login does not hold a cart; final ATC after login is slower than A."
      : a.ok && b.okGuestAtc
        ? "Surprise: guest ATC worked — revisit order."
        : "See raw results.",
};
fs.writeFileSync("/tmp/bandai-login-atc-order-lab.json", JSON.stringify(summary, null, 2));
console.log(`\n[${aest()} AEST] SUMMARY`);
console.log(JSON.stringify(summary, null, 2));
