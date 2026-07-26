#!/usr/bin/env node
// Lab: mint one Bandai F5 harvest slot (live Playwright) then optionally claim.
//
//   PROXY='host:port:user:pass' node executor/scripts/bandai-harvest-lab.mjs
//   BANDAI_HARVEST_CLAIM=1 …  # take + close (proves claim handoff)
//
// Does not run checkout — only proves warm bank + take.

import {
  mintHarvestSlot,
  takeHarvestSlot,
  clearHarvestSlots,
  harvestSnapshot,
} from "../adapters/bandai-harvest-pool.js";

const proxy = process.env.PROXY || process.env.PROXY_URL_RESI || "";
const area = process.env.BANDAI_AREA || "au";
const doClaim = /^(1|true|yes)$/i.test(String(process.env.BANDAI_HARVEST_CLAIM || ""));

async function main() {
  if (!proxy) {
    console.error("Set PROXY or PROXY_URL_RESI (sticky AU ISP/resi)");
    process.exit(2);
  }
  await clearHarvestSlots();
  console.log("[harvest] minting…", { area, proxyHost: proxy.split(":")[0] });
  const out = await mintHarvestSlot({ proxy, area });
  console.log(JSON.stringify({ ok: out.ok, ms: out.ms, error: out.error, session: out.session }, null, 2));
  if (!out.ok) process.exit(1);

  if (doClaim) {
    const claimed = takeHarvestSlot(out.session.id);
    console.log("[harvest] claimed", Boolean(claimed?.bridge), claimed?.meta?.id);
    await claimed?.bridge?.close?.();
  }

  console.log("[harvest] snapshot", harvestSnapshot());
  if (!doClaim) {
    console.log("[harvest] leaving slot warm — clear with BANDAI_HARVEST_CLAIM=1 or clearHarvestSlots");
    await clearHarvestSlots();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
