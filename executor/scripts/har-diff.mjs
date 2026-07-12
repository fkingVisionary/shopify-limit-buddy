#!/usr/bin/env node
// HAR diff machine.
//
// Compares a successful Kmart browser HAR against an executor debug trace.
// It is intentionally conservative: values that naturally vary (ids, tokens,
// exact cookies) are redacted or shape-compared, while headers and operation
// ordering that influence Akamai/commercetools are reported precisely.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CRITICAL = [
  {
    key: "seed",
    host: "api.kmart.com.au",
    path: "/shopping-agent/v1/get-token",
    method: "POST",
    requiredHeaders: ["accept", "content-type", "origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "priority", "x-visitor-id", "newrelic", "traceparent", "tracestate"],
  },
  {
    key: "cart_get_initial",
    host: "api.kmart.com.au",
    op: "getMyActiveCart",
    ordinal: 1,
    requiredHeaders: ["cache-control", "pragma", "origin", "referer", "priority", "newrelic", "traceparent", "tracestate"],
  },
  {
    key: "cart_create",
    host: "api.kmart.com.au",
    op: "createMyBag",
    requiredHeaders: ["cache-control", "pragma", "origin", "referer", "priority", "newrelic", "traceparent", "tracestate"],
  },
  { key: "cart_probe_active", host: "api.kmart.com.au", op: "getActiveBag", ordinal: 1 },
  { key: "cart_probe_full", host: "api.kmart.com.au", op: "getMyActiveCart", ordinal: 3 },
  {
    key: "cart_atc",
    host: "api.kmart.com.au",
    op: "updateMyBag",
    requiredVariables: ["id", "version", "actions"],
    requiredHeaders: ["cache-control", "pragma", "origin", "referer", "priority", "newrelic", "traceparent", "tracestate"],
  },
  { key: "cart_verify", host: "api.kmart.com.au", op: "getMyActiveCart", ordinal: 4 },
  {
    key: "addr_shipping",
    host: "api.kmart.com.au",
    op: "updateMyBagWithoutBagStockAvailability",
    ordinal: 1,
    requiredVariables: ["id", "version", "actions"],
  },
  {
    key: "addr_billing",
    host: "api.kmart.com.au",
    op: "updateMyBagWithoutBagStockAvailability",
    ordinal: 2,
    requiredVariables: ["id", "version", "actions"],
  },
  {
    key: "paydock_tokenize",
    host: "api.paydock.com",
    path: "/v1/payment_sources/tokens",
    method: "POST",
    requiredHeaders: ["origin", "referer", "content-type", "x-user-public-key"],
  },
  {
    key: "create_3ds",
    host: "api.kmart.com.au",
    op: "create3DSToken",
    requiredVariables: ["oneTimeToken", "gatewayType", "useSavedCard", "saveCardOption"],
  },
  {
    key: "paydock_handle",
    host: "api.paydock.com",
    path: "/v1/charges/standalone-3ds/handle",
    method: "POST",
    requiredHeaders: ["origin", "referer", "content-type"],
  },
  {
    key: "paydock_process",
    host: "api.paydock.com",
    path: "/v1/charges/standalone-3ds/process",
    method: "POST",
    requiredHeaders: ["origin", "referer", "content-type", "x-access-token"],
  },
  { key: "soh_event", host: "api.kmart.com.au", op: "updateMyBagWithoutBagStockAvailability", ordinal: 3, optional: true },
  { key: "place_order", host: "api.kmart.com.au", op: "chargePayDockWithToken", optional: true },
];

const STEP_TO_KEY = {
  api_seed: "seed",
  api_get_token: "seed",
  cart_get: "cart_get_initial",
  cart_create: "cart_create",
  cart_probe1: "cart_probe_active",
  cart_probe2: "cart_probe_full",
  cart_atc: "cart_atc",
  cart_verify: "cart_verify",
  checkout_set_address: "addr_shipping",
  checkout_set_billing: "addr_billing",
  paydock_tokenize: "paydock_tokenize",
  create_3ds_token: "create_3ds",
  paydock_3ds_handle: "paydock_handle",
  paydock_3ds_process: "paydock_process",
  checkout_soh_event: "soh_event",
  place_order: "place_order",
  charge_paydock: "place_order",
};

function parseHost(url) {
  try { return new URL(url).host; } catch { return ""; }
}

function normalizeHeaders(headers) {
  if (Array.isArray(headers)) return Object.fromEntries(headers.map((h) => [String(h.name).toLowerCase(), String(h.value ?? "")]));
  return Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [String(k).toLowerCase(), String(v ?? "")]));
}

