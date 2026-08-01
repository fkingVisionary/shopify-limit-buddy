#!/usr/bin/env node
/**
 * Prep one e2e task on the user's vanta-desktop db.json.
 * One SKU per task — set BANDAI_E2E_SKU to pin, else pick one catalog line.
 * Clears stale held cart so a leftover account cart cannot hijack pay.
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
  const rows = Array.isArray(catalog.rows)
    ? catalog.rows.filter((r) => r?.sku && /^N\d+/i.test(String(r.sku)))
    : [];
  const fromRaw = String(catalog.raw || "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /^bandai\s+N\d+/i.test(l))
    .map((l) => {
      const m = l.match(/^bandai\s+(N\d+)\s+(.+)$/i);
      return m
        ? { sku: m[1].toUpperCase(), title: m[2].trim(), areaItemNo: null }
        : null;
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
  const all = [...bySku.values()];
  if (!all.length) throw new Error("empty catalog");

  const force = String(process.env.BANDAI_E2E_SKU || "").trim().toUpperCase();
  const pick =
    (force && (bySku.get(force) || { sku: force, title: force, areaItemNo: null })) ||
    all[Math.floor(Math.random() * all.length)];

  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const taskId = process.env.DESKTOP_E2E_TASK_ID || "task_c13e31bb45ce";
  const t = (db.tasks || []).find((x) => x.id === taskId);
  if (!t) throw new Error(`task ${taskId} not found`);

  t.store = "bandai";
  t.label = `${pick.sku} · ${pick.title}`.slice(0, 120);
  t.pdpUrl = `https://p-bandai.com/au/item/${pick.sku}`;
  t.bandaiWatchSku = pick.sku;
  t.bandaiMode = "checkout";
  t.bandaiCheckoutMode = "fast";
  t.placeOrder = true;
  t.profileId = "prof_4c10061c8213";
  t.proxyGroupId = "px_e6d1db558a16";
  t.enabled = true;
  t.bandaiMaxLoops = Number(process.env.BANDAI_MAX_LOOPS || 12) || 12;
  t.bandaiAreaItemNo = pick.areaItemNo || null;
  t.heldCart = null;
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
        sku: pick.sku,
        title: pick.title,
        areaItemNo: pick.areaItemNo,
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
