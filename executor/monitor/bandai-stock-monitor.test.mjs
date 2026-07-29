// node --test executor/monitor/bandai-stock-monitor.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  createBandaiStockMonitor,
  normalizeCatalogCard,
  diffCatalog,
} from "./bandai-stock-monitor.js";
import { closeWithTimeout } from "./http-undici.js";
import { parseMonitorProxyList, createMonitorProxyPool } from "./monitor-proxy-pool.js";
import { createTaskStateMachine } from "./task-state-machine.js";

test("normalizeCatalogCard maps purchaseAvailable", () => {
  const row = normalizeCatalogCard({
    productCode: "N123",
    purchaseAvailable: true,
    flags: [],
    productName: "Demo",
  });
  assert.equal(row.productId, "N123");
  assert.equal(row.inStock, true);
  assert.equal(row.title, "Demo");
});

test("normalizeCatalogCard carries areaItemNos when present", () => {
  const row = normalizeCatalogCard({
    productCode: "N2542159011",
    purchaseAvailable: true,
    flags: [],
    areaItemNos: ["NAI0868879AU"],
  });
  assert.equal(row.areaItemNo, "NAI0868879AU");
  assert.deepEqual(row.areaItemNos, ["NAI0868879AU"]);
});

test("diffCatalog includes areaItemNo on restock events", () => {
  const prev = new Map([["N1", { productId: "N1", inStock: false }]]);
  const next = new Map([
    ["N1", { productId: "N1", inStock: true, areaItemNo: "NAI1", areaItemNos: ["NAI1"] }],
  ]);
  const ev = diffCatalog(prev, next);
  assert.equal(ev[0].reason, "restock");
  assert.equal(ev[0].areaItemNo, "NAI1");
});

test("normalizeCatalogCard treats OUT_OF_STOCK flag as oos", () => {
  const row = normalizeCatalogCard({
    productCode: "N123",
    purchaseAvailable: true,
    flags: ["OUT_OF_STOCK"],
  });
  assert.equal(row.inStock, false);
});

test("normalizeCatalogCard: search cards without purchaseAvailable use flags", () => {
  // Live AU search shape for N2890904001 — no purchaseAvailable field.
  const oos = normalizeCatalogCard({
    productCode: "N2890904001",
    saleStatus: "On",
    flags: ["OUT_OF_STOCK"],
    productName: { en: "GUNDAM CARD GAME 1st Anniversary Set" },
  });
  assert.equal(oos.inStock, false);
  assert.equal(oos.purchaseAvailable, false);

  const live = normalizeCatalogCard({
    productCode: "N2890904001",
    saleStatus: "On",
    flags: [],
    productName: { en: "GUNDAM CARD GAME 1st Anniversary Set" },
  });
  assert.equal(live.inStock, true);
  assert.equal(live.purchaseAvailable, true);
});

test("normalizeCatalogCard: explicit purchaseAvailable false stays oos", () => {
  const row = normalizeCatalogCard({
    productCode: "N1",
    purchaseAvailable: false,
    saleStatus: "On",
    flags: [],
  });
  assert.equal(row.inStock, false);
});

test("diffCatalog emits restock and new_in_stock", () => {
  const prev = new Map([
    ["A", { productId: "A", inStock: false }],
    ["B", { productId: "B", inStock: true }],
  ]);
  const next = new Map([
    ["A", { productId: "A", inStock: true, title: "A" }],
    ["B", { productId: "B", inStock: true }],
    ["C", { productId: "C", inStock: true, title: "New" }],
  ]);
  const ev = diffCatalog(prev, next);
  const reasons = ev.map((e) => `${e.productId}:${e.reason}`).sort();
  assert.deepEqual(reasons, ["A:restock", "C:new_in_stock"]);
});

test("parseMonitorProxyList skips comments", () => {
  const list = parseMonitorProxyList(`
# comment
example.com:1000:u:p
`);
  assert.equal(list.length, 1);
  assert.match(list[0], /^http:\/\/u:p@example\.com:1000$/);
});

test("proxy pool respects cooldown after markFail", () => {
  const pool = createMonitorProxyPool({
    ispRaw: "a.example:1000:u:p\nb.example:1000:u:p",
    dcRaw: "",
    ispRatio: 1,
    rotateMode: "roundrobin",
    cooldownMs: 60_000,
  });
  const first = pool.next();
  assert.equal(first.ok, true);
  pool.markFail(first.url);
  const second = pool.next();
  assert.equal(second.ok, true);
  assert.notEqual(second.url, first.url);
});

test("proxy pool recovers once when every exit is cooling", () => {
  const pool = createMonitorProxyPool({
    ispRaw: "only.example:1000:u:p",
    dcRaw: "",
    ispRatio: 1,
    rotateMode: "roundrobin",
    cooldownMs: 60_000,
  });
  const a = pool.next();
  assert.equal(a.ok, true);
  pool.markFail(a.url);
  const b = pool.next();
  assert.equal(b.ok, true);
  assert.equal(b.recoveredFromExhaustion, true);
  assert.equal(b.url, a.url);
  assert.equal(pool.stats().exhaustedRecoveries, 1);
});

test("task state machine monitoring → triggered", () => {
  const sm = createTaskStateMachine();
  sm.startMonitoring("t1", "N123");
  assert.equal(sm.get("t1").status, "monitoring");
  assert.equal(sm.listMonitoring("N123").length, 1);
  sm.transition("t1", "triggered", "stock");
  assert.equal(sm.get("t1").status, "triggered");
  assert.equal(sm.transitions().length >= 2, true);
});

test("closeWithTimeout returns even when close never resolves", async () => {
  const t0 = Date.now();
  await closeWithTimeout(
    {
      close: () => new Promise(() => {}),
    },
    200,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 180, `expected ~200ms, got ${elapsed}`);
  assert.ok(elapsed < 1_500, `hung too long: ${elapsed}ms`);
});

test("stop does not hang on stuck sticky dispatcher.close", async () => {
  const mon = createBandaiStockMonitor({
    intervalMs: 60_000,
    proxyPool: {
      next: () => ({ ok: false, error: "none" }),
      markFail() {},
      markOk() {},
      clearCooldowns() {},
      stats: () => ({}),
    },
  });
  mon._setStickyForTest({
    url: "http://u:p@hung.example:1000",
    tier: "isp",
    dispatcher: {
      close: () => new Promise(() => {}),
    },
  });
  const t0 = Date.now();
  await mon.stop();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3_000, `stop hung ${elapsed}ms on ProxyAgent.close`);
});
