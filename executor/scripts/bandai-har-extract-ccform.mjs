#!/usr/bin/env node
/** Extract CreditCardForm field defaults from a Chromium HAR (no PAN dump). */
import fs from "node:fs";
import path from "node:path";

const harPath = process.argv[2] || path.join("artifacts", "bandai-chrome-browser.har");
const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
const entries = har?.log?.entries || [];
const cc = entries.find((e) => /CreditCardForm/i.test(e?.request?.url || ""));
if (!cc) {
  console.error("No CreditCardForm entry in HAR");
  process.exit(1);
}
let text = cc.response?.content?.text || "";
if (cc.response?.content?.encoding === "base64") {
  text = Buffer.from(text, "base64").toString("utf8");
}

const BOT_DEFAULTS = {
  "PaymentData.checkoutV2": "true",
  "PaymentData.gatewayId": "2",
  "PaymentData.paymentMethodId": "1",
  "PaymentData.createTransaction": "true",
  "PaymentData.checkoutCDNEnabled": "value",
  "PaymentData.customerScreenColorDepth": "24",
  "PaymentData.customerScreenWidth": "1280",
  "PaymentData.customerScreenHeight": "800",
  "PaymentData.customerTimeZoneOffset": "0",
  "PaymentData.customerLanguage": "en-AU",
  "PaymentData.IsValidationMessagesV2": "true",
};

function attr(tag, name) {
  const re = new RegExp(`${name}=["']([^"']*)["']`, "i");
  return (tag.match(re) || [])[1] ?? null;
}

const inputs = [];
for (const m of text.matchAll(/<input\b[^>]*>/gi)) {
  const tag = m[0];
  const name = attr(tag, "name");
  if (!name) continue;
  inputs.push({
    name,
    type: attr(tag, "type") || "text",
    value: attr(tag, "value") ?? "",
  });
}

const byName = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
const paymentNames = inputs.map((i) => i.name).filter((n) => /PaymentData|hiddenInput/i.test(n));
const action = (text.match(/<form\b[^>]*action=["']([^"']+)["']/i) || [])[1] || null;

const diffs = [];
for (const [k, botVal] of Object.entries(BOT_DEFAULTS)) {
  const browserVal = byName[k];
  if (browserVal == null) {
    diffs.push({ key: k, browser: "(absent)", bot: botVal });
  } else if (String(browserVal) !== String(botVal)) {
    diffs.push({ key: k, browser: String(browserVal).slice(0, 80), bot: botVal });
  }
}

const out = {
  harPath,
  ccUrl: cc.request.url,
  status: cc.response.status,
  htmlBytes: text.length,
  formAction: action,
  paymentFieldNames: paymentNames,
  browserValues: Object.fromEntries(
    paymentNames.map((n) => [
      n,
      /cardNum|cvdNumber/i.test(n)
        ? "<redacted>"
        : /machineId|token|CustomFields|UrlStructure/i.test(n)
          ? `<len:${String(byName[n] || "").length}>`
          : byName[n],
    ]),
  ),
  diffsVsBotDefaults: diffs,
  handleCreditCardInHar: entries.filter((e) => /HandleCreditCard/i.test(e.request?.url || "")).length,
};

const outPath = path.join("artifacts", "bandai-ccform-from-har.json");
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(`wrote ${outPath}`);
