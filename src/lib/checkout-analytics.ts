/** Local checkout outcome log (Kmart executor + any non-runner checkouts).
 * Persisted under aio:checkout-analytics so cloud sync mirrors it across devices.
 */

export type LocalCheckoutTx = {
  id: string;
  at: number;
  storeUrl: string;
  storeName?: string | null;
  productTitle?: string | null;
  orderId?: string | null;
  ok: boolean;
  /** User/bank rejected 3DS or issuer declined the charge. */
  declined?: boolean;
  error?: string | null;
  amount?: number | null;
  currency?: string | null;
  qty?: number | null;
  retailer?: string | null;
  profileName?: string | null;
  elapsedMs?: number | null;
  taskId?: string | null;
};

const KEY = "aio:checkout-analytics";
const MAX = 250;

function readAll(): LocalCheckoutTx[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LocalCheckoutTx[]) : [];
  } catch {
    return [];
  }
}

function writeAll(rows: LocalCheckoutTx[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(rows.slice(0, MAX)));
    window.dispatchEvent(new Event("aio:changed"));
  } catch {
    /* ignore quota */
  }
}

export function loadCheckoutAnalytics(): LocalCheckoutTx[] {
  return readAll();
}

export function recordCheckoutOutcome(
  tx: Omit<LocalCheckoutTx, "id" | "at"> & { id?: string; at?: number },
): LocalCheckoutTx {
  const row: LocalCheckoutTx = {
    id: tx.id ?? `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: tx.at ?? Date.now(),
    storeUrl: tx.storeUrl,
    storeName: tx.storeName ?? null,
    productTitle: tx.productTitle ?? null,
    orderId: tx.orderId ?? null,
    ok: Boolean(tx.ok),
    declined: Boolean(tx.declined),
    error: tx.error ?? null,
    amount: tx.amount ?? null,
    currency: tx.currency ?? "AUD",
    qty: tx.qty ?? null,
    retailer: tx.retailer ?? null,
    profileName: tx.profileName ?? null,
    elapsedMs: tx.elapsedMs ?? null,
    taskId: tx.taskId ?? null,
  };
  const next = [row, ...readAll().filter((r) => r.id !== row.id)];
  writeAll(next);
  return row;
}
