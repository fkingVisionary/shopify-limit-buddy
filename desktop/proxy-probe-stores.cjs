// Mirrors src/lib/proxy-probe-stores.ts for the desktop app.

const PROXY_PROBE_STORES = [
  {
    id: "kmart",
    label: "Kmart AU",
    probeUrl: "https://www.kmart.com.au/",
    mode: "executor",
    notes: "Same CONNECT path as Kmart checkout. Tunnel OK ≠ checkout success (Akamai).",
  },
  {
    id: "jbhifi",
    label: "JB Hi-Fi",
    probeUrl: "https://www.jbhifi.com.au/",
    mode: "executor",
  },
  {
    id: "culturekings",
    label: "Culture Kings",
    probeUrl: "https://culturekings.com.au/",
    mode: "executor",
  },
  {
    id: "gymshark",
    label: "Gymshark",
    probeUrl: "https://www.gymshark.com/",
    mode: "executor",
  },
  {
    id: "allbirds",
    label: "Allbirds",
    probeUrl: "https://www.allbirds.com/",
    mode: "executor",
  },
];

const DEFAULT_PROXY_PROBE_STORE_ID = "kmart";

function getProxyProbeStore(storeId) {
  const id = String(storeId || "").trim();
  return PROXY_PROBE_STORES.find((s) => s.id === id) ?? PROXY_PROBE_STORES[0];
}

function resolveProbeUrl(storeId, customUrl) {
  const store = getProxyProbeStore(storeId);
  const custom = String(customUrl || "").trim();
  if (custom) {
    try {
      const u = new URL(/^https?:\/\//i.test(custom) ? custom : `https://${custom}`);
      return { store, targetUrl: `${u.protocol}//${u.host}${u.pathname || "/"}` };
    } catch {
      return { store, targetUrl: store.probeUrl || null };
    }
  }
  return { store, targetUrl: store.probeUrl || null };
}

module.exports = {
  PROXY_PROBE_STORES,
  DEFAULT_PROXY_PROBE_STORE_ID,
  getProxyProbeStore,
  resolveProbeUrl,
};
