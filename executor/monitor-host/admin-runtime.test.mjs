import test from "node:test";
import assert from "node:assert/strict";
import { createMonitorProxyPool } from "../monitor/monitor-proxy-pool.js";
import { createBandaiStockMonitor } from "../monitor/bandai-stock-monitor.js";
import {
  vantaOosDiscordBody,
  vantaRestockDiscordBody,
  vantaPkcDiscordBody,
  vantaPkcOosDiscordBody,
  pcPdpUrl,
} from "./vanta-discord.mjs";
import { saveRuntimeConfig, loadRuntimeConfig } from "./runtime-config.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("proxy pool replaceLists hot-swaps", () => {
  const pool = createMonitorProxyPool({
    ispRaw: "1.1.1.1:80:u:p",
    dcRaw: "",
    ispRatio: 1,
  });
  assert.equal(pool.stats().isp, 1);
  pool.replaceLists({ ispRaw: "2.2.2.2:80:a:b\n3.3.3.3:80:c:d", dcRaw: "4.4.4.4:80:e:f" });
  assert.equal(pool.stats().isp, 2);
  assert.equal(pool.stats().dc, 1);
});

test("monitor setKeywords live", () => {
  const m = createBandaiStockMonitor({
    keywords: "A",
    proxyPool: createMonitorProxyPool({ ispRaw: "1.1.1.1:80:u:p", dcRaw: "" }),
  });
  assert.deepEqual(m.status().keywords, ["A"]);
  m.setKeywords("X\nY");
  assert.deepEqual(m.status().keywords, ["X", "Y"]);
});

test("oos discord is red; restock is black + Quick Task once", () => {
  const body = vantaOosDiscordBody({
    productId: "N1",
    title: "Demo Figure",
    reason: "went_oos",
  });
  assert.equal(body.username, "Vanta");
  assert.match(body.embeds[0].title, /^OOS ·/);
  assert.match(body.embeds[0].description, /OUT OF STOCK/i);
  assert.equal(body.embeds[0].color, 0xdc2626);
  assert.match(body.embeds[0].description, /eBay sold/i);
  assert.ok(body.components?.[0]?.components?.some((c) => /eBay sold/i.test(c.label)));

  const restock = vantaRestockDiscordBody({ productId: "N1", title: "Demo Figure", areaItemNo: "NAI1" });
  assert.equal(restock.embeds[0].color, 0x000000);
  // QT appears once in description (not also in a Desktop field)
  const desc = restock.embeds[0].description;
  assert.equal((desc.match(/Quick Task/g) || []).length, 1);
  assert.match(desc, /Setup presets/);
  assert.match(desc, /eBay sold/);
  assert.match(desc, /ebay\.com\.au/);
  assert.equal(
    restock.embeds[0].fields.some((f) => f.name === "Desktop"),
    false,
  );
  assert.ok(Array.isArray(restock.components));
  const labels = restock.components[0].components.map((c) => c.label);
  assert.ok(labels.some((l) => /Quick Task/i.test(l)));
  assert.ok(labels.some((l) => /Create only/i.test(l)));
  assert.ok(labels.some((l) => /Setup presets/i.test(l)));
  assert.ok(labels.some((l) => /eBay sold/i.test(l)));
  const btn = restock.components[0].components.find((c) => /Quick Task/i.test(c.label));
  assert.match(btn.url, /^https:\/\/.+\/qt\?/);
  assert.match(btn.url, /sku=N1/);
  const create = restock.components[0].components.find((c) => /Create only/i.test(c.label));
  assert.match(create.url, /start=0/);
});

test("admin lab test restock also includes Quick Task", () => {
  const testPing = vantaRestockDiscordBody(
    { productId: "N2890904001", title: "Lab Demo", areaItemNo: "NAI9" },
    { area: "au", test: true },
  );
  assert.match(testPing.embeds[0].author.name, /test restock/i);
  assert.equal(/needs .+ open/i.test(testPing.embeds[0].description), false);
  assert.equal((testPing.embeds[0].description.match(/Quick Task/g) || []).length, 1);
  assert.match(testPing.embeds[0].description, /\/qt\?/);
  assert.match(testPing.embeds[0].description, /qt-setup/);
  const btn = testPing.components[0].components.find((c) => /Quick Task/i.test(c.label));
  assert.ok(btn);
  assert.match(btn.url, /sku=N2890904001/);
});

