// Discord webhook notifications — pure client-side, no backend.
// Fired from the in-app poll loop when a task transitions to a notable state.

export type NotifyEvent = "in_stock" | "checkout_ready" | "confirmed" | "failed";

export type NotifyConfig = {
  webhookUrl: string;
  events: Record<NotifyEvent, boolean>;
};

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  webhookUrl: "",
  events: {
    in_stock: false,
    checkout_ready: false,
    confirmed: true,
    failed: true,
  },
};

const NOTIFY_KEY = "aio:notify";
const BOT_NAME = "J1m's Bot";
const BOT_VERSION = "v1.0";

function logoUrl(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/jims-logo.jpg`;
}

export function loadNotifyConfig(): NotifyConfig {
  try {
    const raw = localStorage.getItem(NOTIFY_KEY);
    if (!raw) return DEFAULT_NOTIFY_CONFIG;
    const j = JSON.parse(raw);
    return {
      webhookUrl: typeof j.webhookUrl === "string" ? j.webhookUrl : "",
      events: { ...DEFAULT_NOTIFY_CONFIG.events, ...(j.events ?? {}) },
    };
  } catch {
    return DEFAULT_NOTIFY_CONFIG;
  }
}

export function saveNotifyConfig(cfg: NotifyConfig) {
  try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(cfg)); } catch {}
}

const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

export function isValidWebhookUrl(url: string): boolean {
  return WEBHOOK_RE.test(url.trim());
}

export type NotifyTaskShape = {
  id: string;
  productTitle?: string;
  input: string;
  storeName: string;
  storeUrl: string;
  qty: number;
  variantId?: number;
  variantTitle?: string;
  price?: string;
  orderId?: string | null;
  checkoutElapsedMs?: number;
  message?: string;
  groupName?: string;
  profileFirst?: string;
  profileLast?: string;
  profileEmail?: string;
  paymentMethod?: string;
  mode?: string;
  proxyGroupName?: string;
};

// Brand gold (matches --primary token).
const BRAND_GOLD = 0xEAD24A;

const EVENT_META: Record<NotifyEvent, { title: string; subtitle: string; color: number }> = {
  in_stock:       { title: "Stock Detected",       subtitle: "Variant came in stock.",          color: 0x3B82F6 },
  checkout_ready: { title: "Checkout Ready",       subtitle: "Cart prepared, awaiting submit.", color: 0xF59E0B },
  confirmed:      { title: "Successful Checkout!", subtitle: "Your Webhook works!",             color: BRAND_GOLD },
  failed:         { title: "Checkout Failed",      subtitle: "Task could not complete.",        color: 0xEF4444 },
};

function maskProfile(first?: string, last?: string): string {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (!f && !l) return "—";
  const li = l ? `${l[0]}.****` : "****";
  return `${f} ${li}`.trim();
}

function maskEmail(email?: string): string {
  const e = (email ?? "").trim();
  if (!e) return "—";
  const [user, domain] = e.split("@");
  if (!domain) return "—";
  const masked = user.length <= 2 ? `${user[0] ?? "*"}*` : `${user.slice(0, 2)}${"*".repeat(Math.max(2, user.length - 2))}`;
  return `${masked}@${domain}`;
}

function fmtElapsed(ms?: number): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  return `${(ms / 1000).toFixed(1)} seconds`;
}

// Plain value — no code blocks, no boxes. Falls back to em-dash.
function v(value: string | number | null | undefined): string {
  const s = String(value ?? "").trim();
  return s.length > 0 ? s : "—";
}

function buildEmbed(event: NotifyEvent, t: NotifyTaskShape) {
  const meta = EVENT_META[event];
  const product = t.productTitle ?? t.input;
  const storeLink = t.storeUrl
    ? (t.storeUrl.startsWith("http") ? t.storeUrl : `https://${t.storeUrl}`)
    : undefined;

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Store",   value: v(t.storeName || t.storeUrl) },
    { name: "Product", value: v(product) },
  ];
  if (t.price)   fields.push({ name: "Price",    value: v(t.price) });
  if (t.orderId) fields.push({ name: "Order #",  value: v(t.orderId) });
  const elapsed = fmtElapsed(t.checkoutElapsedMs);
  if (elapsed)   fields.push({ name: "Checkout Time", value: v(elapsed) });
  fields.push({ name: "QTY", value: v(t.qty) });
  if (t.variantTitle || t.variantId) {
    fields.push({ name: "Variant", value: v(t.variantTitle ?? t.variantId) });
  }
  fields.push({
    name: "Profile / Email",
    value: v(`${maskProfile(t.profileFirst, t.profileLast)} / ${maskEmail(t.profileEmail)}`),
  });
  if (t.paymentMethod) fields.push({ name: "Payment Method", value: v(t.paymentMethod) });
  if (t.mode)          fields.push({ name: "Mode",           value: v(t.mode) });
  fields.push({ name: "Proxy", value: v(t.proxyGroupName || "Localhost") });
  if (t.message && event === "failed") {
    fields.push({ name: "Reason", value: v(t.message.slice(0, 300)) });
  }

  const icon = logoUrl();

  return {
    // `url` on the title makes Discord render the title in its accent blue
    // (matches the SecuredBot reference). Color bar still uses `color`.
    title: meta.title,
    url: storeLink,
    description: meta.subtitle,
    color: meta.color,
    fields,
    footer: {
      text: `${BOT_NAME} — ${BOT_VERSION}${t.groupName ? ` • ${t.groupName}` : ""}`,
      icon_url: icon || undefined,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function notifyWebhook(
  cfg: NotifyConfig,
  event: NotifyEvent,
  task: NotifyTaskShape,
): Promise<boolean> {
  if (!cfg.webhookUrl || !cfg.events[event]) return false;
  if (!isValidWebhookUrl(cfg.webhookUrl)) return false;
  try {
    const res = await fetch(cfg.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: BOT_NAME,
        avatar_url: logoUrl() || undefined,
        embeds: [buildEmbed(event, task)],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendTestWebhook(url: string): Promise<boolean> {
  if (!isValidWebhookUrl(url)) return false;
  const icon = logoUrl();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: BOT_NAME,
        avatar_url: icon || undefined,
        embeds: [{
          title: "Successful Checkout!",
          url: "https://j1ms-bot.com",
          description: "Your Webhook works!",
          color: BRAND_GOLD,
          fields: [
            { name: "Store",            value: v("J1m's Bot") },
            { name: "Product",          value: v("J1m's Bot Lifetime Key") },
            { name: "Price",            value: v("$67.90") },
            { name: "Order #",          value: v("J1MS-00001") },
            { name: "Checkout Time",    value: v("6.7 seconds") },
            { name: "QTY",              value: v(1) },
            { name: "Profile / Email",  value: v("Jim S.**** / ji****@j1ms-bot.com") },
            { name: "Payment Method",   value: v("Manual") },
            { name: "Mode",             value: v("Safe + Preload") },
            { name: "Proxy",            value: v("Localhost") },
          ],
          footer: { text: `${BOT_NAME} — ${BOT_VERSION}`, icon_url: icon || undefined },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
