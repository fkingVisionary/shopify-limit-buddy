#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dbPath = path.join(
  process.env.APPDATA || "",
  "vanta-desktop",
  "j1ms-desktop",
  "db.json",
);
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const tasks = db.tasks || [];
const bandai = tasks.filter((t) => t.store === "bandai");
console.log(
  JSON.stringify(
    {
      dbPath,
      taskCount: tasks.length,
      bandaiCount: bandai.length,
      bandai: bandai.slice(0, 12).map((t) => ({
        id: t.id,
        label: t.label,
        mode: t.bandaiMode,
        checkout: t.bandaiCheckoutMode,
        placeOrder: t.placeOrder,
        profileId: t.profileId,
        proxyGroupId: t.proxyGroupId,
        sku: t.bandaiWatchSku || t.pdpUrl,
        enabled: t.enabled,
        lastStatus: t.lastStatus,
        lastLabel: t.lastLabel,
        quantity: t.quantity,
      })),
      profiles: (db.profiles || []).map((p) => ({
        id: p.id,
        name: p.name || p.label,
        hasCard: Boolean(p.card?.number || p.card_number || p.cardNumber),
      })),
      proxyGroups: (db.proxyGroups || []).map((g) => ({
        id: g.id,
        name: g.name,
        n: (g.entries || g.proxies || g.lines || []).length,
      })),
      accounts: (db.accounts || [])
        .filter((a) => /bandai/i.test(String(a.store || a.storeId || "")))
        .slice(0, 8)
        .map((a) => ({
          id: a.id,
          email: a.email,
          status: a.status,
          store: a.store || a.storeId,
        })),
    },
    null,
    2,
  ),
);