function parseBody(text) {
  if (!text) return { raw: null };
  try { return JSON.parse(text); } catch {}
  if (String(text).includes("=")) return Object.fromEntries(new URLSearchParams(text));
  return { raw: String(text).slice(0, 500) };
}

function queryHash(query) {
  if (!query) return null;
  return crypto.createHash("sha256").update(String(query).replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
}

function valueHash(value) {
  if (value == null || value === "") return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function shape(value) {
  if (Array.isArray(value)) return value.map((v) => shape(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  return typeof value;
}

function redact(value, key = "") {
  const k = String(key).toLowerCase();
  if (k.includes("card") || k.includes("ccv") || k.includes("cvv")) return "[redacted]";
  if (k.includes("token") || k.includes("jwt") || k.includes("access")) return "[redacted]";
  if (k === "email" || k === "phone") return "[redacted]";
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  if (typeof value === "string" && /^\d{12,19}$/.test(value)) return "[redacted]";
  return value;
}

function cookieNamesFromHeader(header) {
  return String(header ?? "").split(";").map((part) => part.trim().split("=")[0]).filter(Boolean);
}

function setCookieNamesFromHar(entry) {
  return (entry.response.headers ?? [])
    .filter((h) => String(h.name).toLowerCase() === "set-cookie")
    .map((h) => String(h.value).split(";")[0].split("=")[0])
    .filter(Boolean);
}

function normalizeHarEntry(entry, entryIndex, key) {
  const req = entry.request;
  const headers = normalizeHeaders(req.headers);
  const body = parseBody(req.postData?.text ?? "");
  const op = body.operationName ?? null;
  const variables = body.variables ?? null;
  const query = body.query ?? null;
  const url = new URL(req.url);
  return {
    key,
    entryIndex,
    host: url.host,
    path: url.pathname,
    method: req.method,
    status: entry.response.status,
    operationName: op,
    variables: redact(variables),
    variableShape: shape(variables),
    queryHash: queryHash(query),
    requestBody: redact(body),
    requestHeaders: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, name === "cookie" ? cookieNamesFromHeader(value).join("; ") : value])),
    cookieNames: cookieNamesFromHeader(headers.cookie),
    setCookieNames: setCookieNamesFromHar(entry),
  };
}

function matchesSpec(candidate, spec, ordinalCounts) {
  if (spec.host && candidate.host !== spec.host) return false;
  if (spec.path && candidate.path !== spec.path) return false;
  if (spec.method && candidate.method !== spec.method) return false;
  if (spec.op && candidate.operationName !== spec.op) return false;
  const countKey = `${spec.host}:${spec.path ?? ""}:${spec.op ?? ""}`;
  ordinalCounts[countKey] = (ordinalCounts[countKey] ?? 0) + 1;
  if (spec.ordinal && ordinalCounts[countKey] !== spec.ordinal) return false;
  return true;
}

function buildGolden(entries) {
  const hits = [];
  const used = new Set();
  let cursor = 0;
  for (const spec of CRITICAL) {
    for (let i = cursor; i < entries.length; i++) {
      const entry = entries[i];
      if (used.has(i) || entry.request.method === "OPTIONS") continue;
      const body = parseBody(entry.request.postData?.text ?? "");
      const url = new URL(entry.request.url);
      const candidate = { host: url.host, path: url.pathname, method: entry.request.method, operationName: body.operationName ?? null };
      if (matchesSpec(candidate, { ...spec, ordinal: undefined }, {})) {
        hits.push(normalizeHarEntry(entry, i, spec.key));
        used.add(i);
        cursor = i + 1;
        break;
      }
    }
  }
  return hits;
}

function normalizeTraceEntry(entry) {
  const body = typeof entry.requestBody === "string" ? parseBody(entry.requestBody) : (entry.requestBody ?? {});
  return {
    kind: entry.kind ?? "request",
    key: entry.key,
    entryIndex: "trace",
    host: entry.host,
    path: entry.path,
    method: entry.method,
    status: entry.status,
    operationName: entry.operationName ?? body.operationName ?? null,
    variables: redact(entry.variables ?? body.variables ?? null),
    variableShape: shape(entry.variables ?? body.variables ?? null),
    queryHash: queryHash(entry.query ?? body.query ?? null),
    requestBody: redact(body),
    requestHeaders: normalizeHeaders(entry.requestHeaders),
    cookieNames: entry.cookieNames ?? [],
    setCookieNames: entry.setCookieNames ?? [],
    raw: entry,
  };
}

function loadRun(runPath) {
  const raw = JSON.parse(fs.readFileSync(runPath, "utf8"));
  const trace = raw.trace ?? raw.result?.trace ?? raw.result?.result?.trace ?? [];
  const steps = raw.steps ?? raw.result?.steps ?? raw.result?.result?.steps ?? [];
  return { trace: trace.map(normalizeTraceEntry), steps };
}

function requestBodyKind(body) {
  if (body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "sensor_data")) return "akamai_sensor";
  if (body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "body")) return "sbsd_round";
  return "other";
}

