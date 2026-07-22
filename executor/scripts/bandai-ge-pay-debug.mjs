// Lab: dump Global-e frames/fields/network around card fill + Pay.
// Card via /tmp/bandai-card.env — never commit.
import fs from "node:fs";
import { chromium } from "playwright";
import { parseBandaiProxy } from "../adapters/bandai-f5.js";

function loadEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv("/tmp/bandai-lab-creds.env");
loadEnv("/tmp/bandai-card.env");

function rotate(raw) {
  const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return String(raw).replace(/-session-[^-]+-/, `-session-${sid}-`);
}

const email = process.env.BANDAI_EMAIL;
const password = process.env.BANDAI_PASSWORD;
const proxyRaw = rotate(process.env.BANDAI_PROXY || "");
const pan = String(process.env.BANDAI_CARD_NUMBER || "").replace(/\s+/g, "");
const mm = String(process.env.BANDAI_CARD_EXP_MONTH || "").padStart(2, "0");
const yy = String(process.env.BANDAI_CARD_EXP_YEAR || "").replace(/^20/, "").slice(-2);
const cvv = String(process.env.BANDAI_CARD_CVV || "");
const holder = String(process.env.BANDAI_CARD_HOLDER || "Cardholder");
const pw = parseBandaiProxy(proxyRaw).playwright;

const outDir = "/tmp/bandai-ge-debug";
fs.mkdirSync(outDir, { recursive: true });

