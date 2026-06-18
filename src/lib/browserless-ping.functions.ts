import { createServerFn } from "@tanstack/react-start";

// Lightweight connectivity check for the configured Browserless key.
// Hits /function with a near-empty script and a 10s timeout so the user
// can verify their key + plan from the Settings page without firing a real
// checkout.
export const pingBrowserless = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: boolean; status?: number; message: string; elapsedMs: number }> => {
    const start = Date.now();
    const apiKey = process.env.BROWSERLESS_API_KEY;
    if (!apiKey) {
      return { ok: false, message: "BROWSERLESS_API_KEY missing on server", elapsedMs: 0 };
    }
    const url = new URL("https://production-sfo.browserless.io/function");
    url.searchParams.set("token", apiKey);
    url.searchParams.set("timeout", "10000");

    const code = `module.exports = async ({ page }) => {
      await page.goto("about:blank");
      return { ok: true, ua: await page.evaluate(() => navigator.userAgent) };
    }`;

    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, context: {} }),
      });
      const body = await res.text().catch(() => "");
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          message: `HTTP ${res.status}: ${body.slice(0, 300)}`,
          elapsedMs: Date.now() - start,
        };
      }
      return {
        ok: true,
        status: res.status,
        message: `OK in ${Date.now() - start}ms`,
        elapsedMs: Date.now() - start,
      };
    } catch (e) {
      return {
        ok: false,
        message: `Transport error: ${(e as Error).message}`,
        elapsedMs: Date.now() - start,
      };
    }
  },
);