function sameOriginKmartPath(path) {
  if (!path || path.startsWith("/assets/") || path.includes("/_next/")) return false;
  return path.split("/").filter(Boolean).length >= 4;
}

function normalizeHarTrustEntry(entry, entryIndex) {
  const req = entry.request;
  const url = new URL(req.url);
  const headers = normalizeHeaders(req.headers);
  const body = parseBody(req.postData?.text ?? "");
  const kind = requestBodyKind(body);
  const rawPayload = kind === "akamai_sensor" ? body.sensor_data : (kind === "sbsd_round" ? body.body : null);
  return {
    entryIndex,
    type: kind,
    method: req.method,
    host: url.host,
    path: url.pathname,
    search: url.search,
    status: entry.response.status,
    referer: headers.referer ?? null,
    origin: headers.origin ?? null,
    contentType: headers["content-type"] ?? null,
    secFetchSite: headers["sec-fetch-site"] ?? null,
    payloadBytes: rawPayload == null ? null : String(rawPayload).length,
    payloadHash: valueHash(rawPayload),
    cookieNames: cookieNamesFromHeader(headers.cookie),
    setCookieNames: setCookieNamesFromHar(entry),
  };
}

function buildTrustHar(entries) {
  const trust = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const req = entry.request;
    if (req.method === "OPTIONS") continue;
    let url;
    try { url = new URL(req.url); } catch { continue; }
    if (!url.host.endsWith("kmart.com.au")) continue;
    const body = parseBody(req.postData?.text ?? "");
    const kind = requestBodyKind(body);
    if (kind === "akamai_sensor") {
      trust.push(normalizeHarTrustEntry(entry, i));
      continue;
    }
    if (kind === "sbsd_round") {
      trust.push(normalizeHarTrustEntry(entry, i));
      continue;
    }
    if (req.method === "GET" && url.searchParams.has("v") && sameOriginKmartPath(url.pathname)) {
      trust.push({
        entryIndex: i,
        type: "script_fetch_with_v",
        method: req.method,
        host: url.host,
        path: url.pathname,
        search: url.search,
        status: entry.response.status,
        cookieNames: cookieNamesFromHeader(normalizeHeaders(req.headers).cookie),
        setCookieNames: setCookieNamesFromHar(entry),
      });
    }
  }
  return trust;
}

function eventType(entry) {
  return entry.raw?.type ?? entry.raw?.raw?.type ?? null;
}

function buildTrustRun(run) {
  const out = [];
  for (const normalized of run.trace) {
    const raw = normalized.raw ?? {};
    const type = raw.type ?? normalized.type;
    if (type === "sbsd_script_fetch") {
      let url = null;
      try { url = new URL(raw.scriptUrl); } catch {}
      out.push({
        type,
        key: raw.key,
        label: raw.label,
        method: "GET",
        host: url?.host ?? null,
        path: url?.pathname ?? null,
        search: url?.search ?? "",
        status: raw.status,
        scriptBytes: raw.scriptBytes,
        scriptHash: raw.scriptHash,
        setCookieNames: raw.setCookieNames ?? [],
        hasToken: raw.hasToken,
      });
    } else if (type === "sbsd_round") {
      let url = null;
      try { url = new URL(raw.postUrl); } catch {}
      out.push({
        type,
        key: raw.key,
        label: raw.label,
        round: raw.round,
        method: "POST",
        host: url?.host ?? null,
        path: url?.pathname ?? null,
        search: url?.search ?? "",
        status: raw.response?.status ?? raw.status,
        payloadBytes: raw.payload?.bytes ?? null,
        payloadHash: raw.payload?.hash ?? null,
        setCookieNames: raw.response?.setCookieNames ?? [],
        oCookieSource: raw.input?.oCookieSource ?? null,
        beforeCookies: raw.beforeCookies ?? null,
        afterCookies: raw.afterCookies ?? null,
      });
    } else if (type === "akamai_sensor_round") {
      let url = null;
      try { url = new URL(raw.scriptUrl); } catch {}
      out.push({
        type,
        key: raw.key,
        round: raw.round,
        method: "POST",
        host: url?.host ?? null,
        path: url?.pathname ?? null,
        search: url?.search ?? "",
        status: raw.response?.status ?? raw.status,
        payloadBytes: raw.payload?.bytes ?? null,
        payloadHash: raw.payload?.hash ?? null,
        setCookieNames: raw.response?.setCookieNames ?? [],
        bodySuccess: raw.response?.bodySuccess ?? null,
      });
    }
  }
  return out;
}

