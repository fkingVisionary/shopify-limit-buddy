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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle, Settings, Plus, Trash2, Play, Square,
  Server, Store, Users, ListChecks, X, HelpCircle, Info, ChevronLeft, ChevronRight,
  Check, BookOpen, Sparkles, Package, User as UserIcon,
} from "lucide-react";
import jimsLogo from "@/assets/jims-logo.jpg";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "J1m's Bot" },
      { name: "description", content: "J1m's Bot — Shopify monitor, profile manager, and one-tap checkout launcher." },
      { property: "og:title", content: "J1m's Bot" },
      { property: "og:description", content: "Shopify monitor, profile manager, and one-tap checkout launcher." },
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

// ─────────────── Proxy groups ───────────────
const PROXIES_KEY = "shopify-limit-checker:proxies";      // legacy flat list
const PROXY_GROUPS_KEY = "aio:proxy-groups";              // new: groups

type ProxyGroup = { id: string; name: string; proxies: string[] };

// In-memory mirror so the network helpers can rotate without React state.
let __proxyGroups: ProxyGroup[] = [];
const __rotIdx: Record<string, number> = {};
function setProxyGroupsRuntime(groups: ProxyGroup[]) {
  __proxyGroups = groups.map((g) => ({
    ...g,
    proxies: g.proxies.filter((s) => s.includes("{url}")),
  }));
}

// Build a request URL. If groupId resolves to a group with proxies, rotate
// round-robin within it; otherwise fall back to the same-origin proxy route.
function proxied(targetUrl: string, groupId?: string | null): string {
  const direct = `/api/public/shopify?url=${encodeURIComponent(targetUrl)}`;
  if (!groupId) return direct;
  const group = __proxyGroups.find((g) => g.id === groupId);
  if (!group || group.proxies.length === 0) return direct;
  const i = (__rotIdx[group.id] ?? 0) % group.proxies.length;
  __rotIdx[group.id] = (i + 1) % group.proxies.length;
  return group.proxies[i].replace("{url}", encodeURIComponent(targetUrl));
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

// ─────────────── Stores ───────────────
type StoreEntry = { id: string; name: string; url: string; preset?: boolean };

const PRESET_STORES: StoreEntry[] = [
  { id: "preset-jbhifi", name: "JB Hi-Fi", url: "https://www.jbhifi.com.au", preset: true },
  { id: "preset-allbirds", name: "Allbirds", url: "https://www.allbirds.com", preset: true },
  { id: "preset-gymshark", name: "Gymshark", url: "https://www.gymshark.com", preset: true },
  { id: "preset-kith", name: "Kith", url: "https://kith.com", preset: true },
  { id: "preset-culturekings", name: "Culture Kings", url: "https://culturekings.com.au", preset: true },
  { id: "preset-supplystore", name: "Supply Store", url: "https://www.supplystore.com.au", preset: true },
  { id: "preset-bape", name: "BAPE", url: "https://us.bape.com", preset: true },
  { id: "preset-deathwish", name: "Death Wish Coffee", url: "https://www.deathwishcoffee.com", preset: true },
];
const STORES_KEY = "aio:custom-stores";
function loadCustomStores(): StoreEntry[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(STORES_KEY) ?? "[]"); } catch { return []; }
}
function saveCustomStores(s: StoreEntry[]) { try { localStorage.setItem(STORES_KEY, JSON.stringify(s)); } catch {} }

// ─────────────── Tasks ───────────────
type TaskStatus = "idle" | "monitoring" | "in_stock" | "opened" | "error";
type Task = {
  id: string;
  storeId: string;
  storeUrl: string;
  storeName: string;
  input: string;       // URL, handle, SKU, or keyword
  profileId: string;
  proxyIdx: number | -1; // -1 = rotate
  qty: number;
  status: TaskStatus;
  running: boolean;
  productHandle?: string;
  productTitle?: string;
  productImage?: string;
  variantId?: number;
  limit?: number | null;
  lastChecked?: number;
  message?: string;
};
const TASKS_KEY = "aio:tasks";
function loadTasks(): Task[] {
  if (typeof window === "undefined") return [];
  try {
    const arr = JSON.parse(localStorage.getItem(TASKS_KEY) ?? "[]") as Task[];
    // Reset transient runtime fields
    return arr.map((t) => ({ ...t, running: false, status: t.status === "in_stock" || t.status === "opened" ? t.status : "idle" }));
  } catch { return []; }
}

// ─────────────── UX persistence ───────────────
const WIZARD_KEY = "aio:wizard-done";
const TIPS_DISMISS_KEY = "aio:tips-dismissed";
function loadDismissedTips(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(TIPS_DISMISS_KEY) ?? "{}"); } catch { return {}; }
}
function saveDismissedTips(d: Record<string, boolean>) {
  try { localStorage.setItem(TIPS_DISMISS_KEY, JSON.stringify(d)); } catch {}
}
function saveTasks(tasks: Task[]) {
  try {
    const slim = tasks.map(({ running: _r, ...rest }) => rest);
    localStorage.setItem(TASKS_KEY, JSON.stringify(slim));
  } catch {}
}

// ─────────────── Proxy group persistence ───────────────
function loadProxyGroups(): ProxyGroup[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PROXY_GROUPS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProxyGroup[];
      if (Array.isArray(parsed)) return parsed;
    }
    // Migrate legacy flat list → single "Default" group
    const legacy = localStorage.getItem(PROXIES_KEY) ?? "";
    const list = legacy.split("\n").map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) {
      return [{ id: "default", name: "Default", proxies: list }];
    }
  } catch {}
  return [];
}
function saveProxyGroupsLS(groups: ProxyGroup[]) {
  try { localStorage.setItem(PROXY_GROUPS_KEY, JSON.stringify(groups)); } catch {}
}

