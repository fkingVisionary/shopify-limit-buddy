// Inspect Global-e CreditCardForm fields after Checkout/v2 boot + fill attempt.
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
const outDir = "/opt/cursor/artifacts/bandai-ge-form";
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  proxy: pw || undefined,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  locale: "en-AU",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1400, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(90_000);

async function dismissCookies() {
  for (const sel of ["#onetrust-accept-btn-handler", "button:has-text('Accept All Cookies')", "#accept-recommended-btn-handler"]) {
    const b = page.locator(sel).first();
    if ((await b.count()) && (await b.isVisible().catch(() => false))) {
      await b.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

async function dump(tag) {
  const frames = [];
  for (const f of page.frames()) {
    let html = "";
    let inputs = [];
    let text = "";
    let iframes = [];
    try {
      text = ((await f.locator("body").innerText({ timeout: 2000 })) || "").slice(0, 800);
      html = (await f.content()).slice(0, 8000);
      inputs = await f.evaluate(() =>
        [...document.querySelectorAll("input,select,textarea,button,iframe")].map((el) => ({
          tag: el.tagName,
          type: el.getAttribute("type"),
          name: el.getAttribute("name"),
          id: el.id,
          className: String(el.className || "").slice(0, 80),
          autocomplete: el.getAttribute("autocomplete"),
          placeholder: el.getAttribute("placeholder"),
          aria: el.getAttribute("aria-label"),
          src: el.getAttribute("src")?.slice(0, 120) || null,
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects?.().length),
          disabled: !!el.disabled,
          valueLen: "value" in el ? String(el.value || "").length : null,
          valuePreview:
            "value" in el && el.getAttribute("type") !== "password"
              ? String(el.value || "")
                  .replace(/\d(?=\d{4})/g, "*")
                  .slice(0, 24)
              : null,
          text: (el.innerText || "").slice(0, 60),
        })),
      );
      iframes = await f.evaluate(() =>
        [...document.querySelectorAll("iframe")].map((i) => ({
          src: (i.src || "").slice(0, 160),
          id: i.id,
          name: i.name,
          w: i.offsetWidth,
          h: i.offsetHeight,
        })),
      );
    } catch (e) {
      frames.push({ url: f.url().slice(0, 180), error: String(e.message || e).slice(0, 120) });
      continue;
    }
    frames.push({
      url: f.url().slice(0, 200),
      text,
      iframes,
      inputs: inputs.slice(0, 60),
      htmlHead: html.slice(0, 1500),
    });
  }
  fs.writeFileSync(`${outDir}/${tag}.json`, JSON.stringify(frames, null, 2));
  await page.screenshot({ path: `${outDir}/${tag}.png`, fullPage: true }).catch(() => {});
  console.log(tag, "frames", frames.length, "urls", frames.map((f) => f.url?.slice(0, 60)));
}

await page.goto("https://p-bandai.com/au/login", { waitUntil: "domcontentloaded" });
await dismissCookies();
await page.evaluate(async ({ email: em, password: pw }) => {
  const csrf = window.USER_DATA?.csrfToken || "";
  await fetch("/login", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      "x-g1-area-code": "au",
      "x-requested-with": "XMLHttpRequest",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: `grantType=password&memberId=${encodeURIComponent(em)}&password=${encodeURIComponent(pw)}&saveLoginId=false&autoLogin=false`,
    credentials: "include",
  });
}, { email, password });
await page.waitForTimeout(1500);

await page.goto("https://p-bandai.com/au/cart", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await dismissCookies();
const boxes = page.locator('input[type="checkbox"]:not([name^="ot-"])');
for (let i = 0; i < (await boxes.count()); i++) {
  const b = boxes.nth(i);
  if (!(await b.isChecked().catch(() => true))) await b.check({ force: true }).catch(() => {});
}
await page.locator('button:has-text("PROCEED TO CHECKOUT")').first().click();
await page.waitForURL(/orderdetails/i, { timeout: 60_000 }).catch(() => null);
await dismissCookies();
for (let i = 0; i < 50; i++) {
  if (page.frames().some((f) => /Checkout\/v2|CreditCardForm/i.test(f.url()))) break;
  await page.waitForTimeout(1000);
  if (i === 10) await dismissCookies();
}
await page.waitForTimeout(5000);
await dump("boot");

// Select credit card
for (const frame of page.frames()) {
  if (!/Checkout\/v2/i.test(frame.url())) continue;
  const opt = frame.locator('label:has-text("Credit Card"), label:has-text("Card")').first();
  if (await opt.count()) {
    await opt.click().catch(() => {});
    console.log("clicked card method");
  }
}
await page.waitForTimeout(4000);
await dump("after-method");

// Fill every plausible field in CreditCardForm + children
for (const frame of page.frames()) {
  if (!/CreditCardForm|secure-bandai|payments\//i.test(frame.url())) continue;
  console.log("filling frame", frame.url().slice(0, 100));
  const fields = await frame.evaluate(() =>
    [...document.querySelectorAll("input,select")].map((el, idx) => ({
      idx,
      name: el.getAttribute("name"),
      id: el.id,
      type: el.getAttribute("type"),
      autocomplete: el.getAttribute("autocomplete"),
      placeholder: el.getAttribute("placeholder"),
    })),
  );
  console.log("fields", fields);

  for (const f of fields) {
    const loc = f.id
      ? frame.locator(`#${CSS.escape(f.id)}`)
      : f.name
        ? frame.locator(`[name="${f.name}"]`)
        : null;
    if (!loc) continue;
    const key = `${f.autocomplete || ""} ${f.name || ""} ${f.id || ""} ${f.placeholder || ""}`.toLowerCase();
    try {
      if (/card.?number|cc-number|pan/.test(key)) {
        await loc.click();
        await loc.fill("");
        await loc.pressSequentially(pan, { delay: 30 });
      } else if (/exp-month|expmonth|month/.test(key) && !/year/.test(key)) {
        const tag = await loc.evaluate((el) => el.tagName);
        if (tag === "SELECT") await loc.selectOption({ value: mm }).catch(() => loc.selectOption({ label: mm }));
        else await loc.fill(mm);
      } else if (/exp-year|expyear|year/.test(key)) {
        const tag = await loc.evaluate((el) => el.tagName);
        if (tag === "SELECT") await loc.selectOption({ value: yy }).catch(() => loc.selectOption({ value: `20${yy}` }));
        else await loc.fill(yy);
      } else if (/cc-exp|expir/.test(key)) {
        await loc.fill(`${mm}/${yy}`);
      } else if (/cvv|cvc|csc|security/.test(key)) {
        await loc.fill(cvv);
      } else if (/name|holder/.test(key)) {
        await loc.fill(holder);
      }
    } catch (e) {
      console.log("fill fail", key, e.message?.slice(0, 80));
    }
  }
  await frame.evaluate(() => document.activeElement?.blur?.());
}

await page.waitForTimeout(3000);
await dump("after-fill");

// Pay button state
for (const frame of page.frames()) {
  if (!/Checkout\/v2/i.test(frame.url())) continue;
  const info = await frame.evaluate(() => {
    const buttons = [...document.querySelectorAll("button, input[type=submit]")].map((b) => ({
      text: (b.innerText || b.value || "").slice(0, 40),
      disabled: !!b.disabled,
      ariaDisabled: b.getAttribute("aria-disabled"),
      className: String(b.className || "").slice(0, 60),
    }));
    const errs = [...document.querySelectorAll(".error, .invalid, [class*=error], [class*=invalid], [role=alert]")]
      .map((e) => (e.innerText || "").slice(0, 120))
      .filter(Boolean);
    return { buttons, errs, body: (document.body?.innerText || "").slice(0, 600) };
  });
  console.log("checkout frame", JSON.stringify(info, null, 2));
  fs.writeFileSync(`${outDir}/checkout-state.json`, JSON.stringify(info, null, 2));
}

await browser.close();
console.log("wrote", outDir);
