const token = process.env.EXECUTOR_TOKEN;
const baseUrl = process.env.EXECUTOR_URL ?? "http://localhost:8080";
if (!token) {
  console.error("EXECUTOR_TOKEN is required");
  process.exit(1);
}

const url = process.argv[2] ?? "https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/";
const proxy = process.env.PROXY_URL_RESI ?? process.env.PROXY_URL ?? null;

const res = await fetch(`${baseUrl.replace(/\/$/, "")}/akamai/lab`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ url, proxy, rounds: 3 }),
});

const text = await res.text();
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}