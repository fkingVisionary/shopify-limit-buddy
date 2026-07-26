// node --test executor/monitor/event-filter.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskWatch,
  eventMatchesWatch,
  resolveBandaiMonitorMode,
} from "./event-filter.js";
import { createGlobalMonitorHub } from "./global-monitor-hub.js";
import { EventEmitter } from "node:events";

test("parseTaskWatch sku + keywords", () => {
  const w = parseTaskWatch({
    productId: "N123,N456",
    keywords: "ONE PIECE, gundam",
  });
  assert.deepEqual(w.productIds.sort(), ["N123", "N456"]);
  assert.deepEqual(w.keywords.sort(), ["gundam", "one piece"]);
});

test("parseTaskWatch from item URL", () => {
  const w = parseTaskWatch({
    pdpUrl: "https://p-bandai.com/au/item/N2903432003",
  });
  assert.ok(w.productIds.includes("N2903432003"));
});

test("eventMatchesWatch by sku and keyword", () => {
  assert.equal(
    eventMatchesWatch(
      { productId: "N2903432003", title: "Demo", inStock: true },
      { productIds: ["N2903432003"], keywords: [] },
    ),
    true,
  );
  assert.equal(
    eventMatchesWatch(
      { productId: "X1", title: "ONE PIECE Card", inStock: true },
      { productIds: [], keywords: ["one piece"] },
    ),
    true,
  );
  assert.equal(
    eventMatchesWatch(
      { productId: "X1", title: "Other", inStock: true },
      { productIds: ["N999"], keywords: ["gundam"] },
    ),
    false,
  );
});

test("resolveBandaiMonitorMode", () => {
  assert.equal(resolveBandaiMonitorMode({ bandaiMonitorMode: "global" }), "global");
  assert.equal(resolveBandaiMonitorMode({ bandaiMonitorMode: "local" }), "local");
  assert.equal(resolveBandaiMonitorMode({ bandaiMode: "monitor" }), "local");
  assert.equal(resolveBandaiMonitorMode({ bandaiMode: "checkout" }), "off");
});

test("global hub filters subscriptions without expanding poll", async () => {
  const fake = new EventEmitter();
  fake.start = () => {};
  fake.stop = async () => {};
  fake.status = () => ({ running: true });
  fake.off = (...a) => EventEmitter.prototype.off.call(fake, ...a);

  const hits = [];
  const hub = createGlobalMonitorHub({
    monitor: fake,
    attachBridge: false,
  });
  hub.subscribeTask(
    {
      taskId: "t-sku",
      bandaiMonitorMode: "global",
      productId: "N111",
    },
    { onHit: (ev) => hits.push(`sku:${ev.productId}`) },
  );
  hub.subscribeTask(
    {
      taskId: "t-kw",
      bandaiMonitorMode: "global",
      keywords: "gundam",
    },
    { onHit: (ev) => hits.push(`kw:${ev.productId}`) },
  );

  hub._injectStockChanged({
    productId: "N111",
    inStock: true,
    timestamp: Date.now(),
    title: "Something",
  });
  hub._injectStockChanged({
    productId: "N222",
    inStock: true,
    timestamp: Date.now(),
    title: "GUNDAM Model",
  });
  hub._injectStockChanged({
    productId: "N333",
    inStock: true,
    timestamp: Date.now(),
    title: "Unrelated",
  });

  assert.deepEqual(hits.sort(), ["kw:N222", "sku:N111"]);
  hub.detach();
});
