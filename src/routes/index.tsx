import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Loader2, ShoppingBag, AlertCircle, CheckCircle2, Zap, Settings, Eye, EyeOff, Bell } from "lucide-react";

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

function proxied(targetUrl: string): string {
  return `/api/public/shopify?url=${encodeURIComponent(targetUrl)}`;
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

const PREFILL_KEY = "shopify-limit-checker:prefill";
const emptyPrefill: Prefill = {
  email: "", first_name: "", last_name: "", address1: "",
  city: "", province: "", zip: "", country: "Australia", phone: "",
};

function loadPrefill(): Prefill {
  if (typeof window === "undefined") return emptyPrefill;
  try {
    const raw = localStorage.getItem(PREFILL_KEY);
    return raw ? { ...emptyPrefill, ...JSON.parse(raw) } : emptyPrefill;
  } catch { return emptyPrefill; }
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
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [storeUrl, setStoreUrl] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [limits, setLimits] = useState<Record<number, LimitInfo>>({});
  const [query, setQuery] = useState("");
  const [prefill, setPrefill] = useState<Prefill>(emptyPrefill);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => { setPrefill(loadPrefill()); }, []);

  const updatePrefill = (patch: Partial<Prefill>) => {
    setPrefill((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(PREFILL_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const quickCheckout = (p: Product) => {
    if (!storeUrl) return;
    const variant = p.variants.find((v) => v.available) ?? p.variants[0];
    if (!variant) return;
    const info = limits[p.id];
    const qty = info?.maxPerOrder && info.maxPerOrder > 0 ? info.maxPerOrder : 1;
    const url = buildCheckoutUrl(storeUrl, variant.id, qty, prefill);
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setProducts([]);
    setLimits({});
    setProgress(0);
    const normalized = normalizeStoreUrl(url);
    if (!normalized) {
      setError("Please enter a valid store URL.");
      return;
    }
    setStoreUrl(normalized);
    setLoading(true);
    try {
      const result = await fetchProducts(normalized, (n) => setProgress(n));
      setProducts(result.products);
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <ShoppingBag className="h-6 w-6" />
              <h1 className="text-2xl font-semibold tracking-tight">Shopify Limit Checker</h1>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowSettings((s) => !s)}>
              <Settings className="h-4 w-4" />
              Checkout info
            </Button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter any public Shopify store URL to inspect products and detect per-customer purchase quantity limits.
          </p>
          {showSettings && (
            <Card className="mt-4 p-4">
              <div className="mb-2 text-sm font-medium">Pre-fill checkout info (saved locally)</div>
              <p className="mb-3 text-xs text-muted-foreground">
                Used to populate Shopify's checkout when you click Quick checkout. Nothing is sent anywhere until you submit on the store.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {([
                  ["email", "Email"],
                  ["phone", "Phone"],
                  ["first_name", "First name"],
                  ["last_name", "Last name"],
                  ["address1", "Address"],
                  ["city", "City"],
                  ["province", "State / Province"],
                  ["zip", "Postcode"],
                  ["country", "Country"],
                ] as const).map(([k, label]) => (
                  <div key={k}>
                    <Label className="text-xs">{label}</Label>
                    <Input
                      value={prefill[k]}
                      onChange={(e) => updatePrefill({ [k]: e.target.value } as Partial<Prefill>)}
                      className="h-8"
                    />
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        <form onSubmit={handleScan} className="flex flex-col gap-3 sm:flex-row">
          <Input
            type="text"
            placeholder="e.g. https://store.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="flex-1"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
          />
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {loading ? "Scanning..." : "Scan store"}
          </Button>
        </form>

        {loading && (
          <div className="mt-4 text-sm text-muted-foreground">
            Loading products... <span className="font-medium text-foreground">{progress}</span> fetched so far
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {products.length > 0 && (
          <section className="mt-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-muted-foreground">
                Found <span className="font-medium text-foreground">{products.length}</span> products on{" "}
                <span className="font-medium text-foreground">{storeUrl}</span>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder="Filter products..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="sm:w-56"
                />
                <Button variant="secondary" onClick={checkAll}>
                  Check all limits
                </Button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3">
              {filtered.map((p) => {
                const info = limits[p.id];
                return (
                  <Card key={p.id} className="flex gap-3 p-3">
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
                      {p.image ? (
                        <img
                          src={p.image}
                          alt={p.title}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : null}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-start justify-between gap-2">
                        <a
                          href={`${storeUrl}/products/${p.handle}`}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate font-medium hover:underline"
                        >
                          {p.title}
                        </a>
                        <div className="flex shrink-0 gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => checkLimit(p)}
                            disabled={info?.status === "loading"}
                          >
                            {info?.status === "loading" ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              "Check limit"
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="default"
                            onClick={() => quickCheckout(p)}
                            title={
                              info?.maxPerOrder
                                ? `Add ${info.maxPerOrder} to cart and open checkout`
                                : "Add 1 to cart and open checkout"
                            }
                          >
                            <Zap className="h-3.5 w-3.5" />
                            Quick checkout{info?.maxPerOrder ? ` (${info.maxPerOrder})` : ""}
                          </Button>
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {p.variants.length} variant{p.variants.length === 1 ? "" : "s"}
                      </div>
                      <div className="mt-2">
                        {info?.status === "done" && (
                          info.maxPerOrder != null ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="default" className="gap-1">
                                <CheckCircle2 className="h-3 w-3" />
                                Limit: {info.maxPerOrder} per customer/order
                              </Badge>
                              {info.textHints?.map((h, i) => (
                                <span key={i} className="text-xs text-muted-foreground italic">
                                  "{h}"
                                </span>
                              ))}
                            </div>
                          ) : (
                            <Badge variant="secondary">No per-person limit detected</Badge>
                          )
                        )}
                        {info?.status === "error" && (
                          <span className="text-xs text-destructive">{info.error}</span>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </section>
        )}

        {products.length === 0 && !loading && !error && (
          <div className="mt-10 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <p>Tip: try a public store like <code className="font-mono">allbirds.com</code> or <code className="font-mono">gymshark.com</code>.</p>
            <p className="mt-2">
              Per-customer limits are detected by scanning each product page for Shopify's quantity rules and merchant-written notes
              (e.g. "Limit 2 per customer").
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
