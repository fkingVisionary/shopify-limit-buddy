import { collectRecipients, recipientMatches, normalizeEmail } from "./imapInbox.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

assert(normalizeEmail("  Foo@Bar.COM ") === "foo@bar.com", "normalize");

const envelope = {
  to: [{ name: "Hide My Email", address: "skis.gnats_7a@icloud.com" }],
};
const source = [
  "Original-recipient: rfc822;jimposted@icloud.com",
  "To: Hide My Email <skis.gnats_7a@icloud.com>",
  "",
  "Authentication Code 208454",
].join("\r\n");

const recips = collectRecipients(envelope, source);
assert(recips.includes("skis.gnats_7a@icloud.com"), "alias in recipients");
assert(recips.includes("jimposted@icloud.com"), "primary also listed");

assert(
  recipientMatches("skis.gnats_7a@icloud.com", envelope, source),
  "match alias",
);
assert(
  !recipientMatches("lynx_blitz.4e@icloud.com", envelope, source),
  "reject other alias",
);
assert(
  !recipientMatches("inverts_rasa.0f@icloud.com", envelope, source),
  "reject other alias 2",
);

// Envelope-only (no source yet)
assert(
  recipientMatches("skis.gnats_7a@icloud.com", envelope, ""),
  "envelope to enough",
);

console.log("imap-recipient.test.mjs OK");
