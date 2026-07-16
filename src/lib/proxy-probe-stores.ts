/** Store probe targets for the built-in proxy tester. */

export type ProxyProbeStore = {
  id: string;
  label: string;
  /** Absolute URL to GET through the proxy. Empty for exit-ip-only mode. */
  probeUrl: string;
  /** Executor diagnose (same CONNECT stack as checkout) vs Browserless egress. */
  mode: "executor" | "browserless";
  notes?: string;
};

export const PROXY_PROBE_STORES: ProxyProbeStore[] = [
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
  {
    id: "exit-ip",
    label: "Exit IP only",
    probeUrl: "",
    mode: "browserless",
    notes: "Generic egress via Browserless/ipify — not the Kmart checkout transport.",
  },
];

export const DEFAULT_PROXY_PROBE_STORE_ID = "kmart";

export function getProxyProbeStore(storeId: string | null | undefined): ProxyProbeStore {
  const id = String(storeId || "").trim();
  return PROXY_PROBE_STORES.find((s) => s.id === id) ?? PROXY_PROBE_STORES[0];
}

export function resolveProbeUrl(
  storeId: string | null | undefined,
  customUrl?: string | null,
): { store: ProxyProbeStore; targetUrl: string | null } {
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
