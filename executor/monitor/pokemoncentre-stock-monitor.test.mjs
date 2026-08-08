import assert from "node:assert/strict";
import {
  normalizePcCatalogCard,
  cortexScopeForLocale,
} from "./pokemoncentre-stock-monitor.js";
import { diffCatalog } from "./bandai-stock-monitor.js";
import { parseTaskWatch, eventMatchesWatch } from "./event-filter.js";

assert.equal(cortexScopeForLocale("en-au"), "pokemon-au");
assert.equal(cortexScopeForLocale("au"), "pokemon-au");
assert.equal(cortexScopeForLocale("us"), process.env.PC_US_SCOPE || "pokemon");

const avail = normalizePcCatalogCard({
  code: "10-10186-109",
  name: "PC ETB",
  availability: "AVAILABLE",
});
assert.equal(avail.productId, "10-10186-109");
assert.equal(avail.inStock, true);
assert.equal(avail.store, "pokemoncentre");

const pre = normalizePcCatalogCard({
  code: "10-99999-001",
  name: "Upcoming",
  availability: "AVAILABLE_FOR_PRE_ORDER",
});
assert.equal(pre.inStock, true);
assert.equal(pre.preorder, true);

const oos = normalizePcCatalogCard({
  code: "10-00000-000",
  availability: "SOLD_OUT",
});
assert.equal(oos.inStock, false);

const atcForm = normalizePcCatalogCard({
  code: "10-preload-1",
  addToCartForm: "/carts/items/pokemon/abc/form",
  epItemId: "abc",
});
assert.equal(atcForm.inStock, true);

const prev = new Map([["10-A", { productId: "10-A", inStock: false }]]);
const next = new Map([
  ["10-A", { productId: "10-A", inStock: true, preorder: true }],
  ["10-B", { productId: "10-B", inStock: true }],
]);
const events = diffCatalog(prev, next);
assert.equal(events.length, 2);
assert.ok(events.some((e) => e.reason === "restock" && e.productId === "10-A"));
assert.ok(events.some((e) => e.reason === "new_in_stock" && e.productId === "10-B"));

const watch = parseTaskWatch({
  pdpUrl: "https://www.pokemoncenter.com/en-us/product/10-10186-109/etb",
  pcWatchKeywords: "elite trainer",
});
assert.ok(watch.productIds.includes("10-10186-109"));
assert.ok(watch.keywords.includes("elite trainer"));

assert.equal(
  eventMatchesWatch(
    { productId: "10-10186-109", title: "ETB", inStock: true, store: "pokemoncentre" },
    { ...watch, store: "pokemoncentre" },
  ),
  true,
);
assert.equal(
  eventMatchesWatch(
    { productId: "10-10186-109", title: "ETB", inStock: true, store: "pokemoncentre" },
    { ...watch, store: "bandai" },
  ),
  false,
);

console.log("pokemoncentre-stock-monitor.test.mjs ok");
