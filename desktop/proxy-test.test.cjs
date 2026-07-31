const test = require("node:test");
const assert = require("node:assert/strict");
const { testProxyEntry, PROXY_TEST_PRESETS } = require("./proxy-test.cjs");

test("proxy tester rejects empty and socks", async () => {
  const empty = await testProxyEntry("");
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "empty");
  const socks = await testProxyEntry("socks5://1.2.3.4:1080");
  assert.equal(socks.ok, false);
  assert.equal(socks.error, "socks_unsupported");
});

test("proxy tester rejects invalid format", async () => {
  const bad = await testProxyEntry("not-a-proxy");
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /invalid|Proxy/i);
});

test("proxy tester presets cover Bandai / Toymate / Pokémon", () => {
  const ids = PROXY_TEST_PRESETS.map((p) => p.id);
  assert.ok(ids.includes("bandai"));
  assert.ok(ids.includes("toymate"));
  assert.ok(ids.includes("pokemoncentre"));
  assert.match(
    PROXY_TEST_PRESETS.find((p) => p.id === "bandai").url,
    /p-bandai\.com/,
  );
});
