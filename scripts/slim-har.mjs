#!/usr/bin/env node
// Slim a Chrome HAR down to just what Harvey needs for Kmart Akamai diagnosis.
// Usage: node scripts/slim-har.mjs <input.har> <output.har>

import { readFileSync, writeFileSync, statSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: slim-har.mjs <input.har> <output.har>");
  process.exit(1);
}

const KEEP_HOST = /(^|\.)kmart\.com\.au$/i;
const KEEP_URL = /(akamai|_bm|abck|sensor|edgesuite|bazaarvoice)/i;
const STRIP_MIME = /^(image\/|font\/|text\/css|video\/|audio\/)/i;
const JS_MIME = /(javascript|ecmascript)/i;
const JS_STRIP_BYTES = 50 * 1024;
const BODY_TRUNC_BYTES = 200 * 1024;

const raw = readFileSync(inPath, "utf8");
const har = JSON.parse(raw);
const entries = har.log?.entries ?? [];
console.log(`input entries: ${entries.length}, size: ${(statSync(inPath).size / 1e6).toFixed(1)} MB`);

let kept = 0,
  droppedHost = 0,
  strippedBodies = 0;

const slim = entries.filter((e) => {
  const url = e.request?.url || "";
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  const keep = KEEP_HOST.test(host) || KEEP_URL.test(url);
  if (!keep) {
    droppedHost++;
    return false;
  }
  kept++;
  return true;
});

for (const e of slim) {
  const c = e.response?.content;
  if (!c) continue;
  const mime = c.mimeType || "";
  const size = c.size || (c.text ? c.text.length : 0);
  const isBinaryish = STRIP_MIME.test(mime);
  const isBigJs = JS_MIME.test(mime) && size > JS_STRIP_BYTES;
  if (isBinaryish || isBigJs) {
    c.text = "";
    c.comment = `[stripped by slim-har: ${mime} ${size}b]`;
    strippedBodies++;
  } else if (c.text && c.text.length > BODY_TRUNC_BYTES) {
    c.text = c.text.slice(0, BODY_TRUNC_BYTES);
    c.comment = `[truncated by slim-har to ${BODY_TRUNC_BYTES}b]`;
    strippedBodies++;
  }
}

har.log.entries = slim;
writeFileSync(outPath, JSON.stringify(har));
const outSize = statSync(outPath).size;
console.log(
  `kept: ${kept}, dropped-host: ${droppedHost}, stripped-bodies: ${strippedBodies}, output: ${(outSize / 1e6).toFixed(2)} MB`,
);

if (outSize > 10 * 1024 * 1024) {
  console.warn("WARNING: output still > 10 MB. Second pass: hard-truncate all remaining bodies to 20 KB.");
  for (const e of har.log.entries) {
    const c = e.response?.content;
    if (c?.text && c.text.length > 20 * 1024) {
      c.text = c.text.slice(0, 20 * 1024);
      c.comment = "[hard-truncated 20kb pass2]";
    }
  }
  writeFileSync(outPath, JSON.stringify(har));
  const s2 = statSync(outPath).size;
  console.log(`pass2 output: ${(s2 / 1e6).toFixed(2)} MB`);
}
