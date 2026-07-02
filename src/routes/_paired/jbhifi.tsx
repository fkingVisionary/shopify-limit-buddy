import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Search, RefreshCw, ExternalLink, ArrowLeft, Copy } from "lucide-react";
import { runJbhifiRecon } from "@/lib/jbhifi-recon.functions";
import { runJbhifiProbe } from "@/lib/jbhifi-probe.functions";

export const Route = createFileRoute("/_paired/jbhifi")({
  head: () => ({
    meta: [
      { title: "JB Hi-Fi Recon — J1m's Bot" },
      { name: "description", content: "Discover hidden JB Hi-Fi Shopify products before they hit the storefront." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: JbhifiReconPage,
});

type Variant = {
  id: number;
  sku: string | null;
  title: string;
  price: string | null;
  available: boolean | null;
  inventoryQty: number | null;
};

type Product = {
  id: number | null;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  publishedAt: string | null;
  updatedAt: string | null;
  image: string | null;
  priceMin: number | null;
  priceMax: number | null;
  variantCount: number;
  inventoryTotal: number;
  variants: Variant[];
  url: string;
  hidden?: boolean;
  source?: string;
};

type ReconResult = {
  ok: boolean;
  elapsedMs: number;
  cached: boolean;
  stats: {
    sitemapCount: number;
    productsJsonCount: number;
    hiddenCount: number;
    candidatesConsidered: number;
    hydratedThisCall: number;
    returned: number;
    sweptAt: number;
    endpointHits: Record<string, { ok: boolean; note: string; at: number }>;
  };
  products: Product[];
};

function fmtPrice(min: number | null, max: number | null) {
  if (min == null) return "—";
  if (max == null || max === min) return `$${min.toFixed(2)}`;
  return `$${min.toFixed(2)}–$${max.toFixed(2)}`;
}

type ProbeEndpoint = {
  key: string;
  url: string;
  status: number;
  ok: boolean;
  elapsedMs: number;
  bytes: number;
  handles: string[];
  snippet: string | null;
  error: string | null;
};

type ProbeMatch = {
  sku: string;
  product: (Product & { matchedVariant?: Variant }) | null;
  alternates: Product[];
};

type AlgoliaSummary = {
  objectID: string | null;
  sku: string | null;
  variantId: number | null;
  productId: number | null;
  title: string | null;
  handle: string | null;
  vendor: string | null;
  productType: string | null;
  price: number | string | null;
  published: boolean | null;
  button: string | null;
  tags: string[] | string | null;
  releaseDate: string | null;
  image: string | null;
  inventoryManagement: string | null;
  availabilityRank: number | null;
  isHidden: boolean;
} | null;

type ProbeResult = {
  ok: boolean;
  elapsedMs: number;
  budgetExceeded?: boolean;
  stats: {
    skus: number;
    uniqueHandlesFound: number;
    confirmed: number;
    algoliaHits: number;
    hiddenFound: number;
  };
  algolia?: {
    appId: string | null;
    apiKey: string | null;
    indexName: string | null;
    source: string;
    discovered: boolean;
    sources: { url: string; status: number; bytes: number }[];
    discoveryError?: string | null;
  };
  matches: (ProbeMatch & { algolia: AlgoliaSummary })[];
  bySku: { sku: string; endpoints: ProbeEndpoint[]; handlesFound: string[]; algoliaSummary: AlgoliaSummary }[];
};

function JbhifiReconPage() {
  const runFn = useServerFn(runJbhifiRecon);
  const probeFn = useServerFn(runJbhifiProbe);
  const [query, setQuery] = useState("");
  const [skusText, setSkusText] = useState("");
  const [proxy, setProxy] = useState("");
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReconResult | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function run(opts: { refresh?: boolean } = {}) {
    setLoading(true);
    setError(null);
    setProbe(null);
    try {
      const trimmedProxy = proxy.trim();
      const skus = skusText
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await runFn({
        data: {
          query: query.trim() || null,
          skus: skus.length ? skus : null,
          hiddenOnly,
          refresh: !!opts.refresh,
          limit: 300,
          hydrateAll: hiddenOnly,
          useProxy: false,
          proxy: trimmedProxy || null,
        },
      });
      if (!res.ok) {
        setError((res as { error?: string }).error ?? `HTTP ${(res as { status?: number }).status ?? "error"}`);
      } else {
        setResult(res.result as ReconResult);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runProbe(opts: { refreshKeys?: boolean; skipShopify?: boolean } = {}) {
    const skus = skusText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!skus.length) {
      setError("Paste at least one SKU to probe endpoints.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await probeFn({
        data: { skus, proxy: proxy.trim() || null, concurrency: 6, refreshKeys: !!opts.refreshKeys, skipShopify: !!opts.skipShopify },
      });
      if (!res.ok) {
        setError((res as { error?: string }).error ?? `HTTP ${(res as { status?: number }).status ?? "error"}`);
      } else {
        setProbe(res.result as ProbeResult);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }


  const stats = result?.stats;
  const products = result?.products ?? [];

  const endpointRows = useMemo(
    () => (stats ? Object.entries(stats.endpointHits) : []),
    [stats],
  );

  function copyRow(p: Product) {
    void navigator.clipboard.writeText(JSON.stringify(p, null, 2));
    setCopied(p.handle);
    setTimeout(() => setCopied(null), 1200);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link to="/" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3 w-3" /> Back
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">JB Hi-Fi Shopify recon</h1>
            <p className="text-sm text-muted-foreground">
              Discovers products via sitemap + <code>/products.json</code>. &quot;Hidden&quot; = in sitemap but not in the public feed.
            </p>
          </div>
        </div>

        <Card className="mb-4 p-4">
          <div className="mb-3">
            <Label className="text-xs">Proxy (optional)</Label>
            <Input
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder="user:pass@host:port  or  host:port:user:pass"
              className="font-mono text-xs"
              autoFocus
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Leave blank to use the executor&apos;s default egress. Paste one proxy to test without touching your groups.
            </p>
          </div>
          <div className="mb-3">
            <Label className="text-xs">SKUs (optional — bypasses full sweep)</Label>
            <Input
              value={skusText}
              onChange={(e) => setSkusText(e.target.value)}
              placeholder="900805, 900807, 900810…"
              className="font-mono text-xs"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Paste comma/space separated SKUs. Uses Shopify predictive search + per-handle hydration — fast and safe from 502s.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
            <div>
              <Label className="text-xs">Search</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
                  placeholder="pokemon, celebrations, switch 2, ps5…"
                  className="pl-8"
                />
              </div>
            </div>
            <div className="flex flex-col justify-end">
              <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                <Switch id="hidden" checked={hiddenOnly} onCheckedChange={setHiddenOnly} />
                <Label htmlFor="hidden" className="cursor-pointer text-xs">Hidden only</Label>
              </div>
            </div>
            <div className="flex flex-col justify-end">
              <Button onClick={() => void run()} disabled={loading}>
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                Search
              </Button>
            </div>
            <div className="flex flex-col justify-end">
              <Button variant="outline" onClick={() => void run({ refresh: true })} disabled={loading} title="Force re-sweep sitemap + products.json">
                <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              variant="secondary"
              onClick={() => void runProbe()}
              disabled={loading}
              title="Fan out across ~8 public Shopify endpoints per SKU and report which leaked data"
            >
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Probe endpoints ({skusText.split(/[\s,]+/).filter(Boolean).length} SKUs)
            </Button>
          </div>
        </Card>


        {error && (
          <Card className="mb-4 border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </Card>
        )}

        {probe && (
          <Card className="mb-4 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
              <span className="font-medium">Endpoint probe</span>
              <Badge variant="outline">{probe.stats.skus} SKUs</Badge>
              <Badge variant="outline">{probe.stats.endpointsPerSku} endpoints/SKU</Badge>
              <Badge variant="outline">{probe.stats.uniqueHandlesFound} handles found</Badge>
              <Badge variant={probe.stats.confirmed > 0 ? "default" : "secondary"}>
                {probe.stats.confirmed} confirmed
              </Badge>
              <span className="text-muted-foreground">· {probe.elapsedMs}ms</span>
            </div>
            {probe.algolia && (
              <div className={`mb-3 rounded-md border p-2 text-[11px] font-mono ${probe.algolia.discovered ? "border-green-500/40 bg-green-500/5" : "border-destructive/40 bg-destructive/5"}`}>
                <div className="mb-1 font-sans font-medium">
                  Algolia {probe.algolia.discovered ? "✓ discovered" : "✗ not found"}
                </div>
                <div>appId: {probe.algolia.appId ?? "—"}</div>
                <div>apiKey: {probe.algolia.apiKey ?? "—"}</div>
                <div>indexName: {probe.algolia.indexName ?? "— (fallback list tried)"}</div>
                <div className="mt-1 text-muted-foreground">
                  scanned {probe.algolia.sources.length} source{probe.algolia.sources.length === 1 ? "" : "s"}
                </div>
              </div>
            )}
            <div className="space-y-3">
              {probe.bySku.map((row) => (
                <details key={row.sku} className="rounded-md border" open>
                  <summary className="cursor-pointer px-3 py-2 text-xs font-mono">
                    <span className="font-semibold">{row.sku}</span>
                    <span className="ml-2 text-muted-foreground">
                      {row.handlesFound.length} handle{row.handlesFound.length === 1 ? "" : "s"}:
                      {" "}{row.handlesFound.slice(0, 3).join(", ") || "—"}
                    </span>
                  </summary>
                  <div className="border-t overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead className="bg-muted/50 text-left">
                        <tr>
                          <th className="px-2 py-1">✓</th>
                          <th className="px-2 py-1">endpoint</th>
                          <th className="px-2 py-1 text-right">status</th>
                          <th className="px-2 py-1 text-right">ms</th>
                          <th className="px-2 py-1 text-right">bytes</th>
                          <th className="px-2 py-1">handles</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {row.endpoints.map((ep) => (
                          <tr key={ep.key} className="border-t">
                            <td className="px-2 py-1">
                              <span className={ep.handles.length > 0 ? "text-green-600" : ep.ok ? "text-muted-foreground" : "text-destructive"}>
                                {ep.handles.length > 0 ? "★" : ep.ok ? "·" : "✗"}
                              </span>
                            </td>
                            <td className="px-2 py-1"><span title={ep.url}>{ep.key}</span></td>
                            <td className="px-2 py-1 text-right">{ep.status || "—"}</td>
                            <td className="px-2 py-1 text-right">{ep.elapsedMs}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{ep.bytes}</td>
                            <td className="px-2 py-1 truncate max-w-[200px]">{ep.handles.slice(0, 2).join(", ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ))}
            </div>
          </Card>
        )}



        {stats && (
          <Card className="mb-4 p-4">
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-6">
              <Stat label="Sitemap" value={stats.sitemapCount} />
              <Stat label="products.json" value={stats.productsJsonCount} />
              <Stat label="Hidden" value={stats.hiddenCount} highlight={stats.hiddenCount > 0} />
              <Stat label="Considered" value={stats.candidatesConsidered} />
              <Stat label="Hydrated" value={stats.hydratedThisCall} />
              <Stat label="Returned" value={stats.returned} />
            </div>
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Endpoint diagnostics ({endpointRows.length})</summary>
              <div className="mt-2 space-y-1">
                {endpointRows.map(([k, v]) => (
                  <div key={k} className="flex gap-2 font-mono">
                    <span className={v.ok ? "text-green-600" : "text-destructive"}>{v.ok ? "✓" : "✗"}</span>
                    <span className="min-w-0 flex-1 truncate">{k}</span>
                    <span className="text-muted-foreground">{v.note}</span>
                  </div>
                ))}
              </div>
            </details>
          </Card>
        )}

        <div className="space-y-2">
          {products.map((p) => (
            <Card key={p.handle} className="p-3">
              <div className="flex gap-3">
                {p.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image} alt="" className="h-16 w-16 shrink-0 rounded object-cover" />
                ) : (
                  <div className="h-16 w-16 shrink-0 rounded bg-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {p.hidden && <Badge variant="destructive" className="uppercase">Hidden</Badge>}
                    <a href={p.url} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline">
                      {p.title}
                    </a>
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{fmtPrice(p.priceMin, p.priceMax)}</span>
                    {p.vendor && <span>· {p.vendor}</span>}
                    {p.productType && <span>· {p.productType}</span>}
                    <span>· {p.variantCount} variant{p.variantCount === 1 ? "" : "s"}</span>
                    {p.inventoryTotal > 0 && <span>· inv {p.inventoryTotal}</span>}
                    {p.publishedAt && <span>· pub {new Date(p.publishedAt).toLocaleString()}</span>}
                  </div>
                  {p.variants.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {p.variants.slice(0, 8).map((v) => (
                        <Badge key={v.id} variant="outline" className="font-mono text-[10px]">
                          {v.sku ?? v.id}
                          {v.available === false ? " · OOS" : ""}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <Button size="sm" variant="ghost" onClick={() => copyRow(p)} title="Copy JSON">
                  <Copy className="h-3 w-3" />
                  {copied === p.handle ? " Copied" : ""}
                </Button>
              </div>
            </Card>
          ))}
          {!loading && products.length === 0 && result && (
            <Card className="p-8 text-center text-sm text-muted-foreground">No products match.</Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-md border p-2 ${highlight ? "border-primary/50 bg-primary/5" : ""}`}>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</div>
    </div>
  );
}
