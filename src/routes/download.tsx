import { createFileRoute, Link } from "@tanstack/react-router";

const PRODUCT = "Vanta Beta";

export const Route = createFileRoute("/download")({
  component: DownloadPage,
  head: () => ({
    meta: [
      { title: "Download Vanta Beta" },
      {
        name: "description",
        content: "Download Vanta Beta for Windows — install in a few clicks.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function DownloadPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        background: "linear-gradient(165deg, #0b1020 0%, #12182b 45%, #0e1422 100%)",
        color: "#f4f6fb",
        padding: "48px 20px 64px",
      }}
    >
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <p
          style={{
            margin: "0 0 8px",
            fontSize: 12,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "#8b9bb8",
          }}
        >
          {PRODUCT}
        </p>
        <h1 style={{ margin: "0 0 12px", fontSize: 36, fontWeight: 700, lineHeight: 1.15 }}>
          Download for Windows
        </h1>
        <p style={{ margin: "0 0 28px", fontSize: 16, lineHeight: 1.55, color: "#b7c0d4" }}>
          One installer. No coding. No terminal. Follow the three steps below.
        </p>

        <a
          href="/api/public/desktop/setup"
          style={{
            display: "block",
            textAlign: "center",
            padding: "18px 20px",
            borderRadius: 12,
            background: "#3d7eff",
            color: "#fff",
            fontSize: 18,
            fontWeight: 650,
            textDecoration: "none",
            boxShadow: "0 10px 30px rgba(61, 126, 255, 0.35)",
          }}
        >
          Download {PRODUCT}
        </a>
        <p style={{ margin: "10px 0 0", fontSize: 13, color: "#8b9bb8", textAlign: "center" }}>
          Windows 10/11 · 64-bit · ~115 MB
        </p>

        <ol
          style={{
            margin: "36px 0 0",
            padding: "20px 20px 20px 40px",
            borderRadius: 14,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            lineHeight: 1.6,
            color: "#d5dced",
          }}
        >
          <li style={{ marginBottom: 12 }}>
            Tap <strong>Download {PRODUCT}</strong> and save the file.
          </li>
          <li style={{ marginBottom: 12 }}>
            Open the file. If Windows warns you, choose <strong>More info</strong> →{" "}
            <strong>Run anyway</strong> (this is an unsigned beta).
          </li>
          <li>
            Open <strong>{PRODUCT}</strong> from your Desktop, then paste the API key from
            your beta invite (Settings → API key).
          </li>
        </ol>

        <p style={{ margin: "28px 0 0", fontSize: 13, color: "#8b9bb8", textAlign: "center" }}>
          Advanced:{" "}
          <a href="/api/public/desktop/portable" style={{ color: "#9db7ff" }}>
            portable version
          </a>
          {" · "}
          <Link to="/" style={{ color: "#9db7ff" }}>
            Back to dashboard
          </Link>
        </p>
      </div>
    </main>
  );
}
