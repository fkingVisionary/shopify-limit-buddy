// Lab probe: discover F5/common.js sensor wiring on Premium Bandai AU.
import { request, createJar, makeDispatcher } from "../http.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const jar = createJar();
const dispatcher = makeDispatcher(process.env.BANDAI_PROXY || null, { forceUndici: true });
const ctx = { jar, dispatcher };

const home = await request(
  "https://p-bandai.com/au/",
  {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-AU,en;q=0.9",
    },
  },
  ctx,
);
const html = await home.text();
jar.ingest?.(home.headers);

console.log("home", home.status, "len", html.length);
console.log("set-cookie names from jar dump keys:", Object.keys(jar.dump?.() || {}));

const allScripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
console.log("script count", allScripts.length);
console.log(
  "interesting scripts",
  allScripts.filter((s) => /common|ui\/responsive|p8k|volt|f5|adc|challenge/i.test(s)),
);

const inlineHints = [];
for (const re of [
  /common\.js[^"'<\s]*/gi,
  /p8k[Oo]mysnbc[^"'<\s]*/gi,
  /ktlvDW7[^"'<\s]*/gi,
  /seed=[^&"'<\s]+/gi,
]) {
  const hits = [...html.matchAll(re)].map((m) => m[0]).slice(0, 8);
  if (hits.length) inlineHints.push({ re: String(re), hits });
}
console.log("inlineHints", JSON.stringify(inlineHints, null, 2));

// Fetch login page too — antibot may be stronger there
const login = await request(
  "https://p-bandai.com/au/login",
  {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-AU,en;q=0.9",
      referer: "https://p-bandai.com/au/",
    },
  },
  ctx,
);
const loginHtml = await login.text();
jar.ingest?.(login.headers);
console.log("login", login.status, "len", loginHtml.length);
const loginScripts = [...loginHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
console.log(
  "login interesting",
  loginScripts.filter((s) => /common|ui\/responsive|p8k|volt|f5|adc|challenge/i.test(s)),
);
const commonRef =
  loginScripts.find((s) => /common\.js/i.test(s)) ||
  allScripts.find((s) => /common\.js/i.test(s)) ||
  null;
console.log("commonRef", commonRef);

if (commonRef) {
  const url = commonRef.startsWith("http")
    ? commonRef
    : `https://p-bandai.com${commonRef.startsWith("/") ? "" : "/"}${commonRef}`;
  const jsRes = await request(
    url,
    {
      headers: {
        "user-agent": UA,
        accept: "*/*",
        referer: "https://p-bandai.com/au/login",
        "sec-fetch-dest": "script",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-site": "same-origin",
      },
    },
    ctx,
  );
  const js = await jsRes.text();
  jar.ingest?.(jsRes.headers);
  console.log("common.js status", jsRes.status, "len", js.length);
  const asyncSeed = js.match(/common\.js\?async[^"'\\\s]*/i);
  const seedParam = js.match(/seed=([A-Za-z0-9_-]+)/);
  const zParam = js.match(/p8kOmysnbc--z=([A-Za-z0-9_-]+)/i);
  console.log("asyncSeed hint", asyncSeed?.[0]?.slice(0, 200));
  console.log("seed", seedParam?.[1]);
  console.log("z", zParam?.[1]);
  // Find header name patterns
  const headerNames = [...js.matchAll(/p8k[Oo]mysnbc-[a-z]/gi)].map((m) => m[0]);
  console.log("header names sample", [...new Set(headerNames)].slice(0, 20));
  // Write for offline analysis
  const fs = await import("node:fs");
  fs.mkdirSync("/tmp/bandai-f5", { recursive: true });
  fs.writeFileSync("/tmp/bandai-f5/home.html", html);
  fs.writeFileSync("/tmp/bandai-f5/login.html", loginHtml);
  fs.writeFileSync("/tmp/bandai-f5/common-single.js", js);
  console.log("wrote /tmp/bandai-f5/*");
}
