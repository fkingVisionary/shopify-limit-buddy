const fs = require("fs");
const path = require("path");
const https = require("https");

const dbPath = path.join(
  process.env.APPDATA || "",
  "vanta-desktop",
  "j1ms-desktop",
  "db.json",
);

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function main() {
  const catalog = await get(
    "https://j1ms-bandai-monitor-production.up.railway.app/preset-catalog",
  );
  const lines = String(catalog.raw || "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /^bandai\s+N\d+/i.test(l));
  const pick = lines[Math.floor(Math.random() * lines.length)];
  const m = pick.match(/^bandai\s+(N\d+)\s+(.+)$/i);
  if (!m) throw new Error("no sku pick");
  const sku = m[1];
  const title = m[2].trim();

  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const taskId = process.env.DESKTOP_E2E_TASK_ID || "task_c13e31bb45ce";
  const t = (db.tasks || []).find((x) => x.id === taskId);
  if (!t) throw new Error(`task ${taskId} not found`);

  t.store = "bandai";
  t.label = `${sku} · ${title}`.slice(0, 120);
  t.pdpUrl = `https://p-bandai.com/au/item/${sku}`;
  t.bandaiWatchSku = sku;
  t.bandaiMode = "checkout";
  t.bandaiCheckoutMode = "fast";
  t.placeOrder = true;
  t.profileId = "prof_4c10061c8213";
  t.proxyGroupId = "px_e6d1db558a16";
  t.enabled = true;
  t.bandaiMaxLoops = Number(process.env.BANDAI_MAX_LOOPS || 16) || 16;
  // Fresh SKU run — never carry a stale held cart / NAI from another product.
  t.heldCart = null;
  t.bandaiAreaItemNo = null;
  t.bandaiPayFromCart = false;
  t.lastStatus = "idle";
  t.lastLabel = null;
  t.lastError = null;
  t.updatedAt = Date.now();

  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId,
        sku,
        title,
        label: t.label,
        profileId: t.profileId,
        proxyGroupId: t.proxyGroupId,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