function printChecklist(hits) {
  console.log("\n=== KMART CHECKOUT — GOLDEN CHECKLIST ===\n");
  for (const spec of CRITICAL) {
    const hit = hits.find((h) => h.key === spec.key);
    const badge = hit ? `[✓ har #${hit.entryIndex} → ${hit.status}]` : (spec.optional ? "[· optional]" : "[MISSING]");
    console.log(`${badge} ${spec.key}`);
    if (hit) {
      console.log(`   ${hit.method} ${hit.host}${hit.path} op=${hit.operationName ?? "-"} q=${hit.queryHash ?? "-"}`);
      console.log(`   vars=${JSON.stringify(hit.variables).slice(0, 300)}`);
      console.log(`   requiredHeaders=${(spec.requiredHeaders ?? []).join(",") || "-"}`);
    }
    console.log();
  }
}

function missingHeaders(actual, required) {
  return (required ?? []).filter((h) => !actual.requestHeaders?.[h]);
}

function missingVars(actual, required) {
  return (required ?? []).filter((v) => !(actual.variables && Object.prototype.hasOwnProperty.call(actual.variables, v)));
}

function compareHit(golden, actual, spec) {
  const deltas = [];
  if (!actual) return ["missing from executor trace"];
  if (golden.method !== actual.method) deltas.push(`method ${actual.method} != ${golden.method}`);
  if (golden.host !== actual.host) deltas.push(`host ${actual.host} != ${golden.host}`);
  if (golden.path !== actual.path) deltas.push(`path ${actual.path} != ${golden.path}`);
  const mh = missingHeaders(actual, spec.requiredHeaders);
  if (mh.length) deltas.push(`missing headers: ${mh.join(",")}`);
  const mv = missingVars(actual, spec.requiredVariables);
  if (mv.length) deltas.push(`missing vars: ${mv.join(",")}`);
  if (golden.queryHash && actual.queryHash && golden.queryHash !== actual.queryHash) deltas.push(`query hash ${actual.queryHash} != ${golden.queryHash}`);
  if (golden.key === "seed" && !actual.requestHeaders["x-visitor-id"]) deltas.push("seed missing x-visitor-id");
  return deltas;
}

function diffAgainstRun(goldenHits, run) {
  console.log("\n=== DIFF: executor trace vs HAR ===\n");
  for (const spec of CRITICAL) {
    const golden = goldenHits.find((h) => h.key === spec.key);
    const actual = run.trace.find((h) => h.key === spec.key) || run.trace.find((h) => {
      if (spec.host && h.host !== spec.host) return false;
      if (spec.path && h.path !== spec.path) return false;
      if (spec.op && h.operationName !== spec.op) return false;
      return true;
    });
    const step = run.steps.find((s) => STEP_TO_KEY[s.step] === spec.key);
    if (!golden && spec.optional) {
      console.log(`${spec.key.padEnd(20)} optional in HAR`);
      continue;
    }
    if (!golden) {
      console.log(`${spec.key.padEnd(20)} HAR missing`);
      continue;
    }
    const deltas = compareHit(golden, actual, spec);
    const state = deltas.length ? "DELTA" : "MATCH";
    const status = actual ? `status=${actual.status}` : (step ? `step=${step.ok ? "pass" : "fail"}` : "not-run");
    console.log(`${spec.key.padEnd(20)} ${state} ${status}`);
    for (const d of deltas) console.log(`   - ${d}`);
    if (step && !step.ok) console.log(`   - step failed: ${String(step.note ?? "").slice(0, 180)}`);
  }
  console.log();
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "--help") {
  console.log("Usage: node executor/scripts/har-diff.mjs <har-path> [--json executor-run.json]");
  console.log("Executor run JSON should include result.trace; pass debugTrace:true to /run.");
  process.exit(argv[0] === "--help" ? 0 : 1);
}

const harPath = path.resolve(argv[0]);
const jsonIdx = argv.indexOf("--json");
const runPath = jsonIdx >= 0 ? path.resolve(argv[jsonIdx + 1]) : null;

const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
const entries = har.log.entries;
const golden = buildGolden(entries);
console.log(`Loaded HAR: ${entries.length} entries from ${harPath}`);
printChecklist(golden);
if (runPath) diffAgainstRun(golden, loadRun(runPath));