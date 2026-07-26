// node --test desktop/account-assign.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { emailBase, emailsMatch, resolveAccountForTask } = require("./account-assign.cjs");

test("emailBase strips +tag", () => {
  assert.equal(emailBase("Buyer+abc@BullPosted.com"), "buyer@bullposted.com");
});

test("emailBase strips gmail dots", () => {
  assert.equal(emailBase("te.st.user@gmail.com"), "testuser@gmail.com");
});

test("emailsMatch uniquified to profile", () => {
  assert.equal(emailsMatch("proof3+mrv40gx11rzw@bullposted.com", "proof3@bullposted.com"), true);
  assert.equal(emailsMatch("other@bullposted.com", "proof3@bullposted.com"), false);
});

test("auto picks least-recently-used matching account", () => {
  const profile = { id: "p1", email: "proof3@bullposted.com" };
  const accounts = [
    {
      id: "a1",
      email: "proof3+old@bullposted.com",
      password: "Password1",
      storeId: "toymate",
      lastUsedAt: 200,
    },
    {
      id: "a2",
      email: "proof3+new@bullposted.com",
      password: "Password1",
      storeId: "toymate",
      profileId: "p1",
      lastUsedAt: 50,
    },
  ];
  const r = resolveAccountForTask({
    task: { store: "toymate", toymateMode: "checkout", accountAssign: "auto" },
    profile,
    accounts,
  });
  assert.equal(r.source, "auto");
  assert.equal(r.account.id, "a2");
});

test("excludeIds skips claimed accounts", () => {
  const profile = { id: "p1", email: "proof3@bullposted.com" };
  const accounts = [
    { id: "a1", email: "proof3+1@bullposted.com", password: "x", storeId: "toymate", lastUsedAt: 1 },
    { id: "a2", email: "proof3+2@bullposted.com", password: "x", storeId: "toymate", lastUsedAt: 2 },
  ];
  const r = resolveAccountForTask({
    task: { store: "toymate", accountAssign: "auto" },
    profile,
    accounts,
    excludeIds: ["a1"],
  });
  assert.equal(r.account.id, "a2");
});

test("manual requires accountId", () => {
  const r = resolveAccountForTask({
    task: { store: "toymate", accountAssign: "manual" },
    profile: { email: "a@b.com" },
    accounts: [],
  });
  assert.ok(r.error);
});

test("manual picks accountId", () => {
  const accounts = [
    { id: "x", email: "edge@ex.com", password: "Password1", storeId: "toymate" },
  ];
  const r = resolveAccountForTask({
    task: { store: "toymate", accountAssign: "manual", accountId: "x" },
    profile: { email: "other@ex.com" },
    accounts,
  });
  assert.equal(r.source, "manual");
  assert.equal(r.account.email, "edge@ex.com");
});

test("guest skips login", () => {
  const r = resolveAccountForTask({
    task: { store: "toymate", accountAssign: "guest" },
    profile: { email: "a@b.com" },
    accounts: [{ id: "x", email: "a@b.com", password: "p", storeId: "toymate" }],
  });
  assert.equal(r.source, "guest");
  assert.equal(r.account, null);
});
