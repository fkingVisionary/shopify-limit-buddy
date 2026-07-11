#!/usr/bin/env node
// HAR diff machine.
//
// Compares a real browser HAR (Kmart AU end-to-end checkout) against our
// executor's request timeline. Extracts the "golden" sequence from the HAR
// and prints per-step deltas (missing calls, header drift, variable drift).
//
// Usage:
//   node executor/scripts/har-diff.mjs <har-path> [--json executor-run.json]
//
// If no executor run json is supplied, it prints the golden checklist only
// (useful for scoping which requests we still need to implement).
//
// The golden checklist collapses noisy UI/analytics traffic and highlights
// only the calls that materially move the checkout forward:
//   1. api.kmart.com.au/shopping-agent/v1/get-token   (bot-manager seed)
//   2. GraphQL: getMyActiveCart / createMyBag / updateMyBag(addLineItem)
//   3. GraphQL: SetCustomPostcode + setShippingAddress + setBillingAddress
//   4. api.paydock.com/v1/payment_sources/tokens      (card → oneTimeToken)
//   5. GraphQL: create3DSToken                        (JWT session data)
//   6. api.paydock.com/v1/charges/standalone-3ds/handle    (→ charge_3ds_id)
//   7. api.paydock.com/v1/charges/standalone-3ds/process   (frictionless)
//   8. GraphQL: chargePayDockWithToken                (→ orderNumber)

import fs from "node:fs";
import path from "node:path";

const HAR_HOSTS = new Set([
  "www.kmart.com.au",
  "api.kmart.com.au",
  "auth.kmart.com.au",
  "api.paydock.com",
  "widget.paydock.com",
  "paydock.as1.gpayments.net",
]);

// Canonical order-critical operation names + their expected variable shape.
// The diff engine keys off (host + path + operationName).
const CRITICAL = [
  { key: "seed", host: "api.kmart.com.au", path: "/shopping-agent/v1/get-token", method: "POST", note: "Bot-manager seed. Body: {sessionId:<uuid>}. Sets ak_bmsc + bm_sv for api host." },
  { key: "cart_get", host: "api.kmart.com.au", op: "getMyActiveCart", note: "Guest cart probe. May return activeCart:null on first call." },
  { key: "cart_create", host: "api.kmart.com.au", op: "createMyBag", note: "Creates cart with postcodeSelector JSON + optional selectedCncStoreId." },
  { key: "cart_atc", host: "api.kmart.com.au", op: "updateMyBag", note: "addLineItem {sku,quantity,addToCartSource:'PDP'}." },
  { key: "cart_verify", host: "api.kmart.com.au", op: "getMyActiveCart", note: "Verify cart after ATC." },
  { key: "postcode", host: "api.kmart.com.au", op: "SetCustomPostcode", optional: true, note: "Optional — only if switching postcode." },
  { key: "addr_shipping", host: "api.kmart.com.au", op: "updateMyBagWithoutBagStockAvailability", note: "setShippingAddress with FULL address (streetName as '<number> <street>' string, company:'', deliveryInstructions:'', isAuthorisedToLeave:true, additionalAddressInfo:'{\"dpid\":null}', region:null)." },
  { key: "addr_billing", host: "api.kmart.com.au", op: "updateMyBagWithoutBagStockAvailability", note: "Same call with setShippingAddress + setBillingAddress. 3DS validator needs streetName/state/postalCode on billing." },
  { key: "paydock_tokenize", host: "api.paydock.com", path: "/v1/payment_sources/tokens", method: "POST", note: "PAN → UUID oneTimeToken. Uses x-user-public-key header." },
  { key: "create_3ds", host: "api.kmart.com.au", op: "create3DSToken", note: "Returns base64(JSON{content:<JWT>,format:'standalone_3ds'}). Variables: {oneTimeToken, gatewayType:'MasterCard', useSavedCard:false, saveCardOption:false}." },
  { key: "paydock_handle", host: "api.paydock.com", path: "/v1/charges/standalone-3ds/handle", method: "POST", note: "Query: ?x-access-token=<JWT extracted from create3DSToken>. Body: requestorTransId=<uuid>&event=InitAuthTimedOut&param=<base64 browser env>. Returns 302 with Location containing charge_3ds_id." },
  { key: "paydock_process", host: "api.paydock.com", path: "/v1/charges/standalone-3ds/process", method: "POST", note: "Header x-access-token=<second JWT from /handle response cookie or reused>. Body: {charge_3ds_id}. Returns {resource.data.result.frictionless:true} on success." },
  { key: "place_order", host: "api.kmart.com.au", op: "chargePayDockWithToken", note: "Variables: {type:'TOKEN_3DS', token:<charge_3ds_id>, gatewayType:'MasterCard', saveCard:false, isCreateAccount:false}. Returns orderNumber." },
];

function parseHost(url) {
  const m = /^https?:\/\/([^/]+)/.exec(url);
  return m ? m[1] : "";
}

