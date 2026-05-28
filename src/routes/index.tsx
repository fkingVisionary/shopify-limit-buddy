import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger, DrawerClose, DrawerFooter,
} from "@/components/ui/drawer";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Loader2, ShoppingBag, AlertCircle, Zap, Settings, Plus, Trash2, Play, Square,
  Server, Store, Users, ListChecks, X, Pencil, Search,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Shopify Per-Person Limit Checker" },
      { name: "description", content: "Inspect any public Shopify store and detect per-customer purchase quantity limits on products." },
      { property: "og:title", content: "Shopify Per-Person Limit Checker" },
      { property: "og:description", content: "Detect per-customer purchase quantity limits on any public Shopify store." },
    ],
  }),
  component: Index,
});

type Variant = {
  id: number;
  title: string;
  price: string;
  available: boolean;
};

type Product = {
  id: number;
  title: string;
  handle: string;
  image: string | null;
  variants: Variant[];
};

type LimitInfo = {
  status: "idle" | "loading" | "done" | "error";
  maxPerOrder?: number | null;
  textHints?: string[];
  error?: string;
};

function normalizeStoreUrl(input: string): string | null {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const PROXIES_KEY = "shopify-limit-checker:proxies";

// In-memory proxy list (mirrored to localStorage). A "proxy" is a URL template
// that contains "{url}" — the request URL is substituted in. Empty/missing
// means use the same-origin /api/public/shopify route.
let __proxyList: string[] = [];
let __proxyIdx = 0;
function setProxyList(list: string[]) {
  __proxyList = list.filter((s) => s.includes("{url}"));
  __proxyIdx = 0;
}

function proxied(targetUrl: string): string {
  if (__proxyList.length === 0) {
    return `/api/public/shopify?url=${encodeURIComponent(targetUrl)}`;
  }
  const tmpl = __proxyList[__proxyIdx % __proxyList.length];
  __proxyIdx = (__proxyIdx + 1) % __proxyList.length;
  return tmpl.replace("{url}", encodeURIComponent(targetUrl));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPageWithRetry(url: string, maxAttempts = 5): Promise<Response | null> {
  let delay = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (res.status === 429 || res.status === 503 || res.status >= 500) {
      if (attempt === maxAttempts) return res;
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
      continue;
    }
    return res;
  }
  return null;
}

async function fetchProducts(
  storeUrl: string,
  onProgress?: (count: number, note?: string) => void,
): Promise<{ products: Product[]; partial: boolean; note?: string }> {
  const all: Product[] = [];
  let partial = false;
  let note: string | undefined;
  for (let page = 1; page <= 40; page++) {
    const res = await fetchPageWithRetry(
      proxied(`${storeUrl}/products.json?limit=250&page=${page}`),
    );
    if (!res) {
      partial = true;
      note = `Network failed at page ${page}.`;
      break;
    }
    if (!res.ok) {
      if (page === 1) {
        throw new Error(`Store returned ${res.status}. Is this a public Shopify store?`);
      }
      partial = true;
      note = `Store rate-limited at page ${page} (HTTP ${res.status}). Showing ${all.length} products fetched so far.`;
      break;
    }
    const data = await res.json();
    const products = (data.products ?? []) as any[];
    if (products.length === 0) break;
    for (const p of products) {
      all.push({
        id: p.id,
        title: p.title,
        handle: p.handle,
        image: p.images?.[0]?.src ?? null,
        variants: (p.variants ?? []).map((v: any) => ({
          id: v.id,
          title: v.title,
          price: v.price,
          available: v.available,
        })),
      });
    }
    onProgress?.(all.length);
    if (products.length < 250) break;
    // tiny gap between pages to be polite
    await sleep(150);
  }
  return { products: all, partial, note };
}

async function detectLimit(storeUrl: string, handle: string): Promise<LimitInfo> {
  // Primary source: Shopify's /products/{handle}.js exposes per-variant
  // quantity_rule.max — the merchant-configured per-order limit.
  try {
    const res = await fetch(proxied(`${storeUrl}/products/${handle}.js`));
    if (res.ok) {
      const data: any = await res.json();
      const variants: any[] = data.variants ?? [];
      const maxes: number[] = [];
      for (const v of variants) {
        const m = v?.quantity_rule?.max;
        if (typeof m === "number" && m > 0) maxes.push(m);
      }
      if (maxes.length > 0) {
        return { status: "done", maxPerOrder: Math.min(...maxes) };
      }
    }
  } catch {
    // fall through
  }

  const res = await fetch(proxied(`${storeUrl}/products/${handle}`));
  if (!res.ok) return { status: "error", error: `Could not load product page (${res.status})` };
  const html = await res.text();

  let maxFromText: number | null = null;
  const hints: string[] = [];
  const consider = (n: number, hint: string) => {
    if (!isNaN(n) && n > 0 && n < 1000) {
      maxFromText = maxFromText === null ? n : Math.min(maxFromText, n);
      hints.push(hint.trim().replace(/\s+/g, " ").slice(0, 120));
    }
  };

  // Pass 1: scan raw HTML (incl. scripts) for merchant JSON blobs like
  // JB Hi-Fi's `"LimitPerOrder":12` or generic `limitPerOrder: 12`.
  const jsonPatterns: RegExp[] = [
    /"limit[_ ]?per[_ ]?order"\s*:\s*(\d+)/gi,
    /"max[_ ]?per[_ ]?(?:customer|order|person)"\s*:\s*(\d+)/gi,
    /limitPerOrder\s*[:=]\s*(\d+)/gi,
  ];
  for (const re of jsonPatterns) {
    let m;
    while ((m = re.exec(html)) !== null) consider(parseInt(m[1], 10), m[0]);
  }

  // Pass 2: visible text patterns.
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const textPatterns: RegExp[] = [
    /limit(?:ed)?\s+(?:to\s+|of\s+)?(\d+)\s+(?:units?\s+)?per\s+(customer|order|person|household)/gi,
    /max(?:imum)?\s+(?:of\s+)?(\d+)\s+(?:units?\s+)?per\s+(customer|order|person|household)/gi,
    /(\d+)\s+(?:units?\s+)?per\s+(customer|order|person|household)\s+limit/gi,
    /only\s+(\d+)\s+per\s+(customer|order|person|household)/gi,
  ];
  for (const re of textPatterns) {
    let m;
    while ((m = re.exec(visible)) !== null) consider(parseInt(m[1], 10), m[0]);
  }

  return {
    status: "done",
    maxPerOrder: maxFromText,
    textHints: Array.from(new Set(hints)).slice(0, 3),
  };
}

type Prefill = {
  email: string;
  first_name: string;
  last_name: string;
  address1: string;
  city: string;
  province: string;
  zip: string;
  country: string;
  phone: string;
};

type Profile = Prefill & { id: string; name: string };

const PREFILL_KEY = "shopify-limit-checker:prefill"; // legacy single-profile
const PROFILES_KEY = "shopify-limit-checker:profiles";
const ACTIVE_KEY = "shopify-limit-checker:active-profiles";
const STORE_URL_KEY = "shopify-limit-checker:store-url";
const CATALOG_KEY = "shopify-limit-checker:catalog"; // { storeUrl, products, ts }
const DEFAULT_STORE_URL = "https://www.jbhifi.com.au";
const CATALOG_TTL_MS = 1000 * 60 * 60 * 12; // 12h

const emptyPrefill: Prefill = {
  email: "", first_name: "", last_name: "", address1: "",
  city: "", province: "", zip: "", country: "Australia", phone: "",
};

function saveCatalog(storeUrl: string, products: Product[]) {
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify({ storeUrl, products, ts: Date.now() }));
  } catch {}
}

