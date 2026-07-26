// node --test executor/monitor/disney-stock-monitor.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeDisneyCatalogCard,
  parseDisneySearchCatalog,
  diffCatalog,
} from "./disney-stock-monitor.js";
import { parseTaskWatch, resolveDisneyMonitorMode } from "./event-filter.js";
import { createGlobalMonitorHub } from "./global-monitor-hub.js";
import { EventEmitter } from "node:events";

test("normalizeDisneyCatalogCard in_stock vs sold out", () => {
  const ok = normalizeDisneyCatalogCard({
    id: "050368983992",
    name: "Lorcana Gateway",
    availability: "online - in_stock",
  });
  assert.equal(ok.productId, "050368983992");
  assert.equal(ok.inStock, true);

  const oos = normalizeDisneyCatalogCard({
    id: "050368983992",
    name: "Lorcana Gateway",
    availability: "online - out_of_stock",
  });
  assert.equal(oos.inStock, false);

  const soon = normalizeDisneyCatalogCard({
    id: "111",
    badge: "Coming Soon",
    availability: "",
  });
  assert.equal(soon, null); // pid too short
});

test("parseDisneySearchCatalog extracts tealium cards", () => {
  const html = `
    <div class="product-grid__tile" data-pid="050368983992">
      <div class="product__tile" data-tealium-productstring="{&quot;id&quot;:&quot;050368983992&quot;,&quot;name&quot;:&quot;Lorcana Gateway&quot;,&quot;availability&quot;:&quot;online - in_stock&quot;}">
      </div>
    </div>
    <div class="product-grid__tile" data-pid="050368984357">
      <div class="product__tile" data-tealium-productstring="{&quot;id&quot;:&quot;050368984357&quot;,&quot;name&quot;:&quot;Stitch Set&quot;,&quot;availability&quot;:&quot;online - out_of_stock&quot;}">
      </div>
    </div>
  `;
  const cat = parseDisneySearchCatalog(html);
  assert.equal(cat.size, 2);
  assert.equal(cat.get("050368983992").inStock, true);
  assert.equal(cat.get("050368984357").inStock, false);
  assert.match(cat.get("050368983992").title, /Lorcana/i);
});

test("diffCatalog emits restock for Disney rows", () => {
  const prev = new Map([
    ["050368983992", { productId: "050368983992", inStock: false, title: "X" }],
  ]);
  const next = new Map([
    ["050368983992", { productId: "050368983992", inStock: true, title: "X" }],
  ]);
  const ev = diffCatalog(prev, next);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].reason, "restock");
});

test("parseTaskWatch disney sku + pdp url + keywords", () => {
  const w = parseTaskWatch({
    disneyWatchSku: "050368983992",
    disneyWatchKeywords: "lorcana, stitch",
    pdpUrl:
      "https://www.disneystore.com.au/disney-lorcana-trading-card-game-by-ravensburger-gateway-050368984357.html",
  });
  assert.ok(w.productIds.includes("050368983992"));
  assert.ok(w.productIds.includes("050368984357"));
  assert.deepEqual(w.keywords.sort(), ["lorcana", "stitch"]);
});

test("resolveDisneyMonitorMode", () => {
  assert.equal(resolveDisneyMonitorMode({ disneyMonitorMode: "global" }), "global");
  assert.equal(resolveDisneyMonitorMode({ disneyMonitorMode: "local" }), "local");
  assert.equal(resolveDisneyMonitorMode({ disneyMode: "monitor" }), "local");
  assert.equal(resolveDisneyMonitorMode({ disneyMode: "pay" }), "off");
});

test("global hub filters Disney subscriptions", async () => {
  const fake = new EventEmitter();
  fake.start = () => {};
  fake.stop = async () => {};
  fake.status = () => ({ running: true });
  fake.off = (...a) => EventEmitter.prototype.off.call(fake, ...a);

  const hits = [];
  const hub = createGlobalMonitorHub({ monitor: fake, attachBridge: false });
  hub.subscribeTask(
    {
      taskId: "d-sku",
      disneyMonitorMode: "global",
      disneyWatchSku: "050368983992",
    },
    { onHit: (ev) => hits.push(`sku:${ev.productId}`) },
  );
  hub.subscribeTask(
    {
      taskId: "d-kw",
      disneyMonitorMode: "global",
      disneyWatchKeywords: "lorcana",
    },
    { onHit: (ev) => hits.push(`kw:${ev.productId}`) },
  );

  hub._injectStockChanged({
    productId: "050368983992",
    inStock: true,
    title: "Gateway",
  });
  hub._injectStockChanged({
    productId: "999",
    inStock: true,
    title: "Disney Lorcana Tin",
  });
  hub._injectStockChanged({
    productId: "111",
    inStock: true,
    title: "Mickey Mug",
  });

  assert.deepEqual(hits.sort(), ["kw:999", "sku:050368983992"]);
  hub.detach();
});
