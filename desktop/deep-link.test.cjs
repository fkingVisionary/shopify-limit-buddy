// node --test desktop/deep-link.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildQuickTaskDeepLink,
  buildQuickTaskSetupDeepLink,
  buildEbaySoldUrl,
  parseQuickTaskDeepLink,
  quickTaskDiscordComponents,
  BRIDGE_PORT,
} = require("./deep-link.cjs");

test("build public /qt Quick Task URL (Discord-safe default)", () => {
  const url = buildQuickTaskDeepLink({
    productId: "N2890904001",
    title: "Gundam",
    areaItemNo: "NAI0859145AU",
    area: "au",
    reason: "restock",
  });
  assert.match(url, /\/qt\?/);
  assert.match(url, /^https:\/\//);
  assert.match(url, /sku=N2890904001/);
  assert.match(url, /nai=NAI0859145AU/);
  assert.ok(url.length <= 512);
});

test("build localhost bridge URL when scheme=local", () => {
  const url = buildQuickTaskDeepLink(
    { productId: "N2890904001", title: "Gundam" },
    { scheme: "local" },
  );
  assert.match(url, new RegExp(`http://127\\.0\\.0\\.1:${BRIDGE_PORT}/quicktask\\?`));
});

test("parse bridge + protocol links", () => {
  const a = parseQuickTaskDeepLink(
    `http://127.0.0.1:${BRIDGE_PORT}/quicktask?sku=N1&title=Demo&nai=NAI1&area=au`,
  );
  assert.equal(a.ok, true);
  assert.equal(a.payload.hit.productId, "N1");
  assert.equal(a.payload.hit.areaItemNo, "NAI1");
  assert.equal(a.payload.start, true);

  const b = parseQuickTaskDeepLink("j1ms://quicktask?sku=N2&title=X");
  assert.equal(b.ok, true);
  assert.equal(b.payload.sku, "N2");

  const c = parseQuickTaskDeepLink(
    `http://127.0.0.1:${BRIDGE_PORT}/quicktask?sku=N3&start=0`,
  );
  assert.equal(c.ok, true);
  assert.equal(c.payload.start, false);
});

test("discord components include Quick Task + Create only + Setup + eBay", () => {
  const comps = quickTaskDiscordComponents({
    productId: "N2890904001",
    title: "Gundam",
    area: "au",
  });
  assert.equal(comps[0].type, 1);
  const labels = comps[0].components.map((c) => c.label);
  assert.ok(labels.some((l) => /Quick Task/i.test(l)));
  assert.ok(labels.some((l) => /Create only/i.test(l)));
  assert.ok(labels.some((l) => /Setup presets/i.test(l)));
  assert.ok(labels.some((l) => /eBay sold/i.test(l)));
  const create = comps[0].components.find((c) => /Create only/i.test(c.label));
  assert.match(create.url, /start=0/);
  const btn = comps[0].components.find((c) => c.label.includes("Quick Task"));
  assert.ok(btn);
  assert.equal(btn.style, 5);
  assert.match(btn.url, /\/qt\?/);
  assert.match(btn.url, /^https:\/\//);
  assert.equal(/start=0/.test(btn.url), false);
});

test("setup deep link and ebay sold url", () => {
  assert.match(buildQuickTaskSetupDeepLink(), /\/qt-setup$/);
  const ebay = buildEbaySoldUrl({
    productId: "N1",
    title: "Premium Bandai METAL BUILD Gundam",
  });
  assert.match(ebay, /ebay\.com\.au/);
  assert.match(ebay, /LH_Sold=1/);
  assert.match(ebay, /METAL/);
  assert.equal(/premium\s+bandai/i.test(decodeURIComponent(ebay)), false);
});

test("PKC Quick Task deep link carries store + locale + url", () => {
  const url = buildQuickTaskDeepLink({
    productId: "189-85799",
    title: "Twilight ETB",
    store: "pokemoncentre",
    locale: "en-au",
    pdpUrl: "https://www.pokemoncenter.com/en-au/product/189-85799/twilight-etb",
    reason: "soft_listed",
  });
  assert.match(url, /store=pokemoncentre/);
  assert.match(url, /sku=189-85799/);
  assert.match(url, /locale=en-au/);
  assert.match(url, /url=https/);
  assert.ok(url.length <= 512);

  const parsed = parseQuickTaskDeepLink(
    `http://127.0.0.1:${BRIDGE_PORT}/quicktask?store=pokemoncentre&sku=189-85799&locale=en-au&url=https%3A%2F%2Fwww.pokemoncenter.com%2Fen-au%2Fproduct%2F189-85799%2Ftwilight&start=0`,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payload.store, "pokemoncentre");
  assert.equal(parsed.payload.locale, "en-au");
  assert.equal(parsed.payload.start, false);
  assert.match(parsed.payload.input, /pokemoncenter\.com/);
});