function loadCatalog(): { storeUrl: string; products: Product[]; ts: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.storeUrl || !Array.isArray(data.products)) return null;
    return data;
  } catch { return null; }
}

// Fetch a single product by Shopify handle and return it as a Product
async function fetchProductByHandle(storeUrl: string, handle: string): Promise<Product | null> {
  const res = await fetch(proxied(`${storeUrl}/products/${handle}.js`));
  if (!res.ok) return null;
  const p: any = await res.json();
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    image: p.featured_image ? (p.featured_image.startsWith("//") ? `https:${p.featured_image}` : p.featured_image) : (p.images?.[0] ?? null),
    variants: (p.variants ?? []).map((v: any) => ({ id: v.id, title: v.public_title ?? v.title, price: typeof v.price === "number" ? (v.price / 100).toFixed(2) : v.price, available: v.available })),
  };
}

// Extract a Shopify product handle from a URL like
// https://www.jbhifi.com.au/products/some-handle?variant=...
function handleFromUrl(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/products\/([a-z0-9][a-z0-9-]*)/i);
  return m ? m[1] : null;
}

async function searchProducts(storeUrl: string, query: string, limit = 8): Promise<Product[]> {
  const q = encodeURIComponent(query.trim());
  const url = `${storeUrl}/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=${limit}`;
  const res = await fetch(proxied(url));
  if (!res.ok) return [];
  const data: any = await res.json();
  const items: any[] = data?.resources?.results?.products ?? [];
  // suggest.json doesn't return variants — fetch each handle in parallel
  const results = await Promise.all(items.map((it) => fetchProductByHandle(storeUrl, it.handle)));
  return results.filter((p): p is Product => !!p);
}