test("PKC discord preload is blue; stock is black; OOS is red", () => {
  const pdp = pcPdpUrl({ productId: "10-10186-109", slug: "demo-etb" }, "en-au");
  assert.equal(
    pdp,
    "https://www.pokemoncenter.com/en-au/product/10-10186-109/demo-etb",
  );

  const preload = vantaPkcDiscordBody(
    {
      productId: "10-10186-109",
      title: "PC Exclusive ETB",
      availability: "AVAILABLE_FOR_PRE_ORDER",
      reason: "preorder_live",
      preorder: true,
    },
    { locale: "en-au", test: true, preload: true },
  );
  assert.match(preload.embeds[0].author.name, /test PKC preload/i);
  assert.match(preload.embeds[0].title, /preorder \/ preload/i);
  assert.equal(preload.embeds[0].color, 0x2563eb);
  assert.match(preload.embeds[0].url, /pokemoncenter\.com\/en-au\/product\/10-10186-109/);
  assert.equal(/Quick Task/i.test(preload.embeds[0].description), false);

  const stock = vantaPkcDiscordBody(
    { productId: "10-10186-109", title: "PC Exclusive ETB", reason: "restock" },
    { locale: "en-au", test: true },
  );
  assert.equal(stock.embeds[0].color, 0x000000);
  assert.match(stock.embeds[0].title, /^PKC stock/);

  const oos = vantaPkcOosDiscordBody(
    { productId: "10-10186-109", title: "PC Exclusive ETB" },
    { locale: "en-au", test: true },
  );
  assert.equal(oos.embeds[0].color, 0xdc2626);
  assert.match(oos.embeds[0].title, /^OOS ·/);
  assert.match(oos.embeds[0].description, /Pokémon Centre/i);
});

test("runtime config round-trip", () => {
  const file = path.join(os.tmpdir(), `vanta-cfg-${Date.now()}.json`);
  saveRuntimeConfig(
    {
      keywords: "GUNDAM",
      presetCatalog: "N2890904001 Gundam Anniversary",
      ispProxies: "1.1.1.1:80:u:p",
      dcProxies: "4.4.4.4:80:e:f",
      intervalMs: 4000,
      notifyOos: true,
    },
    file,
  );
  const loaded = loadRuntimeConfig(file);
  assert.equal(loaded.keywords, "GUNDAM");
  assert.match(loaded.presetCatalog, /N2890904001/);
  assert.equal(loaded.ispProxies, "1.1.1.1:80:u:p");
  assert.equal(loaded.dcProxies, "4.4.4.4:80:e:f");
  assert.equal(loaded.intervalMs, 4000);
  assert.equal(loaded._fromDisk, true);
  fs.unlinkSync(file);
});

