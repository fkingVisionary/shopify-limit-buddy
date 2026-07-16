// Preset store catalog — mirrors the web dashboard for later multi-store expansion.
// Only adapters with desktop support can run; others are selectable for future work.

const PRESET_STORES = [
  { id: "preset-kmart", name: "Kmart AU", url: "https://www.kmart.com.au", preset: true, adapter: "kmart" },
  { id: "preset-jbhifi", name: "JB Hi-Fi", url: "https://www.jbhifi.com.au", preset: true, adapter: "jbhifi" },
  { id: "preset-allbirds", name: "Allbirds", url: "https://www.allbirds.com", preset: true, adapter: "shopify" },
  { id: "preset-gymshark", name: "Gymshark", url: "https://www.gymshark.com", preset: true, adapter: "shopify" },
  { id: "preset-kith", name: "Kith", url: "https://kith.com", preset: true, adapter: "shopify" },
  { id: "preset-culturekings", name: "Culture Kings", url: "https://culturekings.com.au", preset: true, adapter: "shopify" },
  { id: "preset-supplystore", name: "Supply Store", url: "https://www.supplystore.com.au", preset: true, adapter: "shopify" },
  { id: "preset-bape", name: "BAPE", url: "https://us.bape.com", preset: true, adapter: "shopify" },
  { id: "preset-deathwish", name: "Death Wish Coffee", url: "https://www.deathwishcoffee.com", preset: true, adapter: "shopify" },
];

function normalizeStoreUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return u.replace(/\/$/, "");
  }
}

function adapterForStore(store) {
  if (!store) return "kmart";
  if (store.adapter) return store.adapter;
  if (/kmart/i.test(store.id || "") || /kmart\.com\.au/i.test(store.url || "")) return "kmart";
  if (/jbhifi/i.test(store.id || "") || /jbhifi\.com/i.test(store.url || "")) return "jbhifi";
  return "shopify";
}

function isKmartStore(store) {
  return adapterForStore(store) === "kmart";
}

module.exports = {
  PRESET_STORES,
  normalizeStoreUrl,
  adapterForStore,
  isKmartStore,
};