const makeId = () => Math.random().toString(36).slice(2, 10);

function loadProfiles(): { profiles: Profile[]; activeIds: string[] } {
  if (typeof window === "undefined") return { profiles: [], activeIds: [] };
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (raw) {
      const profiles = JSON.parse(raw) as Profile[];
      const activeRaw = localStorage.getItem(ACTIVE_KEY);
      const activeIds = activeRaw ? (JSON.parse(activeRaw) as string[]) : profiles.map((p) => p.id);
      return { profiles, activeIds };
    }
    // Migrate legacy single prefill
    const legacy = localStorage.getItem(PREFILL_KEY);
    if (legacy) {
      const data = { ...emptyPrefill, ...JSON.parse(legacy) } as Prefill;
      const p: Profile = { id: makeId(), name: "Default", ...data };
      return { profiles: [p], activeIds: [p.id] };
    }
  } catch {}
  return { profiles: [], activeIds: [] };
}

function saveProfiles(profiles: Profile[], activeIds: string[]) {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeIds));
  } catch {}
}

function buildCheckoutUrl(storeUrl: string, variantId: number, qty: number, p: Prefill): string {
  const params = new URLSearchParams();
  if (p.email) params.set("checkout[email]", p.email);
  if (p.first_name) params.set("checkout[shipping_address][first_name]", p.first_name);
  if (p.last_name) params.set("checkout[shipping_address][last_name]", p.last_name);
  if (p.address1) params.set("checkout[shipping_address][address1]", p.address1);
  if (p.city) params.set("checkout[shipping_address][city]", p.city);
  if (p.province) params.set("checkout[shipping_address][province]", p.province);
  if (p.zip) params.set("checkout[shipping_address][zip]", p.zip);
  if (p.country) params.set("checkout[shipping_address][country]", p.country);
  if (p.phone) params.set("checkout[shipping_address][phone]", p.phone);
  const qs = params.toString();
  return `${storeUrl}/cart/${variantId}:${qty}${qs ? `?${qs}` : ""}`;
}

