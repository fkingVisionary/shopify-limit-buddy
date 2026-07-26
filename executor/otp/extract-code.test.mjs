import { extractCode } from "./imapInbox.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

assert(extractCode("Your code is 123456 thank you") === "123456", "6 digit");
assert(extractCode("no code here") === null, "none");
assert(extractCode("PIN: 998877", /\b(\d{6})\b/) === "998877", "custom");

console.log("extract-code.test.mjs OK");