// In-house global Kmart monitor — same endpoint for every desktop user.
// Users never configure a feed URL. Operators override only via env for local ops.

const DEFAULT_MONITOR_FEED_URL = "https://j1ms-kmart-monitor.fly.dev/feed";

/**
 * Resolve the baked-in global monitor SSE URL.
 * `MONITOR_FEED_URL` is for local/dev ops only (e.g. http://127.0.0.1:8091/feed).
 */
function resolveMonitorFeedUrl() {
  const fromEnv = String(process.env.MONITOR_FEED_URL || "").trim();
  const raw = fromEnv || DEFAULT_MONITOR_FEED_URL;
  return raw.replace(/\/$/, "");
}

module.exports = {
  DEFAULT_MONITOR_FEED_URL,
  resolveMonitorFeedUrl,
};
