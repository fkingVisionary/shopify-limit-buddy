/**
 * Upsert a Toymate e2e task into desktop db.json.
 * Env:
 *   DESKTOP_E2E_TASK_ID   default task_toymate_dual_e2e
 *   TOYMATE_PDP_URL
 *   TOYMATE_MODE          account_gen | checkout (default checkout)
 *   TOYMATE_ACCOUNT_ASSIGN guest | auto | manual (default guest for dual labs)
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dbPath =
  process.env.DESKTOP_DB_PATH ||
  path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "vanta-desktop",
    "j1ms-desktop",
    "db.json",
  );

const taskId = process.env.DESKTOP_E2E_TASK_ID || "task_toymate_dual_e2e";
const pdp =
  process.env.TOYMATE_PDP_URL ||
  "https://toymate.com.au/monster-high-draculaura-doll/";
const mode = String(process.env.TOYMATE_MODE || "checkout").toLowerCase();
const accountAssign = String(process.env.TOYMATE_ACCOUNT_ASSIGN || "guest").toLowerCase();

const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const bandai = (db.tasks || []).find((t) => t.id === "task_c13e31bb45ce") || (db.tasks || [])[0];
const profileId = process.env.DESKTOP_E2E_PROFILE_ID || bandai?.profileId;
const proxyGroupId = process.env.DESKTOP_E2E_PROXY_GROUP_ID || bandai?.proxyGroupId;

if (!profileId) {
  console.error(JSON.stringify({ ok: false, error: "no profileId" }));
  process.exit(1);
}

const next = {
  id: taskId,
  store: "toymate",
  enabled: true,
  quantity: 1,
  qty: 1,
  pdpUrl: pdp,
  input: pdp,
  profileId,
  proxyGroupId: proxyGroupId || null,
  toymateMode: mode,
  accountAssign,
  placeOrder: mode === "checkout",
};

const tasks = Array.isArray(db.tasks) ? db.tasks.slice() : [];
const idx = tasks.findIndex((t) => t.id === taskId);
if (idx >= 0) tasks[idx] = { ...tasks[idx], ...next };
else tasks.push(next);
db.tasks = tasks;
fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log(
  JSON.stringify(
    {
      ok: true,
      taskId,
      store: "toymate",
      toymateMode: mode,
      accountAssign,
      profileId,
      proxyGroupId: proxyGroupId || null,
      pdp: pdp.slice(0, 96),
    },
    null,
    2,
  ),
);
