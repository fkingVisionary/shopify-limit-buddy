import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShoppingBag, AlertCircle, CheckCircle2 } from "lucide-react";

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

async function fetchProducts(
  storeUrl: string,
  onProgress?: (count: number) => void,
): Promise<Product[]> {
  const all: Product[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await fetch(proxied(`${storeUrl}/products.json?limit=250&page=${page}`));
    if (!res.ok) throw new Error(`Store returned ${res.status}. Is this a public Shopify store?`);
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
  }
  return all;
}

async function detectLimit(storeUrl: string, handle: string): Promise<LimitInfo> {
  const res = await fetch(proxied(`${storeUrl}/products/${handle}`));
  if (!res.ok) return { status: "error", error: `Could not load product page (${res.status})` };
  const html = await res.text();

  const hints: string[] = [];
  // Look for "Limit N per customer" / "N per order" wording
  const patterns: RegExp[] = [
    /limit(?:ed)?\s+(?:to\s+)?(\d+)\s+per\s+(customer|order|person)/gi,
    /max(?:imum)?\s+(\d+)\s+per\s+(customer|order|person)/gi,
    /(\d+)\s+per\s+(customer|order|person)\s+limit/gi,
    /only\s+(\d+)\s+per\s+(customer|order|person)/gi,
  ];
  let maxFromText: number | null = null;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n)) {
        maxFromText = maxFromText === null ? n : Math.min(maxFromText, n);
        hints.push(m[0].trim());
      }
    }
  }

  // Look for quantity input max attribute
  let maxFromInput: number | null = null;
  const inputRe = /<input[^>]*name=["']quantity["'][^>]*>/gi;
  let im;
  while ((im = inputRe.exec(html)) !== null) {
    const tag = im[0];
    const mAttr = /\bmax=["']?(\d+)["']?/i.exec(tag);
    if (mAttr) {
      const n = parseInt(mAttr[1], 10);
      if (!isNaN(n) && n > 0 && n < 10000) {
        maxFromInput = maxFromInput === null ? n : Math.min(maxFromInput, n);
      }
    }
  }

  const max =
    maxFromText !== null && maxFromInput !== null
      ? Math.min(maxFromText, maxFromInput)
      : maxFromText ?? maxFromInput;

  return { status: "done", maxPerOrder: max, textHints: Array.from(new Set(hints)).slice(0, 3) };
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
      const list = await fetchProducts(normalized, (n) => setProgress(n));
      setProducts(list);
      if (list.length === 0) setError("No products found. The store may be private or empty.");
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
          <div className="flex items-center gap-3">
            <ShoppingBag className="h-6 w-6" />
            <h1 className="text-2xl font-semibold tracking-tight">Shopify Limit Checker</h1>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter any public Shopify store URL to inspect products and detect per-customer purchase quantity limits.
          </p>
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
