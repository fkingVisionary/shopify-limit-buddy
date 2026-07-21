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
<form action="https://toymate.com.au/shop/" method="get"><input name="qty[]" value="1" /></form>
<form action="https://toymate.com.au/login.php?action=save_new_account" method="post">
  <input type="hidden" name="authenticity_token" value="tok123" />
  <label>Email Address</label><input type="text" name="FormField[1][1]" value="" />
  <label>Password</label><input type="password" name="FormField[1][2]" value="" />
  <label>Confirm Password</label><input type="password" name="FormField[1][3]" value="" />
  <label>First Name</label><input type="text" name="FormField[2][4]" value="" />
  <label>Last Name</label><input type="text" name="FormField[2][5]" value="" />
  <label>Company</label><input type="text" name="FormField[2][6]" value="" />
  <label>Phone</label><input type="text" name="FormField[2][7]" value="" />
  <label>Address 1</label><input type="text" name="FormField[2][8]" value="" />
  <label>Address 2</label><input type="text" name="FormField[2][9]" value="" />
  <label>City</label><input type="text" name="FormField[2][10]" value="" />
  <label>Country</label><select name="FormField[2][11]"><option value=""></option><option value="Australia">Australia</option></select>
  <label>State</label><select name="FormField[2][12]"><option value="New South Wales">New South Wales</option></select>
  <label>Zip</label><input type="text" name="FormField[2][13]" value="" />
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

test("parseFormFields scopes to create-account form (ignores shop form)", () => {
  const fields = parseFormFields(FIXTURE_CREATE_HTML);
  const names = fields.map((f) => f.name);
  assert.ok(names.includes("authenticity_token"));
  assert.ok(names.includes("FormField[1][1]"));
  assert.ok(names.includes("FormField[1][2]"));
  assert.ok(!names.includes("qty[]"));
});

test("buildCreateAccountBody maps Toymate FormField layout + captcha", () => {
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
  assert.equal(body.get("FormField[1][1]"), "unique+abc@example.com");
  assert.equal(body.get("FormField[1][2]"), "Password1");
  assert.equal(body.get("FormField[1][3]"), "Password1");
  assert.equal(body.get("FormField[2][4]"), "Ada");
  assert.equal(body.get("FormField[2][5]"), "Lovelace");
  assert.equal(body.get("FormField[2][12]"), "New South Wales");
  assert.equal(body.get("FormField[2][11]"), "Australia");
  assert.equal(body.get("g-recaptcha-response"), "CAPTCHA_TOKEN");
  assert.equal(body.get("authenticity_token"), "tok123");
});

test("accountCreatedOk accepts account_created", () => {
  assert.equal(
    accountCreatedOk(302, "", "https://toymate.com.au/login.php?action=account_created"),
    true,
  );
  assert.equal(accountCreatedOk(200, "<h1>Your Account Has Been Created</h1>", ""), true);
  assert.equal(
    accountCreatedOk(303, "", "https://toymate.com.au/login.php?action=save_new_account", "https://toymate.com.au/login.php?action=account_created"),
    true,
  );
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
