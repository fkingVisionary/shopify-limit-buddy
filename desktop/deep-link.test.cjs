// node --test desktop/deep-link.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildQuickTaskDeepLink,
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
});

test("discord components include Quick Task link button", () => {
  const comps = quickTaskDiscordComponents({
    productId: "N2890904001",
    title: "Gundam",
    area: "au",
  });
  assert.equal(comps[0].type, 1);
  const btn = comps[0].components.find((c) => c.label.includes("Quick Task"));
  assert.ok(btn);
  assert.equal(btn.style, 5);
  assert.match(btn.url, /\/qt\?/);
  assert.match(btn.url, /^https:\/\//);
});
