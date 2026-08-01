#!/usr/bin/env node
/**
 * Prep the real-checkout e2e task on the user's vanta-desktop db.json.
 * Picks a catalog SKU (or BANDAI_E2E_SKU), clears stale held cart, writes a
 * shuffled SKU pool so e2e can advance on EndOfSale until payment.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const dbPath = path.join(
  process.env.APPDATA || "",
  "vanta-desktop",
  "j1ms-desktop",
  "db.json",
);

const poolPath = path.join(
  process.env.DESKTOP_E2E_OUT
    ? path.dirname(process.env.DESKTOP_E2E_OUT)
    : path.join(__dirname, "..", "..", "artifacts", "bandai-real-checkout"),
  "e2e-sku-pool.json",
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

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function applySku(t, sku, title, areaItemNo) {
  t.store = "bandai";
  t.label = `${sku} · ${title}`.slice(0, 120);
  t.pdpUrl = `https://p-bandai.com/au/item/${sku}`;
  t.bandaiWatchSku = sku;
  t.bandaiMode = "checkout";
  t.bandaiCheckoutMode = "fast";
  t.placeOrder = true;
  t.profileId = t.profileId || "prof_4c10061c8213";
  t.proxyGroupId = t.proxyGroupId || "px_e6d1db558a16";
  t.enabled = true;
  t.bandaiMaxLoops = Number(process.env.BANDAI_MAX_LOOPS || 12) || 12;
  t.bandaiAreaItemNo = areaItemNo || null;
  t.heldCart = null;
  t.bandaiPayFromCart = false;
  t.lastStatus = "idle";
  t.lastLabel = null;
  t.lastError = null;
  t.updatedAt = Date.now();
}

async function main() {
  const catalog = await get(
    "https://j1ms-bandai-monitor-production.up.railway.app/preset-catalog",
  );
  const rows = Array.isArray(catalog.rows)
    ? catalog.rows.filter((r) => r?.sku && /^N\d+/i.test(String(r.sku)))
    : [];
  const fromRaw = String(catalog.raw || "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /^bandai\s+N\d+/i.test(l))
    .map((l) => {
      const m = l.match(/^bandai\s+(N\d+)\s+(.+)$/i);
      return m ? { sku: m[1], title: m[2].trim() } : null;
    })
    .filter(Boolean);

  const bySku = new Map();
  for (const r of [...fromRaw, ...rows]) {
    const sku = String(r.sku).toUpperCase();
    if (!bySku.has(sku)) {
      bySku.set(sku, {
        sku,
        title: r.title || sku,
        areaItemNo: r.areaItemNo || null,
      });
    } else if (r.areaItemNo && !bySku.get(sku).areaItemNo) {
      bySku.get(sku).areaItemNo = r.areaItemNo;
    }
  }
  const pool = shuffle([...bySku.values()]);
  if (!pool.length) throw new Error("empty catalog");

  const force = String(process.env.BANDAI_E2E_SKU || "").trim().toUpperCase();
  let pick = force ? pool.find((p) => p.sku === force) : pool[0];
  if (force && !pick) {
    pick = { sku: force, title: force, areaItemNo: null };
    pool.unshift(pick);
  }
  if (!pick) pick = pool[0];

  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const taskId = process.env.DESKTOP_E2E_TASK_ID || "task_c13e31bb45ce";
  const t = (db.tasks || []).find((x) => x.id === taskId);
  if (!t) throw new Error(`task ${taskId} not found`);

  t.profileId = "prof_4c10061c8213";
  t.proxyGroupId = "px_e6d1db558a16";
  applySku(t, pick.sku, pick.title, pick.areaItemNo);

  fs.mkdirSync(path.dirname(poolPath), { recursive: true });
  fs.writeFileSync(
    poolPath,
    JSON.stringify(
      {
        taskId,
        index: pool.findIndex((p) => p.sku === pick.sku),
        pool,
        at: Date.now(),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId,
        sku: pick.sku,
        title: pick.title,
        areaItemNo: pick.areaItemNo,
        poolSize: pool.length,
        poolPath,
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