function loadHar(harPath) {
  const raw = fs.readFileSync(harPath, "utf8");
  const har = JSON.parse(raw);
  return har.log.entries;
}

function extractOp(entry) {
  const pd = entry.request.postData?.text;
  if (!pd) return { op: null, variables: null };
  try {
    const j = JSON.parse(pd);
    return { op: j.operationName ?? null, variables: j.variables ?? null, query: j.query ?? null };
  } catch { return { op: null, variables: null }; }
}

function buildGolden(entries) {
  const hits = [];
  for (const [i, e] of entries.entries()) {
    if (e.request.method === "OPTIONS") continue;
    const host = parseHost(e.request.url);
    if (!HAR_HOSTS.has(host)) continue;
    const pathname = new URL(e.request.url).pathname;
    const { op, variables, query } = extractOp(e);
    for (const c of CRITICAL) {
      const hostOk = c.host === host;
      const pathOk = c.path ? c.path === pathname : true;
      const methodOk = c.method ? c.method === e.request.method : true;
      const opOk = c.op ? c.op === op : true;
      if (hostOk && pathOk && methodOk && opOk) {
        // For repeated ops (e.g. two updateMyBagWithoutBagStockAvailability),
        // keep the first hit per key unless key has a "*" suffix.
        if (!hits.find((h) => h.key === c.key)) {
          hits.push({
            key: c.key, entryIndex: i, host, method: e.request.method,
            url: e.request.url, path: pathname, status: e.response.status,
            op, variables, query,
            responseBody: (e.response.content?.text ?? "").slice(0, 2000),
            requestBody: pd ? pd.slice(0, 2000) : null,
          });
        }
        break;
      }
    }
  }
  return hits;
}

function printChecklist(hits) {
  console.log("\n=== KMART CHECKOUT — GOLDEN CHECKLIST (from HAR) ===\n");
  for (const c of CRITICAL) {
    const hit = hits.find((h) => h.key === c.key);
    const badge = hit ? `[✓ har entry #${hit.entryIndex} → ${hit.status}]` : (c.optional ? "[·] optional" : "[MISSING FROM HAR]");
    console.log(`${badge}  ${c.key}`);
    console.log(`   ${c.note}`);
    if (hit?.op) console.log(`   op=${hit.op}`);
    if (hit?.variables) console.log(`   vars=${JSON.stringify(hit.variables).slice(0, 260)}`);
    console.log();
  }
}

function loadRun(runPath) {
  const raw = fs.readFileSync(runPath, "utf8");
  return JSON.parse(raw);
}

// Map executor step names → checklist keys so we can spot missing steps.
const STEP_TO_KEY = {
  "api_seed": "seed",
  "api_get_token": "seed",
  "cart_get": "cart_get",
  "cart_create": "cart_create",
  "cart_atc": "cart_atc",
  "cart_verify": "cart_verify",
  "checkout_set_address": "addr_shipping",
  "checkout_set_billing": "addr_billing",
  "paydock_tokenize": "paydock_tokenize",
  "create_3ds_token": "create_3ds",
  "paydock_3ds_handle": "paydock_handle",
  "paydock_3ds_process": "paydock_process",
  "place_order": "place_order",
  "charge_paydock": "place_order",
};

function diffAgainstRun(hits, runResult) {
  const steps = runResult?.result?.steps ?? runResult?.steps ?? [];
  const runKeys = new Set(steps.map((s) => STEP_TO_KEY[s.step]).filter(Boolean));
  console.log("\n=== DIFF: executor run vs golden ===\n");
  for (const c of CRITICAL) {
    const inHar = Boolean(hits.find((h) => h.key === c.key));
    const inRun = runKeys.has(c.key);
    const step = steps.find((s) => STEP_TO_KEY[s.step] === c.key);
    const state = step ? (step.ok ? "PASS" : `FAIL (${step.note?.slice(0, 100) ?? ""})`) : (inRun ? "?" : "NOT ATTEMPTED");
    const flag = inHar && !inRun ? "  ← IMPLEMENT" : (inHar && step && !step.ok ? "  ← BROKEN" : "");
    console.log(`  ${c.key.padEnd(22)}  har=${inHar ? "y" : "-"}  run=${state}${flag}`);
  }
  console.log();
}

// ── CLI ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "--help") {
  console.log("Usage: node har-diff.mjs <har-path> [--json executor-run.json]");
  process.exit(argv[0] === "--help" ? 0 : 1);
}
const harPath = path.resolve(argv[0]);
const jsonIdx = argv.indexOf("--json");
const runPath = jsonIdx >= 0 ? path.resolve(argv[jsonIdx + 1]) : null;

const entries = loadHar(harPath);
console.log(`Loaded HAR: ${entries.length} entries from ${harPath}`);
const hits = buildGolden(entries);
printChecklist(hits);
if (runPath) {
  const run = loadRun(runPath);
  diffAgainstRun(hits, run);
}
