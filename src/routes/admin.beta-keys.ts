import { createFileRoute } from "@tanstack/react-router";
import { allowlistedKeys, desktopAuthMode } from "@/lib/desktop-license";

/**
 * Operator-only list of seeded desktop API keys.
 * Requires ?token= to match DESKTOP_KEYS_ADMIN_TOKEN (set on Railway).
 */
export const Route = createFileRoute("/admin/beta-keys")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const token = String(url.searchParams.get("token") || "").trim();
        const expected = String(process.env.DESKTOP_KEYS_ADMIN_TOKEN || "").trim();
        if (!expected || token !== expected) {
          return new Response("Not found", { status: 404 });
        }

        const mode = desktopAuthMode();
        const keys = [...allowlistedKeys()].sort();
        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Vanta Beta keys</title>
  <style>
    body { font-family: "Segoe UI", system-ui, sans-serif; background:#0b1020; color:#f4f6fb; margin:0; padding:32px 20px; }
    main { max-width:640px; margin:0 auto; }
    h1 { font-size:24px; margin:0 0 8px; }
    p { color:#b7c0d4; line-height:1.5; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    ol { padding-left: 1.2rem; line-height: 1.9; }
    li code { background:rgba(255,255,255,.06); padding:4px 8px; border-radius:6px; word-break:break-all; }
    .meta { font-size:13px; color:#8b9bb8; margin-bottom:20px; }
    a { color:#9db7ff; }
  </style>
</head>
<body>
  <main>
    <h1>Vanta Beta — desktop keys</h1>
    <p class="meta">Mode: <code>${mode}</code> · ${keys.length} key(s) · keep this URL private</p>
    <p>Hand <strong>one key per tester</strong>. In the app: Settings → paste API key → save.</p>
    <ol>
      ${keys.map((k) => `<li><code>${escapeHtml(k)}</code></li>`).join("\n      ") || "<li><em>No keys in DESKTOP_API_KEYS</em></li>"}
    </ol>
    <p><a href="/download">Download page</a> · <a href="/">Dashboard</a></p>
  </main>
</body>
</html>`;
        return new Response(html, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
