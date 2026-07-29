const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseProfilesImport,
  formatProfilesExport,
  parseProxyGroupsImport,
  formatProxyGroupsExport,
  parseTasksImport,
  formatTasksExport,
} = require("./data-import-export.cjs");

test("profiles import/export csv round-trip", () => {
  const body = formatProfilesExport(
    [{ name: "Alex", email: "a@b.com", first_name: "Alex", city: "Sydney", zip: "2000" }],
    "csv",
  );
  const back = parseProfilesImport(body);
  assert.equal(back.ok, true);
  assert.equal(back.profiles[0].email, "a@b.com");
  assert.equal(back.profiles[0].city, "Sydney");
});

test("proxy groups import lines + json", () => {
  const lines = parseProxyGroupsImport("name: Drop ISP\n1.1.1.1:80:u:p\n2.2.2.2:80:a:b");
  assert.equal(lines.ok, true);
  assert.equal(lines.groups[0].name, "Drop ISP");
  assert.equal(lines.groups[0].entries.length, 2);

  const json = parseProxyGroupsImport(
    JSON.stringify({ proxyGroups: [{ name: "X", entries: ["127.0.0.1:60000"] }] }),
  );
  assert.equal(json.groups[0].entries[0], "127.0.0.1:60000");
  const out = formatProxyGroupsExport(json.groups, "csv");
  assert.match(out, /name,entries/);
});

test("tasks import resolves profile/proxy names", () => {
  const csv = parseTasksImport(
    "label,store,bandaiWatchSku,profileName,proxyGroupName,qty,bandaiMonitorDelayMs\nGundam,bandai,N2890904001,Alex,ISP,2,0\n",
    {
      profilesByName: new Map([["alex", "prof_1"]]),
      proxiesByName: new Map([["isp", "px_1"]]),
    },
  );
  assert.equal(csv.ok, true);
  assert.equal(csv.tasks[0].bandaiWatchSku, "N2890904001");
  assert.equal(csv.tasks[0].profileId, "prof_1");
  assert.equal(csv.tasks[0].proxyGroupId, "px_1");
  assert.equal(csv.tasks[0].bandaiMonitorDelayMs, 0);
  const body = formatTasksExport(csv.tasks, "json");
  assert.match(body, /N2890904001/);
});
