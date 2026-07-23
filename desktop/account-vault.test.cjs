// node --test desktop/account-vault.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeVaultStatus,
  shouldPersistGeneratedAccount,
  findRegisteredAccount,
  vaultRegisteredEmails,
  bandaiAutoAssignable,
} = require("./account-vault.cjs");
const { resolveAccountForTask } = require("./account-assign.cjs");

test("normalizeVaultStatus keeps SoftBlock created (never → ready)", () => {
  assert.equal(normalizeVaultStatus("created", "bandai"), "created");
  assert.equal(normalizeVaultStatus("needs_terms", "bandai"), "needs_terms");
  assert.equal(normalizeVaultStatus("ready", "bandai"), "ready");
  assert.equal(normalizeVaultStatus("weird", "bandai"), "created");
  assert.equal(normalizeVaultStatus(null, "bandai"), "created");
  assert.equal(normalizeVaultStatus(null, "toymate"), "active");
});

test("shouldPersist: ready/created yes; register_failed/burned no", () => {
  assert.equal(
    shouldPersistGeneratedAccount({
      accountGen: true,
      account: { email: "a@b.com", password: "Pw1!", status: "ready" },
    }, "bandai"),
    true,
  );
  assert.equal(
    shouldPersistGeneratedAccount({
      accountGen: true,
      account: { email: "a@b.com", password: "Pw1!", status: "created" },
    }, "bandai"),
    true,
  );
  assert.equal(
    shouldPersistGeneratedAccount({
      accountGen: true,
      account: { email: "a@b.com", password: "Pw1!", status: "register_failed" },
    }, "bandai"),
    false,
  );
  assert.equal(
    shouldPersistGeneratedAccount({
      accountGen: true,
      account: { email: "a@b.com", status: "burned" },
    }, "bandai"),
    false,
  );
});

test("findRegisteredAccount exact email for store", () => {
  const accounts = [
    { email: "you+abc@bullposted.com", storeId: "bandai", status: "ready", password: "x" },
    { email: "you@bullposted.com", storeId: "toymate", status: "active", password: "x" },
  ];
  const hit = findRegisteredAccount({
    accounts,
    storeId: "bandai",
    email: "you+abc@bullposted.com",
  });
  assert.equal(hit.email, "you+abc@bullposted.com");
  assert.equal(
    findRegisteredAccount({ accounts, storeId: "bandai", email: "other@bullposted.com" }),
    null,
  );
});

test("vaultRegisteredEmails lists bandai registered only", () => {
  const emails = vaultRegisteredEmails(
    [
      { email: "a@x.com", storeId: "bandai", status: "ready" },
      { email: "b@x.com", storeId: "bandai", status: "register_failed" },
      { email: "c@x.com", storeId: "bandai", status: "created" },
      { email: "d@x.com", storeId: "toymate", status: "active" },
    ],
    "bandai",
  );
  assert.deepEqual(emails.sort(), ["a@x.com", "c@x.com"]);
});

test("Bandai auto skips created SoftBlock; picks ready", () => {
  const profile = { id: "p1", email: "proof3@bullposted.com" };
  const accounts = [
    {
      id: "soft",
      email: "proof3+soft@bullposted.com",
      password: "Pw1!",
      storeId: "bandai",
      status: "created",
      lastUsedAt: 1,
    },
    {
      id: "ok",
      email: "proof3+ok@bullposted.com",
      password: "Pw1!",
      storeId: "bandai",
      status: "ready",
      lastUsedAt: 2,
    },
  ];
  assert.equal(bandaiAutoAssignable(accounts[0]), false);
  assert.equal(bandaiAutoAssignable(accounts[1]), true);
  const r = resolveAccountForTask({
    task: { store: "bandai", bandaiMode: "checkout", accountAssign: "auto" },
    profile,
    accounts,
  });
  assert.equal(r.account.id, "ok");
});

test("Bandai manual can still pick SoftBlock created", () => {
  const accounts = [
    {
      id: "soft",
      email: "edge@ex.com",
      password: "Pw1!",
      storeId: "bandai",
      status: "created",
    },
  ];
  const r = resolveAccountForTask({
    task: { store: "bandai", bandaiMode: "checkout", accountAssign: "manual", accountId: "soft" },
    profile: { email: "other@ex.com" },
    accounts,
  });
  assert.equal(r.source, "manual");
  assert.equal(r.account.id, "soft");
});