// ─────────────── Address + name jigging ───────────────
const STREET_SWAPS: Array<[RegExp, string]> = [
  [/\bStreet\b/gi, "St"],
  [/\bSt\.?\b/gi, "Street"],
  [/\bRoad\b/gi, "Rd"],
  [/\bRd\.?\b/gi, "Road"],
  [/\bAvenue\b/gi, "Ave"],
  [/\bAve\.?\b/gi, "Avenue"],
  [/\bDrive\b/gi, "Dr"],
  [/\bDr\.?\b/gi, "Drive"],
  [/\bLane\b/gi, "Ln"],
  [/\bLn\.?\b/gi, "Lane"],
  [/\bBoulevard\b/gi, "Blvd"],
  [/\bBlvd\.?\b/gi, "Boulevard"],
  [/\bCourt\b/gi, "Ct"],
  [/\bCt\.?\b/gi, "Court"],
  [/\bHighway\b/gi, "Hwy"],
  [/\bHwy\.?\b/gi, "Highway"],
];
// Pick a single street-suffix swap (first match wins) for safety
function jigAddress(addr: string, seed: number): string {
  if (!addr) return addr;
  const variants: string[] = [];
  for (const [re, rep] of STREET_SWAPS) {
    if (re.test(addr)) {
      variants.push(addr.replace(re, rep));
      re.lastIndex = 0;
    }
    re.lastIndex = 0;
  }
  // Punctuation tweaks (also non-breaking for shipping)
  variants.push(addr.includes(",") ? addr.replace(",", "") : addr.replace(/(\s\w+)$/, ",$1"));
  // Extra non-breaking spaces normalisation flip
  variants.push(addr.replace(/\s+/g, "  ").replace(/\s{2,}/g, " "));
  if (variants.length === 0) return addr;
  return variants[seed % variants.length];
}
const MIDDLE_INITIALS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "P", "R", "S", "T"];
function jigName(first: string, last: string, seed: number): { first: string; last: string } {
  const pick = seed % 3;
  if (pick === 0 && first) {
    // Add a middle initial onto first name
    const mi = MIDDLE_INITIALS[seed % MIDDLE_INITIALS.length];
    return { first: `${first} ${mi}`, last };
  }
  if (pick === 1 && first) {
    // Hyphenate first letter casing change ("john" -> "John" already from input; flip one inner letter)
    return { first: first.charAt(0).toUpperCase() + first.slice(1), last: last.toUpperCase().charAt(0) + last.slice(1).toLowerCase() };
  }
  // Insert a middle initial between first and last as separate token
  const mi = MIDDLE_INITIALS[(seed + 7) % MIDDLE_INITIALS.length];
  return { first: `${first} ${mi}.`, last };
}

