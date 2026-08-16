import { createFileRoute } from "@tanstack/react-router";
import { vantaWinPortableUrl } from "@/lib/vanta-download";

/** Optional portable build redirect. */
export const Route = createFileRoute("/api/public/desktop/portable")({
  server: {
    handlers: {
      GET: async () => Response.redirect(vantaWinPortableUrl(), 302),
    },
  },
});
