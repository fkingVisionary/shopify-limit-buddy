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
  orderId?: string | null;
  checkoutElapsedMs?: number;
  message?: string;
  groupName?: string;
  profileFirst?: string;
  profileLast?: string;
  proxyGroupName?: string;
};

const EVENT_META: Record<NotifyEvent, { title: string; color: number; emoji: string }> = {
  in_stock:       { title: "In stock",        color: 0x3b82f6, emoji: "🟢" },
  checkout_ready: { title: "Checkout ready",  color: 0xf59e0b, emoji: "🛒" },
  confirmed:      { title: "Order confirmed", color: 0x10b981, emoji: "✅" },
  failed:         { title: "Failed",          color: 0xef4444, emoji: "❌" },
};

function maskProfile(first?: string, last?: string): string {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (!f && !l) return "—";
  const li = l ? `${l[0]}.****` : "****";
  return `${f} ${li}`.trim();
}

function buildEmbed(event: NotifyEvent, t: NotifyTaskShape) {
  const meta = EVENT_META[event];
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Store", value: t.storeName || t.storeUrl, inline: true },
    { name: "Qty", value: String(t.qty), inline: true },
  ];
  if (t.variantId) fields.push({ name: "Variant", value: String(t.variantId), inline: true });
  fields.push({ name: "Profile", value: maskProfile(t.profileFirst, t.profileLast), inline: true });
  if (t.proxyGroupName) fields.push({ name: "Proxy", value: t.proxyGroupName, inline: true });
  if (t.orderId) fields.push({ name: "Order", value: String(t.orderId), inline: true });
  if (t.checkoutElapsedMs) fields.push({ name: "Elapsed", value: `${t.checkoutElapsedMs}ms`, inline: true });
  if (t.message && (event === "failed")) fields.push({ name: "Reason", value: t.message.slice(0, 200) });

  return {
    title: `${meta.emoji} ${meta.title} — ${t.productTitle ?? t.input}`,
    color: meta.color,
    fields,
    footer: { text: t.groupName ? `Group: ${t.groupName}` : "J1m's Bot" },
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
      body: JSON.stringify({ embeds: [buildEmbed(event, task)] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendTestWebhook(url: string): Promise<boolean> {
  if (!isValidWebhookUrl(url)) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "✅ J1m's Bot — test notification",
          description: "Your Discord webhook is wired up correctly.",
          color: 0x10b981,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
