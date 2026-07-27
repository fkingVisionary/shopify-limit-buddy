// node --test desktop/account-vault.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeVaultStatus,
  shouldPersistGeneratedAccount,
  findRegisteredAccount,
  vaultRegisteredEmails,
  bandaiAutoAssignable,
  normalizeManualAccount,
  parseAccountsImport,
  formatAccountsExport,
  emailBase,
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

test("normalizeManualAccount keeps exact gmail memberId (dots only stripped in emailBase)", () => {
  const n = normalizeManualAccount({
    email: "spoton.dot.gg@gmail.com",
    password: "Millward3!",
    storeId: "bandai",
  });
  assert.equal(n.ok, true);
  assert.equal(n.account.email, "spoton.dot.gg@gmail.com");
  assert.equal(n.account.emailBase, "spotondotgg@gmail.com");
  assert.equal(n.account.status, "ready");
  // Lab login has no '.' chars — emailBase equals email; still must save exact string.
  const lab = normalizeManualAccount({
    email: "spotondotgg@gmail.com",
    password: "Millward3!",
  });
  assert.equal(lab.account.email, "spotondotgg@gmail.com");
  assert.equal(emailBase("spotondotgg@gmail.com"), "spotondotgg@gmail.com");
});

test("parseAccountsImport JSON + lines + csv", () => {
  const json = parseAccountsImport(
    JSON.stringify({
      accounts: [{ email: "a@x.com", password: "Pw1!", storeId: "bandai" }],
    }),
  );
  assert.equal(json.ok, true);
  assert.equal(json.accounts[0].email, "a@x.com");

  const lines = parseAccountsImport("bandai:fairing.bands_8k@icloud.com:Ab1!53dzggj1\n# skip\nbadline");
  assert.equal(lines.ok, true);
  assert.equal(lines.accounts[0].email, "fairing.bands_8k@icloud.com");
  assert.equal(lines.accounts[0].password, "Ab1!53dzggj1");

  const csv = parseAccountsImport("storeId,email,password,status\ntoymate,t@x.com,Secret1!,active\n");
  assert.equal(csv.ok, true);
  assert.equal(csv.accounts[0].storeId, "toymate");
  assert.equal(csv.accounts[0].status, "active");
});

test("formatAccountsExport round-trips csv", () => {
  const body = formatAccountsExport(
    [{ storeId: "bandai", email: "a@b.com", password: "x", status: "ready", source: "manual" }],
    "csv",
  );
  assert.match(body, /^storeId,email,password/);
  const back = parseAccountsImport(body);
  assert.equal(back.ok, true);
  assert.equal(back.accounts[0].email, "a@b.com");
  assert.equal(back.accounts[0].storeId, "bandai");
});
