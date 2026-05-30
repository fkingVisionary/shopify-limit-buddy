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
  price?: string;        // formatted, e.g. "$67.90"
  orderId?: string | null;
  checkoutElapsedMs?: number;
  message?: string;
  groupName?: string;
  profileFirst?: string;
  profileLast?: string;
  profileEmail?: string;
  paymentMethod?: string; // "Browserless (live)" | "Browserless (dry-run)" | "Tab launch" | "Manual"
  mode?: string;          // "Live / Monitor: false"
  proxyGroupName?: string;
};

// Brand gold matches our --primary token (oklch(0.88 0.18 95) ≈ #EAD24A).
const BRAND_GOLD = 0xEAD24A;

const EVENT_META: Record<NotifyEvent, { title: string; subtitle: string; color: number }> = {
  in_stock:       { title: "Stock Detected",     subtitle: "Variant came in stock.",        color: 0x3B82F6 },
  checkout_ready: { title: "Checkout Ready",     subtitle: "Cart prepared, awaiting submit.", color: 0xF59E0B },
  confirmed:      { title: "Successful Checkout!", subtitle: "Your Webhook works!",          color: BRAND_GOLD },
  failed:         { title: "Checkout Failed",    subtitle: "Task could not complete.",      color: 0xEF4444 },
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

function code(value: string | number | null | undefined): string {
  const v = String(value ?? "—");
  return "```\n" + v + "\n```";
}

function buildEmbed(event: NotifyEvent, t: NotifyTaskShape) {
  const meta = EVENT_META[event];
  const product = t.productTitle ?? t.input;
  const fields: { name: string; value: string; inline?: boolean }[] = [];

  fields.push({ name: "Store", value: code(t.storeName || t.storeUrl) });
  fields.push({ name: "Product", value: code(product) });
  if (t.price) fields.push({ name: "Price", value: code(t.price) });
  if (t.orderId) fields.push({ name: "Order #", value: code(t.orderId) });
  const elapsed = fmtElapsed(t.checkoutElapsedMs);
  if (elapsed) fields.push({ name: "Checkout Time", value: code(elapsed) });
  fields.push({ name: "QTY", value: code(t.qty) });
  if (t.variantTitle || t.variantId) {
    fields.push({ name: "Variant", value: code(t.variantTitle ?? String(t.variantId)) });
  }
  fields.push({
    name: "Profile / Email",
    value: code(`${maskProfile(t.profileFirst, t.profileLast)} / ${maskEmail(t.profileEmail)}`),
  });
  if (t.paymentMethod) fields.push({ name: "Payment Method", value: code(t.paymentMethod) });
  if (t.mode) fields.push({ name: "Mode", value: code(t.mode) });
  fields.push({ name: "Proxy", value: code(t.proxyGroupName || "Localhost") });
  if (t.message && event === "failed") {
    fields.push({ name: "Reason", value: code(t.message.slice(0, 300)) });
  }

  const icon = logoUrl();
  const storeLink = t.storeUrl ? (t.storeUrl.startsWith("http") ? t.storeUrl : `https://${t.storeUrl}`) : undefined;

  return {
    author: {
      name: BOT_NAME,
      icon_url: icon || undefined,
      url: storeLink,
    },
    title: meta.title,
    description: meta.subtitle,
    color: meta.color,
    thumbnail: icon ? { url: icon } : undefined,
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
          author: { name: BOT_NAME, icon_url: icon || undefined },
          title: "Successful Checkout!",
          description: "Your Webhook works!",
          color: BRAND_GOLD,
          thumbnail: icon ? { url: icon } : undefined,
          fields: [
            { name: "Store", value: code("J1m's Bot") },
            { name: "Product", value: code("J1m's Bot Lifetime Key") },
            { name: "Price", value: code("$67.90") },
            { name: "Order #", value: code("J1MS-00001") },
            { name: "Checkout Time", value: code("6.7 seconds") },
            { name: "QTY", value: code(1) },
            { name: "Profile / Email", value: code("Jim S.**** / ji****@j1ms-bot.com") },
            { name: "Payment Method", value: code("Manual") },
            { name: "Mode", value: code("Slow / Monitor: false") },
            { name: "Proxy", value: code("Localhost") },
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