function Index() {
  const [url, setUrl] = useState(DEFAULT_STORE_URL);
  const [quickAdd, setQuickAdd] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);
  const [cacheAge, setCacheAge] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [storeUrl, setStoreUrl] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [limits, setLimits] = useState<Record<number, LimitInfo>>({});
  const [query, setQuery] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  // Watcher state
  const [watched, setWatched] = useState<Set<number>>(new Set());
  const [watchStatus, setWatchStatus] = useState<Record<number, { lastChecked: number; available: boolean; lastVariantId?: number; error?: string }>>({});
  const [pollMs, setPollMs] = useState(4000);
  const [autoOpen, setAutoOpen] = useState(false);
  const [notifyOn, setNotifyOn] = useState(true);
  const [tab, setTab] = useState<"watch" | "browse" | "profiles" | "settings">("browse");
  const [proxiesText, setProxiesText] = useState("");
  const triggeredRef = (typeof window !== "undefined") ? (window as any).__triggeredRef ?? ((window as any).__triggeredRef = { current: new Set<number>() }) : { current: new Set<number>() };

  useEffect(() => {
    const { profiles, activeIds } = loadProfiles();
    setProfiles(profiles);
    setActiveIds(activeIds);
    try {
      const savedUrl = localStorage.getItem(STORE_URL_KEY);
      if (savedUrl) setUrl(savedUrl);
      const savedProxies = localStorage.getItem(PROXIES_KEY) ?? "";
      setProxiesText(savedProxies);
      setProxyList(savedProxies.split("\n").map((s) => s.trim()).filter(Boolean));
    } catch {}
    // Restore cached catalog
    const cached = loadCatalog();
    if (cached && Date.now() - cached.ts < CATALOG_TTL_MS) {
      setStoreUrl(cached.storeUrl);
      setProducts(cached.products);
      setCacheAge(cached.ts);
    }
  }, []);


  const persistProfiles = (next: Profile[], nextActive?: string[]) => {
    const active = nextActive ?? activeIds.filter((id) => next.some((p) => p.id === id));
    setProfiles(next);
    setActiveIds(active);
    saveProfiles(next, active);
  };

  const addProfile = () => {
    const p: Profile = { id: makeId(), name: `Profile ${profiles.length + 1}`, ...emptyPrefill };
    persistProfiles([...profiles, p], [...activeIds, p.id]);
  };

  const updateProfile = (id: string, patch: Partial<Profile>) => {
    persistProfiles(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const deleteProfile = (id: string) => {
    persistProfiles(profiles.filter((p) => p.id !== id), activeIds.filter((x) => x !== id));
  };

  const toggleActive = (id: string) => {
    const next = activeIds.includes(id) ? activeIds.filter((x) => x !== id) : [...activeIds, id];
    setActiveIds(next);
    saveProfiles(profiles, next);
  };

  const activeProfiles = profiles.filter((p) => activeIds.includes(p.id));


  // Audio beep using WebAudio (no asset needed)
  const beep = () => {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square"; o.frequency.value = 880;
      g.gain.value = 0.15;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(() => { o.frequency.value = 1320; }, 150);
      setTimeout(() => { o.stop(); ctx.close(); }, 450);
    } catch {}
  };

  const notifyDrop = (title: string, body: string) => {
    if (!notifyOn) return;
    beep();
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body });
      }
    } catch {}
  };

  const toggleWatch = async (p: Product) => {
    if ("Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch {}
    }
    setWatched((prev) => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id);
      else next.add(p.id);
      return next;
    });
  };


  // Open one tab per active profile, staggered to avoid popup blocking
  const openForProfiles = (urlsByProfile: { profile: Profile; url: string }[]) => {
    urlsByProfile.forEach(({ profile, url }, i) => {
      setTimeout(() => {
        const w = window.open(url, `_blank_${profile.id}`, "noopener,noreferrer");
        if (!w && i > 0) {
          console.warn(`Popup blocked for profile "${profile.name}". Allow popups for this site.`);
        }
      }, i * 250);
    });
  };

  const quickCheckout = (p: Product, opts?: { variantId?: number; qty?: number }) => {
    if (!storeUrl) return;
    if (activeProfiles.length === 0) {
      setError("No active profiles. Add at least one in Checkout info.");
      return;
    }
    const variant = opts?.variantId
      ? p.variants.find((v) => v.id === opts.variantId) ?? p.variants[0]
      : p.variants.find((v) => v.available) ?? p.variants[0];
    if (!variant) return;
    const info = limits[p.id];
    const qty = opts?.qty ?? (info?.maxPerOrder && info.maxPerOrder > 0 ? info.maxPerOrder : 1);
    openForProfiles(
      activeProfiles.map((profile) => ({
        profile,
        url: buildCheckoutUrl(storeUrl, variant.id, qty, profile),
      })),
    );
  };

  // Polling loop for watched products
  useEffect(() => {
    if (!storeUrl || watched.size === 0) return;
    let cancelled = false;
    const tick = async () => {
      const ids = Array.from(watched);
      await Promise.all(ids.map(async (pid) => {
        const product = products.find((p) => p.id === pid);
        if (!product) return;
        try {
          const res = await fetch(proxied(`${storeUrl}/products/${product.handle}.js`));
          if (!res.ok) {
            setWatchStatus((s) => ({ ...s, [pid]: { ...(s[pid] ?? { available: false }), lastChecked: Date.now(), error: `HTTP ${res.status}` } }));
            return;
          }
          const data: any = await res.json();
          const variants: any[] = data.variants ?? [];
          const availVariant = variants.find((v) => v.available);
          const isAvail = !!availVariant;
          setWatchStatus((s) => ({
            ...s,
            [pid]: { lastChecked: Date.now(), available: isAvail, lastVariantId: availVariant?.id, error: undefined },
          }));
          if (isAvail && !triggeredRef.current.has(pid)) {
            triggeredRef.current.add(pid);
            notifyDrop("IN STOCK", `${product.title} — opening ${activeProfiles.length} tab(s)`);
            if (autoOpen && activeProfiles.length > 0) {
              const info = limits[pid];
              const qty = info?.maxPerOrder && info.maxPerOrder > 0 ? info.maxPerOrder : 1;
              openForProfiles(
                activeProfiles.map((profile) => ({
                  profile,
                  url: buildCheckoutUrl(storeUrl, availVariant.id, qty, profile),
                })),
              );
            }
          }
          if (!isAvail) triggeredRef.current.delete(pid);
        } catch (e: any) {
          setWatchStatus((s) => ({ ...s, [pid]: { ...(s[pid] ?? { available: false }), lastChecked: Date.now(), error: e?.message ?? "fetch failed" } }));
        }
      }));
    };
    tick();
    const id = setInterval(() => { if (!cancelled) tick(); }, Math.max(1500, pollMs));
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeUrl, watched, pollMs, autoOpen, notifyOn, products, activeProfiles, limits]);



  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setProducts([]);
    setLimits({});
    setProgress(0);
    setCacheAge(null);
    const normalized = normalizeStoreUrl(url);
    if (!normalized) {
      setError("Please enter a valid store URL.");
      return;
    }
    setStoreUrl(normalized);
    try { localStorage.setItem(STORE_URL_KEY, normalized); } catch {}
    setLoading(true);
    try {
      const result = await fetchProducts(normalized, (n) => setProgress(n));
      setProducts(result.products);
      saveCatalog(normalized, result.products);
      setCacheAge(Date.now());
      if (result.products.length === 0) {
        setError("No products found. The store may be private or empty.");
      } else if (result.partial && result.note) {
        setError(result.note);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to fetch products.");
    } finally {
      setLoading(false);
    }
  };

  // Quick-add: accepts a product URL (any /products/<handle>) OR a search keyword.
  // Skips the full catalog scan and appends matches to the list.
  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const raw = quickAdd.trim();
    if (!raw) return;
    // Determine target store: URL pasted → derive from it; else current/default
    let targetStore = storeUrl;
    if (/^https?:\/\//i.test(raw)) {
      const norm = normalizeStoreUrl(raw);
      if (norm) targetStore = norm;
    }
    if (!targetStore) {
      targetStore = normalizeStoreUrl(url) ?? DEFAULT_STORE_URL;
    }
    setStoreUrl(targetStore);
    try { localStorage.setItem(STORE_URL_KEY, targetStore); } catch {}
    setQuickBusy(true);
    try {
      const handle = handleFromUrl(raw);
      let found: Product[] = [];
      if (handle) {
        const p = await fetchProductByHandle(targetStore, handle);
        if (p) found = [p];
        else throw new Error("Couldn't load that product. Check the URL.");
      } else {
        found = await searchProducts(targetStore, raw, 8);
        if (found.length === 0) throw new Error(`No matches for "${raw}".`);
      }
      // Merge into products (dedupe by id), put new at top
      setProducts((prev) => {
        const ids = new Set(prev.map((p) => p.id));
        const fresh = found.filter((p) => !ids.has(p.id));
        const next = [...fresh, ...prev];
        saveCatalog(targetStore!, next);
        return next;
      });
      setQuickAdd("");
    } catch (err: any) {
      setError(err.message ?? "Quick add failed.");
    } finally {
      setQuickBusy(false);
    }
  };


  const checkLimit = async (product: Product) => {
    if (!storeUrl) return;
    setLimits((prev) => ({ ...prev, [product.id]: { status: "loading" } }));
    try {
      const info = await detectLimit(storeUrl, product.handle);
      setLimits((prev) => ({ ...prev, [product.id]: info }));
    } catch (err: any) {
      setLimits((prev) => ({
        ...prev,
        [product.id]: { status: "error", error: err.message ?? "Failed" },
      }));
    }
  };

  const checkAll = async () => {
    if (!storeUrl) return;
    // Limit concurrency to be polite
    const queue = [...products];
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const p = queue.shift();
        if (!p) break;
        await checkLimit(p);
      }
    });
    await Promise.all(workers);
  };

  const filtered = products.filter((p) =>
    p.title.toLowerCase().includes(query.toLowerCase()),
  );

  const watchedProducts = products.filter((p) => watched.has(p.id));
  const proxyCount = __proxyList.length;

  const saveProxies = (text: string) => {
    setProxiesText(text);
    const list = text.split("\n").map((s) => s.trim()).filter(Boolean);
    setProxyList(list);
    try { localStorage.setItem(PROXIES_KEY, text); } catch {}
  };

  const tabLabel = { watch: "Watch", browse: "Browse", profiles: "Profiles", settings: "Settings" }[tab];

  const ProductCard = ({ p }: { p: Product }) => {
    const info = limits[p.id];
    const w = watchStatus[p.id];
    const isWatched = watched.has(p.id);
    return (
      <Card className="p-3">
        <div className="flex gap-3">
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
            {p.image ? <img src={p.image} alt={p.title} className="h-full w-full object-cover" loading="lazy" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <a href={`${storeUrl}/products/${p.handle}`} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">
              {p.title}
            </a>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{p.variants.length} variant{p.variants.length === 1 ? "" : "s"}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {info?.status === "done" && info.maxPerOrder != null && (
                <Badge variant="default" className="gap-1 text-[10px]"><CheckCircle2 className="h-3 w-3" />Limit {info.maxPerOrder}</Badge>
              )}
              {info?.status === "done" && info.maxPerOrder == null && (
                <Badge variant="secondary" className="text-[10px]">No limit detected</Badge>
              )}
              {info?.status === "error" && <span className="text-[10px] text-destructive">{info.error}</span>}
              {isWatched && (
                w?.error ? <Badge variant="destructive" className="text-[10px]">{w.error}</Badge>
                : w?.available ? <Badge className="bg-green-600 text-white gap-1 text-[10px]"><Bell className="h-3 w-3" />IN STOCK</Badge>
                : w ? <Badge variant="outline" className="gap-1 text-[10px]"><Bell className="h-3 w-3" />{Math.max(0, Math.round((Date.now() - w.lastChecked) / 1000))}s ago</Badge>
                : <Badge variant="outline" className="gap-1 text-[10px]"><Bell className="h-3 w-3 animate-pulse" />Polling</Badge>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <Button size="sm" variant="outline" onClick={() => checkLimit(p)} disabled={info?.status === "loading"} className="h-8 text-xs">
            {info?.status === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Limit"}
          </Button>
          <Button size="sm" variant={isWatched ? "default" : "secondary"} onClick={() => toggleWatch(p)} className="h-8 text-xs">
            {isWatched ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {isWatched ? "Stop" : "Watch"}
          </Button>
          <Button size="sm" onClick={() => quickCheckout(p)} disabled={activeProfiles.length === 0} className="h-8 text-xs">
            <Zap className="h-3.5 w-3.5" />×{activeProfiles.length}
          </Button>
        </div>
      </Card>
    );
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <ShoppingBag className="h-5 w-5" />
            <div>
              <h1 className="text-base font-semibold leading-tight">{tabLabel}</h1>
              <p className="text-[10px] leading-tight text-muted-foreground">
                {activeProfiles.length} profile{activeProfiles.length === 1 ? "" : "s"} · {proxyCount > 0 ? `${proxyCount} prox` : "direct"} · {watched.size} watch
              </p>
            </div>
          </div>
          {tab === "browse" && storeUrl && (
            <div className="truncate text-[10px] text-muted-foreground">{storeUrl.replace(/^https?:\/\//, "")}</div>
          )}
        </div>
        {error && (
          <div className="mx-auto flex max-w-3xl items-start gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-destructive/70 hover:text-destructive">✕</button>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24 pt-4">
        {tab === "watch" && (
          <div className="space-y-3">
            <Card className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">Monitor</div>
                  <div className="text-[11px] text-muted-foreground">
                    Polling every {(pollMs / 1000).toFixed(1)}s · {proxyCount > 0 ? `rotating ${proxyCount} prox` : "direct"} · auto-open {autoOpen ? "on" : "off"}
                  </div>
                </div>
                <Radar className={`h-5 w-5 ${watched.size > 0 ? "text-green-600 animate-pulse" : "text-muted-foreground"}`} />
              </div>
            </Card>
            {watchedProducts.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
                No products being watched. Add some from the <button className="underline" onClick={() => setTab("browse")}>Browse</button> tab.
              </div>
            ) : (
              watchedProducts.map((p) => <ProductCard key={p.id} p={p} />)
            )}
          </div>
        )}

        {tab === "browse" && (
          <div className="space-y-3">
            <form onSubmit={handleQuickAdd} className="flex gap-2">
              <Input
                type="text"
                placeholder="Paste product URL or search keywords"
                value={quickAdd}
                onChange={(e) => setQuickAdd(e.target.value)}
                className="flex-1"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <Button type="submit" disabled={quickBusy} size="icon">
                {quickBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </form>

            {products.length > 0 && (
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input placeholder="Filter products..." value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 flex-1" />
              </div>
            )}

            {loading && (
              <div className="text-xs text-muted-foreground">Loading... <span className="font-medium text-foreground">{progress}</span> fetched</div>
            )}

            <div className="space-y-2">
              {filtered.map((p) => <ProductCard key={p.id} p={p} />)}
            </div>

            {products.length === 0 && !loading && (
              <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
                <p>Paste a product URL above, or scan a full catalog from Settings.</p>
              </div>
            )}

            {products.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-[11px] text-muted-foreground">
                <span>{products.length} cached{cacheAge ? ` · ${Math.round((Date.now() - cacheAge) / 60000)}m ago` : ""}</span>
                <div className="flex gap-3">
                  <button className="underline" onClick={checkAll}>Check all limits</button>
                  <button className="underline" onClick={() => { try { localStorage.removeItem(CATALOG_KEY); } catch {} setProducts([]); setLimits({}); setCacheAge(null); }}>Clear cache</button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "profiles" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">{activeProfiles.length}/{profiles.length} active</div>
              <Button size="sm" onClick={addProfile}><Plus className="h-3.5 w-3.5" />Add profile</Button>
            </div>
            {profiles.length === 0 && (
              <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
                No profiles yet. Each active profile opens its own prefilled checkout tab.
              </div>
            )}
            {profiles.map((profile) => {
              const isActive = activeIds.includes(profile.id);
              return (
                <Card key={profile.id} className={`p-3 ${isActive ? "" : "opacity-60"}`}>
                  <div className="mb-2 flex items-center gap-2">
                    <input type="checkbox" checked={isActive} onChange={() => toggleActive(profile.id)} className="h-4 w-4" />
                    <Input value={profile.name} onChange={(e) => updateProfile(profile.id, { name: e.target.value })} className="h-8 flex-1 font-medium" placeholder="Profile name" />
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => deleteProfile(profile.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      ["email", "Email"], ["phone", "Phone"],
                      ["first_name", "First name"], ["last_name", "Last name"],
                      ["address1", "Address"], ["city", "City"],
                      ["province", "State"], ["zip", "Postcode"],
                      ["country", "Country"],
                    ] as const).map(([k, label]) => (
                      <div key={k} className={k === "address1" ? "col-span-2" : ""}>
                        <Label className="text-[10px] text-muted-foreground">{label}</Label>
                        <Input value={profile[k]} onChange={(e) => updateProfile(profile.id, { [k]: e.target.value } as Partial<Profile>)} className="h-8 text-sm" />
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {tab === "settings" && (
          <div className="space-y-4">
            <Card className="p-3">
              <Label className="text-xs font-medium">Store URL</Label>
              <form onSubmit={handleScan} className="mt-2 flex gap-2">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="https://www.jbhifi.com.au" />
                <Button type="submit" disabled={loading} variant="secondary" size="sm">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Scan
                </Button>
              </form>
              <p className="mt-1.5 text-[10px] text-muted-foreground">Scan downloads the full public catalog (cached 12h).</p>
            </Card>

            <Card className="p-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">Proxy rotation</Label>
                <Badge variant={proxyCount > 0 ? "default" : "outline"} className="text-[10px]">{proxyCount > 0 ? `${proxyCount} active` : "Direct"}</Badge>
              </div>
              <Textarea
                value={proxiesText}
                onChange={(e) => saveProxies(e.target.value)}
                className="mt-2 min-h-[100px] font-mono text-[11px]"
                placeholder={"One proxy URL template per line, must contain {url}\nhttps://proxy1.example.com/fetch?url={url}\nhttps://proxy2.example.com/get?target={url}"}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                Each request rotates round-robin. Use <code className="font-mono">{`{url}`}</code> as the placeholder for the encoded target URL. Leave blank to fetch through the built-in server proxy.
              </p>
            </Card>

            <Card className="p-3">
              <Label className="text-xs font-medium">Drop monitor</Label>
              <div className="mt-2 space-y-2">
                <div>
                  <Label className="text-[10px] text-muted-foreground">Poll interval (ms, min 1500)</Label>
                  <Input type="number" min={1500} step={500} value={pollMs} onChange={(e) => setPollMs(Math.max(1500, Number(e.target.value) || 4000))} className="h-8" />
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} className="h-4 w-4" />
                  Auto-open checkout tabs on drop
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={notifyOn} onChange={(e) => setNotifyOn(e.target.checked)} className="h-4 w-4" />
                  Sound + browser notification
                </label>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                Keep this tab pinned — browsers throttle background tabs.
              </p>
            </Card>
          </div>
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto grid max-w-3xl grid-cols-4">
          {([
            ["watch", "Watch", Radar, watched.size],
            ["browse", "Browse", Search, products.length],
            ["profiles", "Profiles", Users, activeProfiles.length],
            ["settings", "Settings", Settings, 0],
          ] as const).map(([key, label, Icon, count]) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] transition-colors ${active ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                <div className="relative">
                  <Icon className={`h-5 w-5 ${active && key === "watch" && watched.size > 0 ? "animate-pulse" : ""}`} />
                  {count > 0 && (
                    <span className="absolute -right-2 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </div>
                <span className="font-medium">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
