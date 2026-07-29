const test = require("node:test");
const assert = require("node:assert/strict");
const { testProxyEntry } = require("./proxy-test.cjs");

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
