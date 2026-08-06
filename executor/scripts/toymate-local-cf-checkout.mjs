/**
 * Lab-only: solve Toymate CF in local Chromium (same sticky proxy), then
 * HTTP placeOrder via runCheckout. CapSolver AntiCloudflare cannot dial
 * some ISP proxies (ERROR custom proxy connect failed).
 *
 * Env: CAPSOLVER_API_KEY optional (spam reCAPTCHA still uses it),
 *      TOYMATE_PDP_URL, DESKTOP_E2E_TASK_ID profile/proxy from db,
 *      PAY_FORENSICS_PATH, PLACE_ORDER=1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { runCheckout } from "../checkout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function toProxyUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const p = s.split(":");
  if (p.length >= 4 && /^\d+$/.test(p[1])) {
    const [host, port, user, ...passParts] = p;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(passParts.join(":"))}@${host}:${port}`;
  }
  return null;
}

function parsePwProxy(proxyUrl) {
  const u = new URL(proxyUrl);
  return {
    server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`,
    username: decodeURIComponent(u.username || "") || undefined,
    password: decodeURIComponent(u.password || "") || undefined,
  };
}

const db = JSON.parse(
  fs.readFileSync(
    path.join(process.env.APPDATA, "vanta-desktop/j1ms-desktop/db.json"),
    "utf8",
  ),
);
const task =
  db.tasks.find((t) => t.id === (process.env.DESKTOP_E2E_TASK_ID || "task_toymate_dual_e2e")) ||
  db.tasks.find((t) => t.id === "task_c13e31bb45ce") ||
  db.tasks[0];
const profile = db.profiles.find((p) => p.id === task.profileId) || db.profiles[0];
const direct = process.env.TOYMATE_DIRECT === "1" || process.env.NO_PROXY === "1";
const groupId = process.env.DESKTOP_E2E_PROXY_GROUP_ID || task.proxyGroupId;
const group = !direct && groupId ? db.proxyGroups.find((g) => g.id === groupId) : null;
const raws = ((group && group.entries) || [])
  .map((x) => (typeof x === "string" ? x : x.url || x.raw || ""))
  .filter(Boolean);
const proxyIdx = Math.max(0, Number(process.env.TOYMATE_PROXY_INDEX || "0") | 0);
const proxyUrl = direct ? null : toProxyUrl(raws[proxyIdx] || raws[0]);
const pdp =
  process.env.TOYMATE_PDP_URL ||
  task.pdpUrl ||
  "https://toymate.com.au/lego-city-the-lego-van-60500/";
const placeOrder = process.env.PLACE_ORDER !== "0";
const forensics =
  process.env.PAY_FORENSICS_PATH ||
  path.join(os.tmpdir(), "j1m-pay-forensics-toymate-localcf.jsonl");
process.env.PAY_FORENSICS_PATH = forensics;

if (!direct && !proxyUrl) {
  console.error("no proxy (set TOYMATE_DIRECT=1 for home egress)");
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

console.log(
  JSON.stringify({
    phase: "local_cf_start",
    pdp,
    direct,
    proxyHost: proxyUrl ? new URL(proxyUrl).hostname : "(direct)",
    placeOrder,
    hasCapsolver: Boolean(process.env.CAPSOLVER_API_KEY),
    forensics,
  }),
);

const browser = await chromium.launch({
  headless: true,
  ...(proxyUrl ? { proxy: parsePwProxy(proxyUrl) } : {}),
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  userAgent: UA,
  locale: "en-AU",
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
await page.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

let cleared = false;
for (const url of ["https://www.toymate.com.au/", "https://toymate.com.au/", pdp]) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(8_000);
    const title = await page.title();
    const body = await page.locator("body").innerText().catch(() => "");
    const still =
      /just a moment/i.test(title) || /verify you are human|checking your browser/i.test(body);
    console.log(JSON.stringify({ nav: url, title: title.slice(0, 80), still }));
    if (!still) {
      cleared = true;
      break;
    }
  } catch (e) {
    console.log(JSON.stringify({ nav: url, err: String(e.message || e).slice(0, 120) }));
  }
}

const cookiesArr = await context.cookies();
const cookies = Object.fromEntries(cookiesArr.map((c) => [c.name, c.value]));
const ua = UA;
await browser.close();

console.log(
  JSON.stringify({
    phase: "local_cf_done",
    cleared,
    cookieKeys: Object.keys(cookies),
    hasCfClearance: Boolean(cookies.cf_clearance),
  }),
);

if (!cookies.cf_clearance && !cleared) {
  console.error("local Chromium did not clear CF — need CapSolver-compatible proxy");
  process.exit(3);
}

const pan = String(profile.card_number || "").replace(/\s+/g, "");
const res = await runCheckout({
  taskId: `toymate-localcf-${Date.now()}`,
  storeUrl: pdp,
  pdpUrl: pdp,
  variantId: 1,
  qty: 1,
  proxy: proxyUrl || undefined,
  dryRun: !placeOrder,
  placeOrder,
  forceUndici: true,
  toymateMode: "checkout",
  accountAssignSource: "guest",
  account: null,
  harvestedSession: {
    id: "local-cf-lab",
    proxy: proxyUrl || null,
    proxyHost: proxyUrl ? new URL(proxyUrl).hostname : "direct",
    userAgent: ua,
    cookies,
    harvestedAt: Date.now(),
    cfExpiresAt: Date.now() + 10 * 60_000,
  },
  card: {
    number: pan,
    expMonth: String(profile.card_exp_month || "").padStart(2, "0"),
    expYear: String(profile.card_exp_year || "").slice(-2),
    cvv: String(profile.card_cvv || ""),
    holder:
      profile.card_name ||
      [profile.first_name, profile.last_name].filter(Boolean).join(" ") ||
      "Cardholder",
  },
  profile: {
    email: profile.email,
    first_name: profile.first_name,
    last_name: profile.last_name,
    address1: profile.address1,
    city: profile.city,
    province: profile.province,
    zip: profile.zip,
    phone: profile.phone,
  },
  desktopTaskId: "task_toymate_dual_e2e",
  desktopRunId: `run_localcf_${Date.now().toString(16)}`,
});

const summary = {
  ok: res.ok,
  paymentStatus: res.paymentStatus,
  failedStep: res.failedStep,
  error: res.error,
  paymentAttempted: res.paymentAttempted,
  chargeReqCount: res.chargeReqCount ?? res.bigpayAuthPosts,
  bigpayAuthPosts: res.bigpayAuthPosts,
  note: String(res.note || "").slice(0, 300),
  lastSteps: (res.steps || res.lastSteps || []).slice(-14).map((s) => ({
    step: s.step,
    ok: s.ok,
    note: String(s.note || "").slice(0, 140),
  })),
  forensics,
};
fs.writeFileSync(
  path.join(root, "artifacts", "toymate-localcf-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
process.exit(res.paymentAttempted || res.ok ? 0 : 4);
