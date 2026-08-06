#!/usr/bin/env node
/**
 * Manually seed SKUs into Smart Action Store from monitor-feed.json (or bare SKUs).
 * Usage: node desktop/scripts/seed-catalog-skus.cjs N2881648002 N2904549002
 */
const fs = require("fs");
const path = require("path");
const {
  normalizeCatalogState,
  normalizeCatalogRow,
} = require("../smart-action-catalog.cjs");

const root = path.join(process.env.APPDATA || "", "vanta-desktop", "j1ms-desktop");
const dbPath = path.join(root, "db.json");
const feedPath = path.join(root, "monitor-feed.json");

const skus = process.argv
  .slice(2)
  .map((s) => String(s || "").trim().toUpperCase())
  .filter((s) => /^[A-Z0-9_-]{4,}$/.test(s));

if (!skus.length) {
  console.error("Usage: node desktop/scripts/seed-catalog-skus.cjs <SKU> [SKU...]");
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error("db.json not found:", dbPath);
  process.exit(1);
}

function loadHits() {
  if (!fs.existsSync(feedPath)) return [];
  const raw = JSON.parse(fs.readFileSync(feedPath, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.hits)) return raw.hits;
  if (Array.isArray(raw?.feed)) return raw.feed;
  if (Array.isArray(raw?.events)) return raw.events;
  return [];
}

function findHit(hits, sku) {
  const u = sku.toUpperCase();
  return (
    hits.find((h) => String(h.productId || h.sku || "").toUpperCase() === u) ||
    hits.find((h) => JSON.stringify(h).toUpperCase().includes(u)) ||
    null
  );
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const hits = loadHits();
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const catalog = normalizeCatalogState(db.smartActionCatalog || {});
const byKey = new Map(
  (catalog.rows || []).map((r) => [`${r.store}::${String(r.sku || "").toUpperCase()}`, r]),
);

let added = 0;
let updated = 0;
const seeded = [];

for (const sku of skus) {
  const hit = findHit(hits, sku);
  const title = String(hit?.title || hit?.productName || hit?.meta?.title || sku).trim();
  const imageUrl = String(
    hit?.imageUrl || hit?.meta?.imageUrl || hit?.image || hit?.thumbnailUrl || "",
  ).trim();
  const areaItemNo = String(hit?.areaItemNo || hit?.meta?.areaItemNo || "").trim();
  const area = String(hit?.area || hit?.meta?.area || "au")
    .toLowerCase()
    .slice(0, 2);
  const storeName = "bandai";
  const key = `${storeName}::${sku}`;
  const prev = byKey.get(key);

  if (prev) {
    let changed = false;
    if (title && (!prev.title || prev.title === prev.sku)) {
      prev.title = title.slice(0, 120);
      changed = true;
    }
    if (imageUrl && !prev.imageUrl) {
      prev.imageUrl = imageUrl.slice(0, 500);
      changed = true;
    }
    if (areaItemNo && /^NAI|^AAI/i.test(areaItemNo) && !prev.areaItemNo) {
      prev.areaItemNo = areaItemNo;
      if (!Array.isArray(prev.areaItemNos)) prev.areaItemNos = [];
      if (!prev.areaItemNos.includes(areaItemNo)) prev.areaItemNos.push(areaItemNo);
      changed = true;
    }
    if (changed) updated += 1;
    seeded.push({
      sku,
      action: changed ? "updated" : "exists",
      title: prev.title,
      fromFeed: Boolean(hit),
    });
    continue;
  }

  const row = normalizeCatalogRow(
    {
      store: storeName,
      sku,
      title: title || sku,
      taskGroup: title || sku,
      imageUrl,
      areaItemNo,
      area,
      enabledTemplateIds: [],
    },
    id,
  );
  catalog.rows.push(row);
  byKey.set(key, row);
  added += 1;
  seeded.push({
    sku,
    action: "added",
    title: row.title,
    id: row.id,
    imageUrl: Boolean(row.imageUrl),
    areaItemNo: row.areaItemNo || null,
    fromFeed: Boolean(hit),
  });

  if (!db.bandaiProductCache || typeof db.bandaiProductCache !== "object") {
    db.bandaiProductCache = {};
  }
  const ck = sku.toUpperCase();
  db.bandaiProductCache[ck] = {
    ...(db.bandaiProductCache[ck] || {}),
    sku: ck,
    title: title || sku,
    imageUrl: imageUrl || db.bandaiProductCache[ck]?.imageUrl || "",
    areaItemNo: areaItemNo || db.bandaiProductCache[ck]?.areaItemNo || "",
    area,
    source: "manual_monitor_seed",
    updatedAt: new Date().toISOString(),
  };
}

db.smartActionCatalog = catalog;
fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log(JSON.stringify({ added, updated, seeded, totalRows: catalog.rows.length }, null, 2));
