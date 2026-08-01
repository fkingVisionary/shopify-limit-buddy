const test = require("node:test");
const assert = require("node:assert/strict");
const {
  checkoutResultDiscordPayload,
  publicCheckoutWinReport,
  normalizeEmbedFields,
  classifyCheckoutDiscordKind,
} = require("./discord-webhook.cjs");

test("embed field toggles hide order and email", () => {
  const payload = checkoutResultDiscordPayload(
    {
      ok: true,
      orderNumber: "ORD-1",
      account: { email: "secret@x.com" },
      price: "10",
    },
    {
      store: "bandai",
      label: "Product",
      kind: "success",
      profileName: "Prof",
      embedFields: normalizeEmbedFields({ order: false, email: false, proxy: false }),
    },
  );
  const names = payload.embeds[0].fields.map((f) => f.name);
  assert.ok(names.includes("Store"));
  assert.ok(!names.includes("Order"));
  assert.ok(!names.includes("Email"));
  assert.ok(!names.includes("Proxy"));
});

test("public win report never includes email or order", () => {
  const body = publicCheckoutWinReport(
    {
      ok: true,
      orderNumber: "SECRET",
      account: { email: "x@y.com" },
      productCode: "N2890904001",
    },
    { store: "bandai", label: "Gundam", pdpUrl: "https://p-bandai.com/au/item/N2890904001" },
  );
  assert.equal(body.sku, "N2890904001");
  assert.equal(body.orderNumber, undefined);
  assert.equal(body.email, undefined);
  assert.equal(body.profile, undefined);
});

test("success requires orderNumber", () => {
  assert.equal(classifyCheckoutDiscordKind({ ok: true, orderNumber: "1" }), "success");
  assert.equal(classifyCheckoutDiscordKind({ ok: true }), "skip");
});
