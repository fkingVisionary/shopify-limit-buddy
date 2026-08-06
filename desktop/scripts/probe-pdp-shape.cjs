const fs = require("fs");
const path = require("path");
const { ProxyAgent, fetch } = require(
  path.join(__dirname, "..", "..", "executor", "node_modules", "undici"),
);

function toUrl(line) {
  const p = String(line || "").trim();
  if (/^https?:\/\//i.test(p)) return p;
  const parts = p.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(rest.join(":"))}@${host}:${port}`;
  }
  return p;
}

async function main() {
  const db = JSON.parse(
    fs.readFileSync(
      path.join(process.env.APPDATA, "vanta-desktop", "j1ms-desktop", "db.json"),
      "utf8",
    ),
  );
  const proxy = toUrl(db.proxyGroups[0].entries[0]);
  const d = new ProxyAgent(proxy);
  const sku = process.argv[2] || "N2903432004";
  const res = await fetch(`https://p-bandai.com/au/item/${sku}`, {
    dispatcher: d,
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "accept-language": "en-AU,en;q=0.9",
    },
  });
  const body = await res.text();
  console.log(
    JSON.stringify(
      {
        status: res.status,
        len: body.length,
        head: body.slice(0, 240),
        soldOut: /sold\s*out|out\s*of\s*stock/i.test(body),
        addToCart: /Add to Cart|addToCart/i.test(body),
        soft: /SoftBlock|Access Denied|cf-challenge|Just a moment/i.test(body),
        title: (body.match(/<title>([^<]+)/i) || [])[1] || "",
      },
      null,
      2,
    ),
  );
  await d.close?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
