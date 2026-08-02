/**
 * Upsert a Pokémon Centre checkout e2e task into desktop db.json.
 * Does not print secrets. Env:
 *   DESKTOP_E2E_TASK_ID   default task_pkc_dual_e2e
 *   PKC_PDP_URL           product URL
 *   DESKTOP_E2E_PROFILE_ID / proxy from Bandai lab task if unset
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

const taskId = process.env.DESKTOP_E2E_TASK_ID || "task_pkc_dual_e2e";
const pdp =
  process.env.PKC_PDP_URL ||
  "https://www.pokemoncenter.com/en-au/product/72-10917-101/unova-region-paired-pikachu-poke-plush-9-in";

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
  store: "pokemoncentre",
  enabled: true,
  quantity: 1,
  qty: 1,
  pdpUrl: pdp,
  input: pdp,
  profileId,
  proxyGroupId: proxyGroupId || null,
  pcMode: "checkout",
  pcLocale: "en-au",
  placeOrder: true,
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
      store: "pokemoncentre",
      pcMode: "checkout",
      profileId,
      proxyGroupId: proxyGroupId || null,
      pdp: pdp.slice(0, 96),
    },
    null,
    2,
  ),
);
