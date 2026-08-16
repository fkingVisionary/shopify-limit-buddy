#!/usr/bin/env node
/**
 * Generate N Vanta Beta desktop API keys (allowlist).
 *
 * Usage:
 *   node scripts/seed-beta-keys.mjs            # 5 keys, print only
 *   node scripts/seed-beta-keys.mjs --write    # also write desktop/beta-keys.local.txt
 *   node scripts/seed-beta-keys.mjs --count 10
 *
 * Does NOT commit secrets. Paste DESKTOP_* into Railway Variables.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const write = args.includes("--write");
const countIdx = args.indexOf("--count");
const count = Math.max(1, Math.min(50, Number(countIdx >= 0 ? args[countIdx + 1] : 5) || 5));

const keys = Array.from({ length: count }, (_, i) => {
  const id = String(i + 1).padStart(2, "0");
  const body = crypto.randomBytes(12).toString("base64url");
  return `vanta_beta_${id}_${body}`;
});

const adminToken = crypto.randomBytes(18).toString("base64url");
const csv = keys.join(",");

console.log("DESKTOP_AUTH_MODE=allowlist");
console.log(`DESKTOP_API_KEYS=${csv}`);
console.log(`DESKTOP_KEYS_ADMIN_TOKEN=${adminToken}`);
console.log("");
keys.forEach((k, i) => console.log(`${i + 1}. ${k}`));
console.log("");
console.log(`Operator page: /admin/beta-keys?token=${adminToken}`);

if (write) {
  const out = path.join(__dirname, "..", "desktop", "beta-keys.local.txt");
  const body = `# Vanta Beta — desktop API keys (DO NOT COMMIT)
DESKTOP_AUTH_MODE=allowlist
DESKTOP_API_KEYS=${csv}
DESKTOP_KEYS_ADMIN_TOKEN=${adminToken}

# Individual keys:
${keys.map((k, i) => `# ${i + 1}. ${k}`).join("\n")}

# Operator view: /admin/beta-keys?token=${adminToken}
`;
  fs.writeFileSync(out, body, "utf8");
  console.log(`\nWrote ${out}`);
}
