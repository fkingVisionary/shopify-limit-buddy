import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/harvey")({
  component: HarveyDownloads,
  head: () => ({
    meta: [
      { title: "Harvey bundle downloads" },
      { name: "description", content: "Mobile-friendly downloads for the Harvey submission bundle." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function HarveyDownloads() {
  const files = [
    { href: "/harvey-bundle.zip", label: "harvey-bundle.zip (code + slim HAR)" },
    { href: "/kmart-slim.har", label: "kmart-slim.har (HAR only)" },
    { href: "/harvey-prompt.txt", label: "harvey-prompt.txt (paste into Harvey)" },
  ];
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 640, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>Harvey submission bundle</h1>
      <p style={{ color: "#555", marginBottom: 24 }}>
        Tap a file to download. Upload whichever Harvey's UI accepts.
      </p>
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
        {files.map((f) => (
          <li key={f.href}>
            <a
              href={f.href}
              download
              style={{
                display: "block",
                padding: "14px 16px",
                background: "#111",
                color: "#fff",
                borderRadius: 10,
                textDecoration: "none",
                fontWeight: 500,
              }}
            >
              ⬇︎ {f.label}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
