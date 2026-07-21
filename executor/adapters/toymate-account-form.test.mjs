// Zero-cost fixture tests for Toymate account-gen helpers.
// Run: node --test executor/adapters/toymate-account-form.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { __test } from "./toymate.js";

const {
  uniquifyAccountEmail,
  ensureToymatePassword,
  buildCreateAccountBody,
  accountCreatedOk,
  extractFormAction,
  parseFormFields,
} = __test;

const FIXTURE_CREATE_HTML = `
<html><body>
<form action="https://toymate.com.au/login.php?action=save_new_account" method="post">
  <input type="hidden" name="authenticity_token" value="tok123" />
  <input type="text" name="FormField[1][1]" value="" />
  <input type="text" name="FormField[1][2]" value="" />
  <input type="email" name="FormField[1][11]" value="" />
  <input type="password" name="FormField[1][12]" value="" />
  <input type="password" name="FormField[1][13]" value="" />
  <input type="text" name="FormField[2][1]" value="" />
  <input type="hidden" name="g-recaptcha-response" value="" />
  <div class="g-recaptcha" data-sitekey="6LeTestSiteKeyXXXXXXXXXXXXXXXXXXXXXXX"></div>
</form>
</body></html>
`;

test("uniquifyAccountEmail adds +tag for non-gmail", () => {
  const out = uniquifyAccountEmail("buyer@bullposted.com");
  assert.match(out, /^buyer\+[a-z0-9]+@bullposted\.com$/);
});

test("uniquifyAccountEmail dots gmail local", () => {
  const out = uniquifyAccountEmail("test.user@gmail.com");
  assert.match(out, /@gmail\.com$/);
  assert.notEqual(out, "test.user@gmail.com");
});

test("ensureToymatePassword rejects alpha-only", () => {
  assert.equal(ensureToymatePassword("Password"), "Password1");
});

test("ensureToymatePassword keeps valid", () => {
  assert.equal(ensureToymatePassword("Password1"), "Password1");
});

test("ensureToymatePassword randomises empty", () => {
  const p = ensureToymatePassword("");
  assert.ok(p.length >= 7);
  assert.match(p, /[A-Za-z]/);
  assert.match(p, /\d/);
});

test("extractFormAction prefers form action on apex", () => {
  const action = extractFormAction(FIXTURE_CREATE_HTML, "https://toymate.com.au");
  assert.equal(action, "https://toymate.com.au/login.php?action=save_new_account");
});

test("parseFormFields finds FormField + hidden token", () => {
  const fields = parseFormFields(FIXTURE_CREATE_HTML);
  const names = fields.map((f) => f.name);
  assert.ok(names.includes("authenticity_token"));
  assert.ok(names.includes("FormField[1][1]"));
  assert.ok(names.includes("FormField[1][12]"));
});

test("buildCreateAccountBody fills opaque fields + captcha", () => {
  const body = buildCreateAccountBody(
    FIXTURE_CREATE_HTML,
    {
      first_name: "Ada",
      last_name: "Lovelace",
      phone: "0400111222",
      address1: "1 Test St",
      city: "Sydney",
      province: "NSW",
      zip: "2000",
      email: "base@example.com",
    },
    "Password1",
    "CAPTCHA_TOKEN",
    "unique+abc@example.com",
  );
  const s = body.toString();
  assert.match(s, /authenticity_token=tok123/);
  assert.match(s, /g-recaptcha-response=CAPTCHA_TOKEN/);
  assert.match(s, /FormField/);
  assert.match(s, /Password1/);
  assert.match(s, /unique%2Babc%40example\.com|unique\+abc@example\.com/);
});

test("accountCreatedOk accepts account_created", () => {
  assert.equal(
    accountCreatedOk(302, "", "https://toymate.com.au/login.php?action=account_created"),
    true,
  );
  assert.equal(accountCreatedOk(200, "<h1>Your Account Has Been Created</h1>", ""), true);
});

test("accountCreatedOk rejects password-policy false positive", () => {
  assert.equal(
    accountCreatedOk(
      200,
      "Error: password must include alphabetic and numeric characters",
      "https://toymate.com.au/login.php?action=save_new_account",
    ),
    false,
  );
});
