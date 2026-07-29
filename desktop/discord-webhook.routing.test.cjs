const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveDiscordWebhookUrl,
  classifyCheckoutDiscordKind,
  looksLike3ds,
  checkoutResultDiscordPayload,
} = require("./discord-webhook.cjs");

test("resolveDiscordWebhookUrl routes with fallbacks", () => {
  const s = {
    discordSuccessWebhook: "https://discord.com/api/webhooks/s/x",
    discordFailWebhook: "https://discord.com/api/webhooks/f/x",
    discord3dsWebhook: "https://discord.com/api/webhooks/3/x",
    discordMonitorWebhook: "https://discord.com/api/webhooks/m/x",
  };
  assert.match(resolveDiscordWebhookUrl(s, "success"), /\/s\//);
  assert.match(resolveDiscordWebhookUrl(s, "fail"), /\/f\//);
  assert.match(resolveDiscordWebhookUrl(s, "threeds"), /\/3\//);
  assert.match(resolveDiscordWebhookUrl(s, "monitor"), /\/m\//);

  const legacy = { discordCheckoutWebhook: "https://discord.com/api/webhooks/c/x" };
  assert.match(resolveDiscordWebhookUrl(legacy, "success"), /\/c\//);
  assert.match(resolveDiscordWebhookUrl(legacy, "fail"), /\/c\//);
  assert.match(resolveDiscordWebhookUrl(legacy, "threeds"), /\/c\//);

  const legacyMon = { discordMonitorWebhook: "https://discord.com/api/webhooks/legacy/x" };
  assert.match(resolveDiscordWebhookUrl(legacyMon, "success"), /\/legacy\//);
  assert.match(resolveDiscordWebhookUrl(legacyMon, "monitor"), /\/legacy\//);
});

test("classifyCheckoutDiscordKind success fail 3ds skip", () => {
  assert.equal(classifyCheckoutDiscordKind({ ok: true, orderNumber: "1" }), "success");
  assert.equal(classifyCheckoutDiscordKind({ ok: false, error: "timeout" }), "fail");
  assert.equal(
    classifyCheckoutDiscordKind({ ok: false, checkoutStage: "threeds", consumerLabel: "Waiting for bank" }),
    "threeds",
  );
  assert.equal(classifyCheckoutDiscordKind({ accountGen: true }), "skip");
  assert.equal(classifyCheckoutDiscordKind({ monitor: true, checkout: false }), "skip");
  assert.equal(looksLike3ds({ ok: false, paymentSummary: { charge3dsId: "abc" } }), true);
});

test("checkout embed uses routed kind title", () => {
  const fail = checkoutResultDiscordPayload({ ok: false, error: "x" }, { store: "bandai", kind: "fail" });
  assert.match(fail.embeds[0].title, /failed/i);
  const three = checkoutResultDiscordPayload(
    { ok: false, checkoutStage: "threeds" },
    { store: "bandai", kind: "threeds" },
  );
  assert.match(three.embeds[0].title, /3DS/i);
});
