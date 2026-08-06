#!/usr/bin/env node
/**
 * Live probe: Bandai ATC-only via local executor sidecar (or EXECUTOR_URL).
 * Confirms addToCart_bridge recovery is available when undici ATC 501s.
 *
 * Usage (desktop running, engine up):
 *   node desktop/scripts/probe-atc-mode.cjs
 * Optional: BANDAI_E2E_SKU=N… EXECUTOR_URL=http://127.0.0.1:PORT EXECUTOR_TOKEN=…
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const dbPath = path.join(
  process.env.APPDATA || "",
  "vanta-desktop",
  "j1ms-desktop",
  "db.json",
);
const settingsPath = path.join(
  process.env.APPDATA || "",
  "vanta-desktop",
  "j1ms-desktop",
  "settings.json",
);

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          ...headers,
        },
        timeout: 180_000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, raw: raw.slice(0, 500) });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        headers,
        timeout: 15_000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, raw: raw.slice(0, 500) });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const db = loadJson(dbPath);
  const settings = fs.existsSync(settingsPath) ? loadJson(settingsPath) : {};
  const sku = String(process.env.BANDAI_E2E_SKU || "N2847916001").trim();
  const task =
    (db.tasks || []).find((t) => String(t.bandaiMode) === "atc" && String(t.bandaiWatchSku || "").includes(sku.replace(/^N/i, ""))) ||
    (db.tasks || []).find((t) => String(t.bandaiMode) === "atc") ||
    null;
  const profile = (db.profiles || []).find((p) => p.id === task?.profileId) || (db.profiles || [])[0];
  const acc =
    (db.accounts || []).find((a) => a.id === task?.accountId) ||
    (db.accounts || []).find((a) => String(a.store || a.storeId || "") === "bandai" && a.email && a.password) ||
    (db.accounts || []).find((a) => a.email && a.password);
  const pxGroup = (db.proxyGroups || []).find((g) => g.id === task?.proxyGroupId) || (db.proxyGroups || [])[0];
  const proxy = task?.assignedProxy || (pxGroup?.entries || [])[0] || null;
  if (!acc?.email || !acc?.password) throw new Error("No Bandai account in db");
  if (!proxy) throw new Error("No proxy in db");

  let base = String(process.env.EXECUTOR_URL || "").replace(/\/+$/, "");
  let token = String(process.env.EXECUTOR_TOKEN || settings.executorToken || "desktop-local").trim();
  if (!base) {
    // Probe common sidecar ports from a health sweep is hard — require env or read lock.
    // Desktop prints "executor listening on 0.0.0.0:PORT" — pass EXECUTOR_URL.
    throw new Error("Set EXECUTOR_URL=http://127.0.0.1:<sidecarPort> (from desktop console)");
  }

  const health = await getJson(`${base}/health`);
  console.log("health", health.status, health.json?.gitSha || health.json?.ok || health.raw);

  const runId = `probe_atc_${Date.now().toString(36)}`;
  const body = {
    taskId: runId,
    storeUrl: `https://p-bandai.com/au/item/${sku}`,
    pdpUrl: `https://p-bandai.com/au/item/${sku}`,
    variantId: 1,
    qty: 1,
    proxy,
    dryRun: true,
    placeOrder: false,
    bandaiMode: "atc",
    bandaiStopAtCart: true,
    bandaiF5Bridge: true,
    bandaiArea: "au",
    forceUndici: true,
    account: { email: acc.email, password: acc.password, id: acc.id || null },
    profile: profile
      ? {
          first_name: profile.first_name,
          last_name: profile.last_name,
          email: profile.email,
          phone: profile.phone,
          address1: profile.address1,
          city: profile.city,
          province: profile.province,
          zip: profile.zip,
        }
      : undefined,
  };

  console.log("POST /run ATC-only", { runId, sku, email: acc.email, proxyHost: String(proxy).split(":")[0] });
  const res = await postJson(`${base}/run`, body, { authorization: `Bearer ${token}` });
  const j = res.json || {};
  const steps = Array.isArray(j.steps) ? j.steps : [];
  const summary = {
    http: res.status,
    ok: j.ok,
    failedStep: j.failedStep,
    checkoutStage: j.checkoutStage,
    atcOnly: j.atcOnly,
    error: j.error || j.note || null,
    cartSn: j.cartSn || j.heldCart?.cartSn || null,
    steps: steps
      .filter((s) => /login|addToCart|cart_|f5_|product|shipping/i.test(String(s.step || "")))
      .map((s) => ({
        step: s.step,
        ok: s.ok,
        status: s.status,
        note: String(s.note || "").slice(0, 120),
      })),
  };
  console.log(JSON.stringify(summary, null, 2));
  const usedBridge = steps.some((s) => String(s.step) === "addToCart_bridge" && s.ok);
  const atcOk = steps.some((s) => /^addToCart/i.test(String(s.step)) && s.ok);
  const held =
    Boolean(j.ok) &&
    (Boolean(j.cartSn || j.heldCart?.cartSn) ||
      /^(cart|cart_hold)$/i.test(String(j.checkoutStage || "")) ||
      j.atcOnly === true);
  if (held && atcOk) {
    console.log("PASS: ATC-only held cart", usedBridge ? "(via bridge recovery)" : "(undici)");
    process.exit(0);
  }
  if (!atcOk && !usedBridge && /501/.test(JSON.stringify(steps))) {
    console.error("FAIL: undici ATC 501 and addToCart_bridge never ran — recovery still gated?");
    process.exit(2);
  }
  console.error("FAIL: ATC-only did not hold cart");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
