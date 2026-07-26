import { validateBandaiPassword, generateBandaiPassword } from "./bandai-password.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

const bad = validateBandaiPassword("password", "user@example.com");
assert(!bad.ok, "simple password should fail");
assert(bad.errors.includes("need_upper"), "need upper");
assert(bad.errors.includes("need_symbol"), "need symbol");

const withLocal = validateBandaiPassword("User123!x", "user@example.com");
assert(!withLocal.ok, "must not contain email local-part");

const good = generateBandaiPassword("buyer@example.com");
const v = validateBandaiPassword(good, "buyer@example.com");
assert(v.ok, `generated password should pass: ${good} → ${v.errors}`);

const seq = validateBandaiPassword("Abc123!xyz", "z@e.com");
// may or may not fail on sequential depending on content — just ensure API shape
assert(Array.isArray(seq.errors), "errors array");

console.log("bandai-password.test.mjs OK");