const net = [];
const browser = await chromium.launch({
  headless: true,
  proxy: pw || undefined,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  locale: "en-AU",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1360, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(90_000);

page.on("request", (req) => {
  const u = req.url();
  if (/global-e|payment|checkout|3ds|acs|authorize|token|creditcard/i.test(u)) {
    net.push({
      t: Date.now(),
      type: "req",
      method: req.method(),
      url: u.slice(0, 220),
      post: (req.postData() || "").slice(0, 200),
    });
  }
});
page.on("response", async (res) => {
  const u = res.url();
  if (/global-e|payment|checkout|3ds|acs|authorize|token|creditcard/i.test(u)) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    net.push({
      t: Date.now(),
      type: "res",
      status: res.status(),
      url: u.slice(0, 220),
      body,
    });
  }
});

async function dumpFrames(tag) {
  const frames = [];
  for (const f of page.frames()) {
    let text = "";
    let inputs = [];
    try {
      text = ((await f.locator("body").innerText({ timeout: 1500 })) || "").slice(0, 500);
    } catch {
      /* ignore */
    }
    try {
      inputs = await f.evaluate(() =>
        [...document.querySelectorAll("input,select,button,textarea")].slice(0, 40).map((el) => ({
          tag: el.tagName,
          type: el.getAttribute("type"),
          name: el.getAttribute("name"),
          id: el.id,
          autocomplete: el.getAttribute("autocomplete"),
          placeholder: el.getAttribute("placeholder"),
          visible: !!(el.offsetWidth || el.offsetHeight),
          valueLen: (el.value || "").length,
          text: (el.innerText || el.value || "").slice(0, 40),
        })),
      );
    } catch {
      /* ignore */
    }
    frames.push({ url: f.url().slice(0, 180), text, inputs });
  }
  fs.writeFileSync(`${outDir}/frames-${tag}.json`, JSON.stringify(frames, null, 2));
  await page.screenshot({ path: `${outDir}/shot-${tag}.png`, fullPage: true }).catch(() => {});
  console.log("dumped", tag, "frames", frames.length);
}

async function dismissCookies() {
  for (const sel of [
    "#onetrust-accept-btn-handler",
    "button:has-text('Accept All Cookies')",
    "#accept-recommended-btn-handler",
  ]) {
    const b = page.locator(sel).first();
    if ((await b.count()) && (await b.isVisible().catch(() => false))) {
      await b.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
      return;
    }
  }
}

// Login
await page.goto("https://p-bandai.com/au/login", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await dismissCookies();
await page.evaluate(async ({ email: em, password: pw }) => {
  const csrf = window.USER_DATA?.csrfToken || "";
  const res = await fetch("/login", {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      "x-g1-area-code": "au",
      "x-requested-with": "XMLHttpRequest",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: `grantType=password&memberId=${encodeURIComponent(em)}&password=${encodeURIComponent(pw)}&saveLoginId=false&autoLogin=false`,
    credentials: "include",
  });
  return { status: res.status, restricted: res.headers.get("x-restricted-type") };
}, { email, password });
await page.waitForTimeout(1500);
console.log("logged in");

// Cart → proceed
await page.goto("https://p-bandai.com/au/cart", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const areaBoxes = page.locator('input[type="checkbox"]');
const boxCount = await areaBoxes.count();
for (let i = 0; i < boxCount; i++) {
  const box = areaBoxes.nth(i);
  if (!(await box.isChecked().catch(() => true))) await box.check({ force: true }).catch(() => {});
}
const proceed = page.locator('button:has-text("PROCEED TO CHECKOUT")').first();
await Promise.all([
  page.waitForURL(/orderdetails/i, { timeout: 60_000 }).catch(() => null),
  proceed.click(),
]);
await page.waitForTimeout(6000);
console.log("checkoutSn", await page.evaluate(() => sessionStorage.getItem("bsp_checkout_sn")));
await dumpFrames("after-ge-boot");

// Wait card form
await page
  .waitForFunction(
    () =>
      [...document.querySelectorAll("iframe")].some((f) =>
        /CreditCardForm|secure-bandai\.global-e|payments\//i.test(f.src || ""),
      ),
    null,
    { timeout: 60_000 },
  )
  .catch(() => null);

// Select card method
for (const frame of page.frames()) {
  if (!/Checkout\/v2|webservices\.global-e/i.test(frame.url())) continue;
  const cardOpt = frame
    .locator('label:has-text("Credit Card"), label:has-text("Card"), button:has-text("Credit Card")')
    .first();
  if (await cardOpt.count().catch(() => 0)) {
    await cardOpt.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
}
await dumpFrames("before-fill");

// Fill — try every GE frame, including nested
let filled = false;
for (let tick = 0; tick < 25 && !filled; tick++) {
  await page.waitForTimeout(1200);
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!/global-e|CreditCard|payments/i.test(url)) continue;
    if (/prefetcher/i.test(url)) continue;
    const num = frame
      .locator(
        'input[autocomplete="cc-number"], input[name*="cardNumber" i], input[id*="cardNumber" i], input[placeholder*="card number" i]',
      )
      .first();
    if (!(await num.count().catch(() => 0))) continue;
    if (!(await num.isVisible().catch(() => false))) continue;

    await num.click({ timeout: 5000 }).catch(() => {});
    await num.fill("");
    await num.type(pan, { delay: 40 });

    const exp = frame
      .locator('input[autocomplete="cc-exp"], input[name*="expiry" i], input[placeholder*="MM" i]')
      .first();
    const mmEl = frame.locator('input[autocomplete="cc-exp-month"], select[name*="month" i], input[name*="expMonth" i]').first();
    const yyEl = frame.locator('input[autocomplete="cc-exp-year"], select[name*="year" i], input[name*="expYear" i]').first();
    const cvvEl = frame.locator('input[autocomplete="cc-csc"], input[name*="cvv" i], input[name*="cvc" i]').first();
    const nameEl = frame.locator('input[autocomplete="cc-name"], input[name*="cardHolder" i], input[name*="holder" i]').first();

    if (await exp.count().catch(() => 0)) {
      await exp.click().catch(() => {});
      await exp.fill(`${mm}/${yy}`);
    } else {
      if (await mmEl.count()) {
        const tag = await mmEl.evaluate((el) => el.tagName).catch(() => "");
        if (tag === "SELECT") await mmEl.selectOption({ value: mm }).catch(() => {});
        else await mmEl.fill(mm);
      }
      if (await yyEl.count()) {
        const tag = await yyEl.evaluate((el) => el.tagName).catch(() => "");
        if (tag === "SELECT") {
          await yyEl.selectOption({ value: yy }).catch(() => yyEl.selectOption({ value: `20${yy}` }));
        } else await yyEl.fill(yy);
      }
    }
    if (await cvvEl.count()) {
      await cvvEl.click().catch(() => {});
      await cvvEl.fill(cvv);
    }
    if (await nameEl.count()) {
      await nameEl.click().catch(() => {});
      await nameEl.fill(holder);
    }

    // Blur to trigger validation/tokenize
    await frame.evaluate(() => document.activeElement?.blur?.());
    filled = true;
    console.log("filled in", url.slice(0, 100));
    break;
  }
}
await page.waitForTimeout(4000);
await dumpFrames("after-fill");

// Look for validation errors
const errors = [];
for (const frame of page.frames()) {
  try {
    const t = await frame.locator("body").innerText({ timeout: 1000 });
    if (/invalid|error|required|incorrect|declin|try again/i.test(t)) {
      errors.push({ url: frame.url().slice(0, 120), hit: t.match(/.{0,40}(invalid|error|required|incorrect|declin|try again).{0,60}/i)?.[0] });
    }
  } catch {
    /* ignore */
  }
}
console.log("errors", errors);

// Click Pay and watch network 45s
let payUrl = null;
for (const frame of page.frames()) {
  const url = frame.url();
  if (!/Checkout\/v2|webservices\.global-e|secure-bandai/i.test(url)) continue;
  const payBtn = frame
    .locator('button:has-text("Pay"), button:has-text("Place Order"), button[type="submit"]')
    .first();
  if (await payBtn.count().catch(() => 0)) {
    const disabled = await payBtn.isDisabled().catch(() => false);
    const text = (await payBtn.innerText().catch(() => "")) || "";
    console.log("payBtn", { url: url.slice(0, 80), disabled, text: text.slice(0, 40) });
    if (!disabled && (await payBtn.isVisible().catch(() => false))) {
      await payBtn.click({ timeout: 10_000 });
      payUrl = url;
      break;
    }
  }
}
console.log("pay clicked", Boolean(payUrl), payUrl?.slice(0, 80));
await page.waitForTimeout(45_000);
await dumpFrames("after-pay");

fs.writeFileSync(
  `${outDir}/network.json`,
  JSON.stringify(
    net.map((n) => ({
      ...n,
      // redact pan if echoed
      post: String(n.post || "").replace(pan, "[PAN]"),
      body: String(n.body || "").replace(pan, "[PAN]"),
    })),
    null,
    2,
  ),
);
console.log(
  "interesting net",
  net
    .filter((n) => /pay|auth|3ds|token|charge|order|error/i.test(n.url + (n.body || "")))
    .slice(-30)
    .map((n) => `${n.type} ${n.status || n.method} ${n.url.slice(0, 100)}`),
);

await browser.close();
console.log("done →", outDir);