function Index() {
  // ─── Config state ───
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [customStores, setCustomStores] = useState<StoreEntry[]>([]);
  const [proxyGroups, setProxyGroups] = useState<ProxyGroup[]>([]);
  const [pollMs, setPollMs] = useState(4000);
  const [autoOpen, setAutoOpen] = useState(true);
  const [notifyOn, setNotifyOn] = useState(true);

  // ─── Tasks ───
  const [tasks, setTasks] = useState<Task[]>([]);
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;

  // ─── UI ───
  const [tab, setTab] = useState<"tasks" | "profiles" | "proxies" | "stores" | "settings" | "help">("tasks");
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [dismissedTips, setDismissedTips] = useState<Record<string, boolean>>({});

  const dismissTip = (key: string) => {
    const next = { ...dismissedTips, [key]: true };
    setDismissedTips(next);
    saveDismissedTips(next);
  };
  const resetTips = () => {
    setDismissedTips({});
    saveDismissedTips({});
  };

  // Bootstrap
  useEffect(() => {
    const { profiles, activeIds } = loadProfiles();
    setProfiles(profiles);
    setActiveIds(activeIds);
    setCustomStores(loadCustomStores());
    const pg = loadProxyGroups();
    setProxyGroups(pg);
    setProxyGroupsRuntime(pg);
    setTasks(loadTasks());
    setDismissedTips(loadDismissedTips());
    try {
      if (!localStorage.getItem(WIZARD_KEY)) setWizardOpen(true);
    } catch {}
  }, []);

  const completeWizard = () => {
    try { localStorage.setItem(WIZARD_KEY, "1"); } catch {}
    setWizardOpen(false);
  };

  // Persistence
  useEffect(() => { saveTasks(tasks); }, [tasks]);
  useEffect(() => { saveCustomStores(customStores); }, [customStores]);

  const allStores = useMemo<StoreEntry[]>(() => [...PRESET_STORES, ...customStores], [customStores]);

  // ─── Profile helpers ───
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
  const updateProfile = (id: string, patch: Partial<Profile>) =>
    persistProfiles(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const deleteProfile = (id: string) =>
    persistProfiles(profiles.filter((p) => p.id !== id), activeIds.filter((x) => x !== id));
  const toggleActive = (id: string) => {
    const next = activeIds.includes(id) ? activeIds.filter((x) => x !== id) : [...activeIds, id];
    setActiveIds(next);
    saveProfiles(profiles, next);
  };

  // ─── Proxy helpers ───
  const saveProxies = (text: string) => {
    setProxiesText(text);
    const list = text.split("\n").map((s) => s.trim()).filter(Boolean);
    setProxyList(list);
    try { localStorage.setItem(PROXIES_KEY, text); } catch {}
  };
  const proxyLines = proxiesText.split("\n").map((s) => s.trim()).filter(Boolean);

  // ─── Audio + notify ───
  const beep = () => {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = "square"; o.frequency.value = 880; g.gain.value = 0.15;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(() => { o.frequency.value = 1320; }, 150);
      setTimeout(() => { o.stop(); ctx.close(); }, 450);
    } catch {}
  };
  const notify = (title: string, body: string) => {
    if (!notifyOn) return;
    beep();
    try {
      if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
    } catch {}
  };

  // ─── Task ops ───
  const updateTask = (id: string, patch: Partial<Task>) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const createTasks = (template: Omit<Task, "id" | "status" | "running">, n: number) => {
    const fresh: Task[] = Array.from({ length: Math.max(1, n) }, () => ({
      ...template,
      id: makeId(),
      status: "idle",
      running: false,
    }));
    setTasks((prev) => [...fresh, ...prev]);
  };

  const startTask = async (id: string) => {
    if ("Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch {}
    }
    updateTask(id, { running: true, status: "monitoring", message: "Resolving…", lastChecked: Date.now() });
    // Resolve handle if not yet resolved
    const t = tasksRef.current.find((x) => x.id === id);
    if (!t) return;
    if (!t.productHandle) {
      try {
        const handle = handleFromUrl(t.input);
        let p: Product | null = null;
        if (handle) p = await fetchProductByHandle(t.storeUrl, handle);
        else {
          const results = await searchProducts(t.storeUrl, t.input, 1);
          p = results[0] ?? null;
        }
        if (!p) {
          updateTask(id, { running: false, status: "error", message: "Product not found" });
          return;
        }
        // Detect limit
        const li = await detectLimit(t.storeUrl, p.handle).catch(() => null);
        updateTask(id, {
          productHandle: p.handle,
          productTitle: p.title,
          productImage: p.image ?? undefined,
          limit: li?.maxPerOrder ?? null,
        });
      } catch (e: any) {
        updateTask(id, { running: false, status: "error", message: e?.message ?? "Resolve failed" });
        return;
      }
    }
  };

  const stopTask = (id: string) => updateTask(id, { running: false, status: "idle", message: undefined });
  const startAll = () => tasksRef.current.forEach((t) => !t.running && startTask(t.id));
  const stopAll = () => tasksRef.current.forEach((t) => t.running && stopTask(t.id));
  const deleteTask = (id: string) => setTasks((prev) => prev.filter((t) => t.id !== id));

  // ─── Poll loop ───
  const triggeredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const id = setInterval(async () => {
      const running = tasksRef.current.filter((t) => t.running && t.productHandle);
      if (running.length === 0) return;
      await Promise.all(running.map(async (t) => {
        try {
          const res = await fetch(proxied(`${t.storeUrl}/products/${t.productHandle}.js`));
          if (!res.ok) {
            updateTask(t.id, { lastChecked: Date.now(), message: `HTTP ${res.status}` });
            return;
          }
          const data: any = await res.json();
          const variants: any[] = data.variants ?? [];
          const avail = variants.find((v) => v.available);
          if (avail) {
            updateTask(t.id, { lastChecked: Date.now(), status: "in_stock", variantId: avail.id, message: undefined });
            if (!triggeredRef.current.has(t.id)) {
              triggeredRef.current.add(t.id);
              const profile = profiles.find((p) => p.id === t.profileId);
              notify("IN STOCK", `${t.productTitle ?? t.input}`);
              if (autoOpen && profile) {
                const qty = t.limit && t.limit > 0 ? Math.min(t.qty, t.limit) : t.qty;
                const url = buildCheckoutUrl(t.storeUrl, avail.id, qty, profile);
                window.open(url, `_task_${t.id}`, "noopener,noreferrer");
                updateTask(t.id, { status: "opened" });
              }
            }
          } else {
            updateTask(t.id, { lastChecked: Date.now(), status: "monitoring", message: undefined });
            triggeredRef.current.delete(t.id);
          }
        } catch (e: any) {
          updateTask(t.id, { lastChecked: Date.now(), message: e?.message ?? "fetch failed" });
        }
      }));
    }, Math.max(1500, pollMs));
    return () => clearInterval(id);
  }, [pollMs, autoOpen, notifyOn, profiles]);

  // ─── Add store ───
  const addCustomStore = (name: string, url: string) => {
    const normalized = normalizeStoreUrl(url);
    if (!normalized || !name.trim()) { setError("Store name and URL required."); return; }
    setCustomStores((prev) => [...prev, { id: makeId(), name: name.trim(), url: normalized }]);
  };
  const deleteCustomStore = (id: string) => setCustomStores((prev) => prev.filter((s) => s.id !== id));

  // ─── Counts ───
  const runningCount = tasks.filter((t) => t.running).length;
  const stockCount = tasks.filter((t) => t.status === "in_stock" || t.status === "opened").length;
  const errorCount = tasks.filter((t) => t.status === "error").length;

  const tabLabel = { tasks: "Tasks", profiles: "Profiles", proxies: "Proxies", stores: "Stores", settings: "Settings", help: "Help" }[tab];

  const tipMap: Record<typeof tab, { key: string; text: string } | null> = {
    tasks: { key: "tip-tasks", text: "Each task watches one product. Tap ▶ to start — when stock appears, the prefilled checkout opens automatically." },
    profiles: { key: "tip-profiles", text: "Profiles autofill the Shopify checkout. Add one profile per checkout you want fired in parallel." },
    proxies: { key: "tip-proxies", text: "Optional. Add proxy URL templates (one per line) to rotate requests and avoid rate limits during drops." },
    stores: { key: "tip-stores", text: "Pick a preset or add any public Shopify store by URL — that's the storefront your tasks will watch." },
    settings: { key: "tip-settings", text: "Lower poll interval = faster detection but more requests. 3000–5000ms is a good balance." },
    help: null,
  };
  const currentTip = tipMap[tab];

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <img src={jimsLogo} alt="J1m's Bot" className="h-10 w-10 rounded-lg object-cover ring-2 ring-primary/40" />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-primary">J1m's Bot</div>
              <h1 className="text-base font-semibold leading-tight">{tabLabel}</h1>
            </div>
          </div>
          {tab === "tasks" && (
            <Drawer open={createOpen} onOpenChange={setCreateOpen}>
              <DrawerTrigger asChild>
                <Button size="icon" className="h-9 w-9 rounded-lg">
                  <Plus className="h-5 w-5" />
                </Button>
              </DrawerTrigger>
              <CreateTaskSheet
                stores={allStores}
                profiles={profiles}
                proxyCount={proxyLines.length}
                onCreate={(tpl, n) => { createTasks(tpl, n); setCreateOpen(false); }}
                onAddCustomStore={(name, url) => addCustomStore(name, url)}
              />
            </Drawer>
          )}
        </div>
        {tab === "tasks" && (
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 pb-3">
            <div className="flex gap-2">
              <StatusPill color="green" label="In stock" count={stockCount} />
              <StatusPill color="red" label="Errors" count={errorCount} />
              <StatusPill color="blue" label="Running" count={runningCount} />
            </div>
            <div className="text-sm font-medium text-muted-foreground">{tasks.length} Tasks</div>
          </div>
        )}
        {error && (
          <div className="mx-auto flex max-w-3xl items-start gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)}><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-40 pt-3">
        {currentTip && !dismissedTips[currentTip.key] && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs text-foreground/90">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="flex-1 leading-relaxed">{currentTip.text}</span>
            <button onClick={() => dismissTip(currentTip.key)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss tip">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {tab === "tasks" && (
          <TasksView
            tasks={tasks}
            profiles={profiles}
            onStart={startTask}
            onStop={stopTask}
            onDelete={deleteTask}
            onCreate={() => setCreateOpen(true)}
            onGoProfiles={() => setTab("profiles")}
            hasProfiles={profiles.length > 0}
          />
        )}
        {tab === "profiles" && (
          <ProfilesView
            profiles={profiles}
            activeIds={activeIds}
            onAdd={addProfile}
            onUpdate={updateProfile}
            onDelete={deleteProfile}
            onToggle={toggleActive}
          />
        )}
        {tab === "proxies" && (
          <ProxiesView text={proxiesText} onChange={saveProxies} count={proxyLines.length} />
        )}
        {tab === "stores" && (
          <StoresView
            presets={PRESET_STORES}
            custom={customStores}
            onAdd={addCustomStore}
            onDelete={deleteCustomStore}
          />
        )}
        {tab === "settings" && (
          <SettingsView
            pollMs={pollMs} setPollMs={setPollMs}
            autoOpen={autoOpen} setAutoOpen={setAutoOpen}
            notifyOn={notifyOn} setNotifyOn={setNotifyOn}
            onShowWizard={() => setWizardOpen(true)}
            onResetTips={resetTips}
          />
        )}
        {tab === "help" && <HelpView />}
      </main>

      {tab === "tasks" && tasks.length > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 border-t bg-background/95 px-4 py-2 backdrop-blur">
          <div className="mx-auto grid max-w-3xl grid-cols-3 gap-2">
            <Button variant="secondary" size="sm" className="h-10" onClick={() => setTab("settings")}>
              <Settings className="h-4 w-4" /> Manage
            </Button>
            <Button variant="destructive" size="sm" className="h-10" onClick={stopAll} disabled={runningCount === 0}>
              <Square className="h-4 w-4" /> Stop All
            </Button>
            <Button size="sm" className="h-10" onClick={startAll} disabled={tasks.every((t) => t.running)}>
              <Play className="h-4 w-4" /> Start All
            </Button>
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto grid max-w-3xl grid-cols-6">
          {([
            ["tasks", "Tasks", ListChecks, tasks.length],
            ["profiles", "Profiles", Users, profiles.length],
            ["stores", "Stores", Store, allStores.length],
            ["proxies", "Proxies", Server, proxyLines.length],
            ["settings", "Settings", Settings, 0],
            ["help", "Help", HelpCircle, 0],
          ] as const).map(([key, label, Icon, count]) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] transition-colors ${active ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                <div className="relative">
                  <Icon className="h-5 w-5" />
                  {count > 0 && (
                    <span className={`absolute -right-2 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-semibold ${active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}>
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

      <WelcomeWizard
        open={wizardOpen}
        onClose={completeWizard}
        hasProfiles={profiles.length > 0}
        onGoProfiles={() => { completeWizard(); setTab("profiles"); }}
        onGoStores={() => { completeWizard(); setTab("stores"); }}
        onCreateTask={() => { completeWizard(); setTab("tasks"); setCreateOpen(true); }}
      />
    </div>
  );
}

// ────────────────────────────────────────────
// Status pill
// ────────────────────────────────────────────
function StatusPill({ color, label, count }: { color: "green" | "red" | "blue"; label: string; count: number }) {
  const cls =
    color === "green" ? "bg-primary/15 text-primary border-primary/30"
    : color === "red" ? "bg-destructive/15 text-destructive border-destructive/30"
    : "bg-sky-500/15 text-sky-400 border-sky-500/30";
  return (
    <div className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${cls}`} title={label}>
      <span className="h-2 w-2 rounded-full bg-current opacity-80" />
      <span>{count}</span>
    </div>
  );
}

// ────────────────────────────────────────────
// Tasks view
// ────────────────────────────────────────────
function TasksView({
  tasks, profiles, onStart, onStop, onDelete, onCreate, onGoProfiles, hasProfiles,
}: {
  tasks: Task[]; profiles: Profile[];
  onStart: (id: string) => void; onStop: (id: string) => void; onDelete: (id: string) => void;
  onCreate: () => void; onGoProfiles: () => void; hasProfiles: boolean;
}) {
  if (tasks.length === 0) {
    return (
      <div className="mt-6 rounded-xl border border-dashed p-8 text-center text-sm">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-primary/15 text-primary">
          <ListChecks className="h-6 w-6" />
        </div>
        <p className="text-base font-semibold text-foreground">No tasks yet</p>
        <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
          A task watches one product and fires a prefilled checkout the moment stock appears.
        </p>
        {hasProfiles ? (
          <Button className="mt-4 h-10" onClick={onCreate}>
            <Plus className="h-4 w-4" /> Create your first task
          </Button>
        ) : (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-muted-foreground">Add a profile first so checkout can be autofilled.</p>
            <Button className="h-10" onClick={onGoProfiles}>
              <Users className="h-4 w-4" /> Add a profile
            </Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {tasks.map((t) => {
        const profile = profiles.find((p) => p.id === t.profileId);
        const statusInfo = (() => {
          switch (t.status) {
            case "in_stock": return { label: "IN STOCK", color: "text-green-400" };
            case "opened":   return { label: "Checkout opened", color: "text-primary" };
            case "monitoring": return { label: t.message ?? "Monitoring", color: "text-sky-400" };
            case "error":    return { label: t.message ?? "Error", color: "text-destructive" };
            default:         return { label: "Idle", color: "text-muted-foreground" };
          }
        })();
        return (
          <Card key={t.id} className="p-3">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm font-semibold">
                  {t.productTitle ?? t.input}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Qty {t.qty}{t.limit ? ` · limit ${t.limit}` : ""}
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <div className={`flex items-center gap-1.5 text-xs font-medium ${statusInfo.color}`}>
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    {statusInfo.label}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {t.storeName} · <span className="text-foreground/80">{profile?.name ?? "no profile"}</span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                {t.running ? (
                  <Button size="icon" variant="destructive" className="h-10 w-10 rounded-lg" onClick={() => onStop(t.id)}>
                    <Square className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button size="icon" className="h-10 w-10 rounded-lg" onClick={() => onStart(t.id)}>
                    <Play className="h-4 w-4" />
                  </Button>
                )}
                <button className="text-[10px] text-muted-foreground hover:text-destructive" onClick={() => onDelete(t.id)}>
                  delete
                </button>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────
// Create Task bottom sheet
// ────────────────────────────────────────────
function CreateTaskSheet({
  stores, profiles, proxyCount, onCreate, onAddCustomStore,
}: {
  stores: StoreEntry[]; profiles: Profile[]; proxyCount: number;
  onCreate: (tpl: Omit<Task, "id" | "status" | "running">, n: number) => void;
  onAddCustomStore: (name: string, url: string) => void;
}) {
  const [storeId, setStoreId] = useState<string>(stores[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [profileId, setProfileId] = useState<string>(profiles[0]?.id ?? "");
  const [proxyIdx, setProxyIdx] = useState<string>("-1"); // -1 = rotate
  const [qty, setQty] = useState(1);
  const [taskQty, setTaskQty] = useState(1);
  const [addingStore, setAddingStore] = useState(false);
  const [newStoreName, setNewStoreName] = useState("");
  const [newStoreUrl, setNewStoreUrl] = useState("");

  // Re-sync when stores/profiles change
  useEffect(() => { if (!stores.find((s) => s.id === storeId) && stores[0]) setStoreId(stores[0].id); }, [stores, storeId]);
  useEffect(() => { if (!profiles.find((p) => p.id === profileId) && profiles[0]) setProfileId(profiles[0].id); }, [profiles, profileId]);

  const store = stores.find((s) => s.id === storeId);
  const profile = profiles.find((p) => p.id === profileId);
  const canCreate = store && profile && input.trim().length > 0;

  const submit = () => {
    if (!canCreate) return;
    onCreate({
      storeId: store!.id,
      storeUrl: store!.url,
      storeName: store!.name,
      input: input.trim(),
      profileId: profile!.id,
      proxyIdx: parseInt(proxyIdx, 10) as -1 | number,
      qty: Math.max(1, qty),
    }, Math.max(1, taskQty));
    setInput("");
  };

  const [step, setStep] = useState<1 | 2 | 3>(1);

  const stepValid: Record<1 | 2 | 3, boolean> = {
    1: input.trim().length > 0,
    2: !!store,
    3: !!profile,
  };
  const stepMeta = [
    { n: 1, label: "What", icon: Package, hint: "The product to watch" },
    { n: 2, label: "Where", icon: Store, hint: "Which store to watch" },
    { n: 3, label: "Who", icon: UserIcon, hint: "Checkout profile + quantity" },
  ] as const;

  return (
    <DrawerContent className="max-h-[92vh]">
      <DrawerHeader className="flex flex-row items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-primary/15 text-primary"><Plus className="h-4 w-4" /></div>
          <div>
            <DrawerTitle className="text-base">New task · Step {step} of 3</DrawerTitle>
            <p className="text-[11px] text-muted-foreground">{stepMeta[step - 1].hint}</p>
          </div>
        </div>
        <DrawerClose asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8"><X className="h-4 w-4" /></Button>
        </DrawerClose>
      </DrawerHeader>

      {/* Progress dots */}
      <div className="flex items-center justify-center gap-2 px-4 pb-3">
        {stepMeta.map((s) => {
          const done = step > s.n;
          const active = step === s.n;
          return (
            <div key={s.n} className="flex items-center gap-2">
              <button
                onClick={() => setStep(s.n)}
                className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-colors ${
                  active ? "bg-primary text-primary-foreground"
                  : done ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground"
                }`}
              >
                {done ? <Check className="h-3 w-3" /> : <s.icon className="h-3 w-3" />}
                {s.label}
              </button>
              {s.n < 3 && <div className={`h-px w-4 ${step > s.n ? "bg-primary/40" : "bg-border"}`} />}
            </div>
          );
        })}
      </div>

      <div className="space-y-4 overflow-y-auto px-4 pb-4">
        {step === 1 && (
          <div className="space-y-3">
            <div>
              <div className="flex items-center gap-1.5">
                <Label className="text-sm font-medium">What product do you want to watch?</Label>
                <InfoDot text="Paste a product URL for an exact match, a product handle/SKU, or describe it in keywords — the bot will pick the closest match on the store." />
              </div>
              <Input
                className="mt-2 h-11 text-base"
                placeholder="Paste URL, SKU, or keywords"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                autoFocus
              />
              <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                <div>· <b className="text-foreground/80">URL</b> — https://store.com/products/some-handle</div>
                <div>· <b className="text-foreground/80">SKU/handle</b> — air-jordan-1-low</div>
                <div>· <b className="text-foreground/80">Keywords</b> — "Air Jordan 1 Low"</div>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <Label className="text-sm font-medium">Which store sells it?</Label>
              <InfoDot text="Pick a preset Shopify store or add a custom one by URL. Tasks only watch the store you select here." />
            </div>
            {addingStore ? (
              <div className="space-y-1.5">
                <Input className="h-10" placeholder="Display name (e.g. My Store)" value={newStoreName} onChange={(e) => setNewStoreName(e.target.value)} />
                <Input className="h-10" placeholder="https://store.com" value={newStoreUrl} onChange={(e) => setNewStoreUrl(e.target.value)} autoCapitalize="none" autoCorrect="off" />
                <div className="flex gap-1.5">
                  <Button size="sm" className="h-9 flex-1" onClick={() => { onAddCustomStore(newStoreName, newStoreUrl); setNewStoreName(""); setNewStoreUrl(""); setAddingStore(false); }}>Add store</Button>
                  <Button size="sm" variant="ghost" className="h-9" onClick={() => setAddingStore(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <>
                <Select value={storeId} onValueChange={(v) => v === "__add" ? setAddingStore(true) : setStoreId(v)}>
                  <SelectTrigger className="h-11 text-base"><SelectValue placeholder="Select a store" /></SelectTrigger>
                  <SelectContent>
                    {stores.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}{s.preset ? "" : " (custom)"}</SelectItem>
                    ))}
                    <SelectItem value="__add">＋ Add custom store…</SelectItem>
                  </SelectContent>
                </Select>
                {store && <p className="text-[11px] text-muted-foreground">{store.url}</p>}
              </>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <div className="flex items-center gap-1.5">
                <Label className="text-sm font-medium">Which profile checks out?</Label>
                <InfoDot text="The profile's shipping + contact info is pre-filled into Shopify's checkout when stock appears." />
              </div>
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger className="mt-2 h-11 text-base"><SelectValue placeholder="Select a profile" /></SelectTrigger>
                <SelectContent>
                  {profiles.length === 0 ? (
                    <SelectItem value="__none" disabled>No profiles — add one in the Profiles tab</SelectItem>
                  ) : profiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">Quantity per checkout</Label>
                  <InfoDot text="How many units to add to cart. If a per-customer limit is detected, this is capped automatically." />
                </div>
                <Input className="mt-1 h-10" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">Number of tasks</Label>
                  <InfoDot text="Creates this many identical tasks. Useful when you want several attempts running in parallel." />
                </div>
                <Input className="mt-1 h-10" type="number" min={1} max={100} value={taskQty} onChange={(e) => setTaskQty(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
              </div>
            </div>

            <div>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Proxy</Label>
                <InfoDot text="Which proxy to route requests through. 'Rotate' cycles through all proxies you've added in the Proxies tab." />
              </div>
              <Select value={proxyIdx} onValueChange={setProxyIdx}>
                <SelectTrigger className="mt-1 h-10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="-1">Rotate{proxyCount > 0 ? ` (${proxyCount} configured)` : " — none configured (direct)"}</SelectItem>
                  {Array.from({ length: proxyCount }, (_, i) => (
                    <SelectItem key={i} value={String(i)}>Proxy {i + 1}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Summary */}
            <div className="rounded-lg border bg-muted/30 p-3 text-xs">
              <div className="mb-1 font-medium text-foreground">Summary</div>
              <div className="text-muted-foreground">
                Watch <span className="text-foreground">{input || "—"}</span> on <span className="text-foreground">{store?.name ?? "—"}</span>,
                checkout as <span className="text-foreground">{profile?.name ?? "—"}</span>,
                qty <span className="text-foreground">{qty}</span>{taskQty > 1 ? <> × <span className="text-foreground">{taskQty} tasks</span></> : null}.
              </div>
            </div>
          </div>
        )}
      </div>

      <DrawerFooter className="flex-row gap-2">
        {step > 1 ? (
          <Button variant="secondary" size="lg" className="h-12 flex-1" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}>
            <ChevronLeft className="h-4 w-4" /> Back
          </Button>
        ) : (
          <DrawerClose asChild>
            <Button variant="secondary" size="lg" className="h-12 flex-1">Cancel</Button>
          </DrawerClose>
        )}
        {step < 3 ? (
          <Button size="lg" className="h-12 flex-1 text-base font-semibold" disabled={!stepValid[step]} onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}>
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button size="lg" className="h-12 flex-1 text-base font-semibold" disabled={!canCreate} onClick={submit}>
            Create {taskQty > 1 ? `${taskQty} tasks` : "task"}
          </Button>
        )}
      </DrawerFooter>
    </DrawerContent>
  );
}

// ────────────────────────────────────────────
// Profiles view
// ────────────────────────────────────────────
function ProfilesView({
  profiles, activeIds, onAdd, onUpdate, onDelete, onToggle,
}: {
  profiles: Profile[]; activeIds: string[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<Profile>) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{activeIds.length}/{profiles.length} active</div>
        <Button size="sm" onClick={onAdd}><Plus className="h-3.5 w-3.5" /> Add</Button>
      </div>
      {profiles.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
          No profiles. Each profile holds shipping + contact info for prefilled checkout.
        </div>
      )}
      {profiles.map((p) => {
        const isActive = activeIds.includes(p.id);
        return (
          <Card key={p.id} className={`p-3 ${isActive ? "" : "opacity-60"}`}>
            <div className="mb-2 flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={isActive} onChange={() => onToggle(p.id)} />
              <Input value={p.name} onChange={(e) => onUpdate(p.id, { name: e.target.value })} className="h-8 flex-1 font-medium" placeholder="Profile name" />
              <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => onDelete(p.id)}><Trash2 className="h-4 w-4" /></Button>
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
                  <Input value={p[k]} onChange={(e) => onUpdate(p.id, { [k]: e.target.value } as Partial<Profile>)} className="h-8 text-sm" />
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────
// Proxies view
// ────────────────────────────────────────────
function ProxiesView({ text, onChange, count }: { text: string; onChange: (v: string) => void; count: number }) {
  return (
    <div className="space-y-3">
      <Card className="p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Proxy rotation</div>
            <div className="text-[11px] text-muted-foreground">Round-robin across listed proxies</div>
          </div>
          <Badge variant={count > 0 ? "default" : "outline"}>{count > 0 ? `${count} active` : "Direct"}</Badge>
        </div>
        <Textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className="mt-3 min-h-[180px] font-mono text-[11px]"
          placeholder={"One proxy URL template per line, must contain {url}\nhttps://proxy1.example.com/fetch?url={url}\nhttps://proxy2.example.com/get?target={url}"}
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          Use <code className="font-mono">{`{url}`}</code> as a placeholder for the encoded target URL. Leave empty to fetch through the built-in server proxy.
        </p>
      </Card>
    </div>
  );
}

// ────────────────────────────────────────────
// Stores view
// ────────────────────────────────────────────
function StoresView({
  presets, custom, onAdd, onDelete,
}: { presets: StoreEntry[]; custom: StoreEntry[]; onAdd: (name: string, url: string) => void; onDelete: (id: string) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  return (
    <div className="space-y-4">
      <Card className="p-3">
        <div className="mb-2 text-sm font-medium">Add custom store</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input className="h-9 sm:w-1/3" placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input className="h-9 flex-1" placeholder="https://store.com" value={url} onChange={(e) => setUrl(e.target.value)} autoCapitalize="none" autoCorrect="off" />
          <Button size="sm" className="h-9" onClick={() => { onAdd(name, url); setName(""); setUrl(""); }}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      </Card>

      {custom.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Custom</div>
          <div className="space-y-1.5">
            {custom.map((s) => (
              <Card key={s.id} className="flex items-center gap-2 p-3">
                <Store className="h-4 w-4 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{s.url}</div>
                </div>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => onDelete(s.id)}><Trash2 className="h-4 w-4" /></Button>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Presets</div>
        <div className="space-y-1.5">
          {presets.map((s) => (
            <Card key={s.id} className="flex items-center gap-2 p-3">
              <Store className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{s.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{s.url}</div>
              </div>
              <Badge variant="outline" className="text-[10px]">preset</Badge>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Settings view
// ────────────────────────────────────────────
function SettingsView({
  pollMs, setPollMs, autoOpen, setAutoOpen, notifyOn, setNotifyOn, onShowWizard, onResetTips,
}: {
  pollMs: number; setPollMs: (n: number) => void;
  autoOpen: boolean; setAutoOpen: (v: boolean) => void;
  notifyOn: boolean; setNotifyOn: (v: boolean) => void;
  onShowWizard: () => void; onResetTips: () => void;
}) {
  return (
    <div className="space-y-3">
      <Card className="p-3">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          Monitor <InfoDot text="How often each running task checks its product. Lower = faster detection but more requests, which can trigger rate limits." />
        </div>
        <div className="mt-2">
          <Label className="text-[11px] text-muted-foreground">Poll interval (ms, min 1500)</Label>
          <Input className="mt-1 h-9" type="number" min={1500} step={500} value={pollMs} onChange={(e) => setPollMs(Math.max(1500, Number(e.target.value) || 4000))} />
          <p className="mt-1 text-[10px] text-muted-foreground">3000–5000ms is a safe balance for most stores.</p>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} />
          Auto-open checkout tab on drop
          <InfoDot text="When stock appears, a new tab opens to Shopify's checkout with your profile pre-filled. Allow popups for this site." />
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={notifyOn} onChange={(e) => setNotifyOn(e.target.checked)} />
          Sound + browser notification
          <InfoDot text="Plays a beep and (if permitted) shows a browser notification when a task detects stock." />
        </label>
        <p className="mt-2 text-[11px] text-muted-foreground">Keep this tab pinned — browsers throttle background tabs.</p>
      </Card>

      <Card className="p-3">
        <div className="text-sm font-medium">Onboarding & tips</div>
        <p className="mt-1 text-[11px] text-muted-foreground">Replay the welcome tour or bring back dismissed tip bars.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" className="h-9" onClick={onShowWizard}>
            <Sparkles className="h-4 w-4" /> Show welcome tour
          </Button>
          <Button size="sm" variant="ghost" className="h-9" onClick={onResetTips}>
            <Info className="h-4 w-4" /> Restore tips
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ────────────────────────────────────────────
// InfoDot — tap to reveal a short explanation
// ────────────────────────────────────────────
function InfoDot({ text }: { text: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
          aria-label="More info"
          onClick={(e) => e.stopPropagation()}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64 text-xs leading-relaxed">
        {text}
      </PopoverContent>
    </Popover>
  );
}

// ────────────────────────────────────────────
// Welcome wizard — shown once
// ────────────────────────────────────────────
function WelcomeWizard({
  open, onClose, hasProfiles, onGoProfiles, onGoStores: _onGoStores, onCreateTask,
}: {
  open: boolean; onClose: () => void;
  hasProfiles: boolean;
  onGoProfiles: () => void; onGoStores: () => void; onCreateTask: () => void;
}) {
  const [step, setStep] = useState(0);
  const slides = [
    {
      icon: Sparkles,
      title: "Welcome to J1m's Bot",
      body: "A pocket-sized shopping bot. Tell it what you want, which store, and which profile — when stock drops it fires the checkout for you.",
      cta: { label: "Next", action: () => setStep(1) },
    },
    {
      icon: UserIcon,
      title: "Step 1 — Add a profile",
      body: "A profile is the shipping + contact info that pre-fills Shopify checkout. Add one profile per checkout you want to fire in parallel.",
      cta: { label: hasProfiles ? "Next" : "Add a profile", action: hasProfiles ? () => setStep(2) : onGoProfiles },
    },
    {
      icon: Store,
      title: "Step 2 — Pick a store",
      body: "Choose from preset Shopify stores (JB Hi-Fi, Kith, Gymshark…) or add any public Shopify store by URL. You can manage stores anytime from the Stores tab.",
      cta: { label: "Next", action: () => setStep(3) },
    },
    {
      icon: ListChecks,
      title: "Step 3 — Create your first task",
      body: "A task watches one product. Paste a URL, SKU, or keywords; pick a store and a profile; tap Start. When stock appears, the checkout opens automatically.",
      cta: { label: "Create a task", action: onCreateTask },
    },
  ];
  const s = slides[step];
  const Icon = s.icon;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="mx-auto mb-2 grid h-12 w-12 place-items-center rounded-full bg-primary/15 text-primary">
            <Icon className="h-6 w-6" />
          </div>
          <DialogTitle className="text-center text-lg">{s.title}</DialogTitle>
          <DialogDescription className="text-center text-sm leading-relaxed">
            {s.body}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center gap-1.5 py-1">
          {slides.map((_, i) => (
            <div key={i} className={`h-1.5 w-6 rounded-full transition-colors ${i === step ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>

        <DialogFooter className="flex-row gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={onClose}>Skip</Button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setStep((p) => p - 1)}>
                <ChevronLeft className="h-4 w-4" /> Back
              </Button>
            )}
            <Button size="sm" onClick={s.cta.action}>
              {s.cta.label} <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────
// Help view — glossary, how-it-works, FAQ
// ────────────────────────────────────────────
function HelpView() {
  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">How J1m's Bot works</h2>
        </div>
        <ol className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
          <li><b className="text-foreground">1. Profile</b> — your shipping + contact info, used to pre-fill Shopify checkout.</li>
          <li><b className="text-foreground">2. Store</b> — the Shopify storefront you want to watch.</li>
          <li><b className="text-foreground">3. Task</b> — links a product on that store to a profile.</li>
          <li><b className="text-foreground">4. Monitor</b> — the bot polls the product on a fast interval.</li>
          <li><b className="text-foreground">5. Drop</b> — the moment stock appears, the checkout opens, prefilled and ready to pay.</li>
        </ol>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Glossary</h2>
        <dl className="mt-3 space-y-2.5 text-xs">
          {[
            ["Task", "One product being watched with one profile."],
            ["Profile", "Saved shipping + contact info used to fill checkout."],
            ["SKU / handle", "Shopify's product identifier — usually visible in the URL after /products/."],
            ["Proxy", "An intermediate server requests are routed through. Helps avoid rate limits during drops."],
            ["Poll interval", "How often the bot rechecks the product (ms). Lower = faster but more requests."],
            ["Per-customer limit", "Shopify's max-per-order rule. The bot detects and caps quantity automatically."],
            ["In stock", "At least one variant became available. The bot fires the checkout."],
          ].map(([term, def]) => (
            <div key={term}>
              <dt className="font-medium text-foreground">{term}</dt>
              <dd className="text-muted-foreground">{def}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">FAQ</h2>
        <div className="mt-3 space-y-3 text-xs">
          {[
            ["Why didn't the checkout tab open?", "Allow popups for this site in your browser settings — the bot can only auto-open with permission."],
            ["Why was a task slower than expected?", "Browsers throttle background tabs. Keep J1m's Bot pinned and visible during a drop."],
            ["What stores work?", "Any public Shopify store. The bot reads each store's /products.json and /products/{handle}.js endpoints."],
            ["Do I need proxies?", "No — they're optional. They help when a store rate-limits during high traffic drops."],
            ["Is anything sent off-device?", "Profile data is stored locally in your browser. Product requests go directly to the store (or through your proxies)."],
          ].map(([q, a]) => (
            <div key={q}>
              <div className="font-medium text-foreground">{q}</div>
              <div className="mt-0.5 text-muted-foreground">{a}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
