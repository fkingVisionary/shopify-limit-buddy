import assert from "node:assert/strict";
import {
  normalizePcCatalogCard,
  cortexScopeForLocale,
  diffPcCatalog,
  extractPcProductUrls,
  extractPcProductCardsFromHtml,
  buildPcAnnounceEvents,
  parsePcKeywordLists,
  matchesPcNegativeKeyword,
  PC_DEFAULT_KEYWORDS,
  PC_DEFAULT_NEGATIVE_KEYWORDS,
} from "./pokemoncentre-stock-monitor.js";
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
assert.equal(oos.softListed, true);

// Hours-ahead: NOT_AVAILABLE / coming soon must stay in catalog (not dropped).
const soft = normalizePcCatalogCard({
  code: "10-soft-1",
  name: "Soft ETB",
  availability: "NOT_AVAILABLE",
});
assert.equal(soft.inStock, false);
assert.equal(soft.softListed, true);

const coming = normalizePcCatalogCard({
  code: "10-soon-1",
  name: "Coming soon box",
  availability: "COMING_SOON",
});
assert.equal(coming.inStock, false);
assert.equal(coming.softListed, true);

// Search card with title but no availability enum → soft list.
const searchCard = normalizePcCatalogCard(
  { code: "10-search-1", name: "Mystery Bundle" },
  { source: "search:elite trainer" },
);
assert.equal(searchCard.inStock, false);
assert.equal(searchCard.softListed, true);

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
  ["10-C", { productId: "10-C", inStock: false, softListed: true, availability: "NOT_AVAILABLE" }],
]);
const events = diffPcCatalog(prev, next);
assert.equal(events.length, 3);
assert.ok(events.some((e) => e.reason === "restock" && e.productId === "10-A"));
assert.ok(events.some((e) => e.reason === "new_in_stock" && e.productId === "10-B"));
assert.ok(events.some((e) => e.reason === "soft_listed" && e.productId === "10-C" && e.inStock === false));

const urls = extractPcProductUrls(
  `
  <url><loc>https://www.pokemoncenter.com/en-au/product/10-11111-001/elite-trainer-box</loc></url>
  <a href="/en-au/product/10-22222-002/booster-bundle">x</a>
  https://www.pokemoncenter.com/en-us/product/10-11111-001/us-slug
  <a href="/product/10-33333-003/bare-path">soft-clear style</a>
  `,
  { locale: "en-au" },
);
assert.ok(urls.some((u) => u.sku === "10-11111-001" && u.locale === "en-au"));
assert.ok(urls.some((u) => u.sku === "10-22222-002"));
assert.ok(urls.some((u) => u.sku === "10-33333-003" && u.locale === "en-au"));
const au = urls.find((u) => u.sku === "10-11111-001");
assert.match(au.pdpUrl, /en-au\/product\/10-11111-001/);

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

const announce = buildPcAnnounceEvents(
  [
    {
      productId: "10-LIVE",
      inStock: true,
      source: "search:etb",
      title: "Live ETB",
    },
    {
      productId: "10-SOFT",
      inStock: false,
      softListed: true,
      availability: "NOT_AVAILABLE",
      source: "search:etb",
      title: "Soft ETB",
    },
    {
      productId: "10-SKU",
      inStock: true,
      source: "product_status",
    },
    {
      productId: "10-DISC",
      inStock: false,
      softListed: true,
      availability: "NOT_AVAILABLE",
      source: "category",
      title: "Discovery Soft",
      pdpUrl: "https://www.pokemoncenter.com/en-au/product/10-DISC/x",
    },
  ],
  { skus: ["10-SKU"], limit: 10 },
);
assert.ok(announce.some((e) => e.productId === "10-LIVE" && e.reason === "restock"));
assert.ok(announce.some((e) => e.productId === "10-SOFT" && e.reason === "soft_listed"));
assert.ok(announce.some((e) => e.productId === "10-SKU"));
assert.ok(announce.some((e) => e.productId === "10-DISC" && e.reason === "soft_listed"));

// Bare /product/{sku} extract (soft-clear style category HTML)
const bare = extractPcProductUrls('<a href="/product/10-BARE-001/slug">x</a>', {
  locale: "en-au",
});
assert.ok(bare.some((u) => u.sku === "10-BARE-001" && u.locale === "en-au"));

const cards = extractPcProductCardsFromHtml(
  `
  {"code":"10-LIVE-001","name":"Live ETB","availability":"AVAILABLE"}
  <a href="/en-au/product/10-CAT-002/booster-bundle">x</a>
  `,
  { locale: "en-au", source: "category" },
);
assert.ok(cards.some((c) => c.productId === "10-LIVE-001" && c.inStock === true));
// Category URL without OOS enum = live/in-stock (not soft_listed 🔴)
assert.ok(cards.some((c) => c.productId === "10-CAT-002" && c.inStock === true && !c.softListed));

const parsed = parsePcKeywordLists("TCG\n-binder\n-playmat\n-deck");
assert.deepEqual(parsed.keywords, ["TCG"]);
assert.ok(parsed.negativeKeywords.includes("binder"));
assert.ok(
  matchesPcNegativeKeyword(
    { title: "Premium Binder", slug: "premium-binder", productId: "10-X" },
    parsed.negativeKeywords,
  ),
);
assert.ok(
  !matchesPcNegativeKeyword(
    { title: "Booster Bundle", slug: "booster-bundle", productId: "10-Y" },
    parsed.negativeKeywords,
  ),
);
assert.ok(PC_DEFAULT_KEYWORDS.includes("TCG"));
assert.ok(PC_DEFAULT_NEGATIVE_KEYWORDS.includes("binder"));

console.log("pokemoncentre-stock-monitor.test.mjs ok");
