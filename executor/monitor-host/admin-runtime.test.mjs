import test from "node:test";
import assert from "node:assert/strict";
import { createMonitorProxyPool } from "../monitor/monitor-proxy-pool.js";
import { createBandaiStockMonitor } from "../monitor/bandai-stock-monitor.js";
import { vantaOosDiscordBody, vantaRestockDiscordBody } from "./vanta-discord.mjs";
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

test("oos discord is red; restock is black", () => {
  const body = vantaOosDiscordBody({
    productId: "N1",
    title: "Demo",
    reason: "went_oos",
  });
  assert.equal(body.username, "Vanta");
  assert.match(body.embeds[0].title, /^OOS ·/);
  assert.match(body.embeds[0].description, /OUT OF STOCK/i);
  assert.equal(body.embeds[0].color, 0xdc2626);
  const restock = vantaRestockDiscordBody({ productId: "N1", title: "Demo" });
  assert.equal(restock.embeds[0].color, 0x000000);
});

test("runtime config round-trip", () => {
  const file = path.join(os.tmpdir(), `vanta-cfg-${Date.now()}.json`);
  saveRuntimeConfig(
    {
      keywords: "GUNDAM",
      ispProxies: "1.1.1.1:80:u:p",
      dcProxies: "",
      intervalMs: 4000,
      notifyOos: true,
    },
    file,
  );
  const loaded = loadRuntimeConfig(file);
  assert.equal(loaded.keywords, "GUNDAM");
  assert.equal(loaded.intervalMs, 4000);
  assert.equal(loaded._fromDisk, true);
  fs.unlinkSync(file);
});