test("disk proxy lists win over env bootstrap after save", () => {
  const file = path.join(os.tmpdir(), `vanta-cfg-env-${Date.now()}.json`);
  const prevIsp = process.env.BANDAI_MONITOR_ISP_PROXIES;
  const prevDc = process.env.BANDAI_MONITOR_DC_PROXIES;
  process.env.BANDAI_MONITOR_ISP_PROXIES = "osp.example:80:u:p";
  process.env.BANDAI_MONITOR_DC_PROXIES = "osp-dc.example:80:u:p";
  try {
    saveRuntimeConfig(
      {
        keywords: "X",
        ispProxies: "admin-isp:80:a:b\nadmin-isp2:80:c:d",
        dcProxies: "admin-dc:80:e:f",
        intervalMs: 5000,
        notifyOos: true,
      },
      file,
    );
    const loaded = loadRuntimeConfig(file);
    assert.match(loaded.ispProxies, /admin-isp/);
    assert.doesNotMatch(loaded.ispProxies, /osp\.example/);
    assert.match(loaded.dcProxies, /admin-dc/);
    assert.doesNotMatch(loaded.dcProxies, /osp-dc/);
  } finally {
    if (prevIsp == null) delete process.env.BANDAI_MONITOR_ISP_PROXIES;
    else process.env.BANDAI_MONITOR_ISP_PROXIES = prevIsp;
    if (prevDc == null) delete process.env.BANDAI_MONITOR_DC_PROXIES;
    else process.env.BANDAI_MONITOR_DC_PROXIES = prevDc;
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
});

test("data-dir marks tmp as ephemeral", async () => {
  const { isEphemeralPath, persistenceMeta } = await import("./data-dir.mjs");
  assert.equal(isEphemeralPath("/tmp/vanta-monitor-state.json"), true);
  const meta = persistenceMeta(path.join(os.tmpdir(), "x.json"));
  assert.equal(meta.ephemeral, true);
  assert.equal(meta.survivesRestart, false);
});

test("preset catalog bulk parse", async () => {
  const { parsePresetCatalogBulk } = await import("./preset-catalog.mjs");
  const rows = parsePresetCatalogBulk(`
N2890904001 Gundam Anniversary
bandai N2903432003 ONE PIECE
`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sku, "N2890904001");
  assert.equal(rows[0].needsTitle, false);
  assert.equal(rows[1].store, "bandai");
});

test("preset catalog accepts SKU-only and Bandai PDP links", async () => {
  const { parsePresetCatalogBulk, serializePresetCatalogRows } = await import(
    "./preset-catalog.mjs"
  );
  const rows = parsePresetCatalogBulk(`
N2890904001
bandai N2903432003
https://p-bandai.com/au/item/N2890904001
`);
  assert.equal(rows.length, 2); // URL dedupes with first SKU
  assert.equal(rows[0].sku, "N2890904001");
  assert.equal(rows[0].needsTitle, true);
  assert.equal(rows[1].sku, "N2903432003");
  assert.equal(rows[1].store, "bandai");
  const linkOnly = parsePresetCatalogBulk("https://p-bandai.com/us/item/N1111222333");
  assert.equal(linkOnly[0].sku, "N1111222333");
  assert.equal(linkOnly[0].area, "us");
  assert.equal(linkOnly[0].needsTitle, true);
  assert.match(serializePresetCatalogRows(linkOnly), /bandai N1111222333/);
});

test("enrich preset titles fills from site fetch", async () => {
  const { parsePresetCatalogBulk } = await import("./preset-catalog.mjs");
  const { enrichPresetTitles, coerceBandaiTitle } = await import(
    "./enrich-preset-titles.mjs"
  );
  assert.equal(coerceBandaiTitle({ en: "GUNDAM CARD GAME 1st Anniversary Set" }), "GUNDAM CARD GAME 1st Anniversary Set");
  const rows = parsePresetCatalogBulk("N2890904001\nbandai N2903432003 Manual Keep");
  const out = await enrichPresetTitles(rows, {
    area: "au",
    fetchMeta: async (sku) =>
      sku === "N2890904001"
        ? { title: "Gundam Anniversary Set", areaItemNo: "NAI0859145AU", areaItemNos: ["NAI0859145AU"] }
        : null,
  });
  assert.ok(out.resolved >= 1);
  assert.equal(out.rows[0].title, "Gundam Anniversary Set");
  assert.equal(out.rows[0].areaItemNo, "NAI0859145AU");
  assert.equal(out.rows[0].titleSource, "site");
  assert.equal(out.rows[1].title, "Manual Keep"); // manual title kept
  assert.match(out.raw, /bandai N2890904001 Gundam Anniversary Set/);
  assert.match(out.raw, /bandai N2903432003 Manual Keep/);
  assert.ok(out.cacheEntries.some((e) => e.areaItemNo === "NAI0859145AU"));
});

test("shared product cache upsert + lookup", async () => {
  const {
    emptyProductCache,
    upsertProductEntries,
    lookupProduct,
    mergeRowsWithProductCache,
    isBackendPid,
  } = await import("./product-cache.mjs");
  assert.equal(isBackendPid("NAI0859145AU"), true);
  assert.equal(isBackendPid("NAP0458105001AU"), false);
  let cache = emptyProductCache();
  const up = upsertProductEntries(cache, {
    sku: "N2890904001",
    areaItemNo: "NAI0859145AU",
    title: "GUNDAM CARD GAME 1st Anniversary Set",
    area: "au",
    source: "enrich",
  });
  cache = up.cache;
  assert.equal(up.changed, 1);
  const hit = lookupProduct(cache, { sku: "N2890904001", area: "au" });
  assert.equal(hit.areaItemNo, "NAI0859145AU");
  const rows = mergeRowsWithProductCache(
    [{ store: "bandai", sku: "N2890904001", title: "N2890904001", needsTitle: true }],
    cache,
    "au",
  );
  assert.equal(rows[0].areaItemNo, "NAI0859145AU");
  assert.match(rows[0].title, /GUNDAM/i);
});
