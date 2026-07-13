## Problem

Harvey's UI is only accepting a single file up to 10 MB right now. Your raw HAR is 56 MB (Chrome HARs embed every response body — images, fonts, CSS, JS bundles — as base64, which is where the bulk lives). We need to (a) strip the HAR down to just the requests Harvey actually needs, and (b) get the code bundle + HAR into one file.

## Plan

### Step 1 — Slim the HAR (done by me, in build mode)

I'll add a small Node script at `scripts/slim-har.mjs` that reads your uploaded HAR and writes `public/kmart-slim.har` keeping only what Harvey needs:

- **Keep** any request whose URL host is `www.kmart.com.au` or `api.kmart.com.au`, plus any URL containing `akamai`, `_bm`, `abck`, `sensor`, or `edgesuite`.
- **Drop** all other hosts (analytics, ads, fonts, CDN images, Segment, GTM, etc.).
- **Strip response bodies** for `image/*`, `font/*`, `text/css`, and any JS bundle over 50 KB — replace `content.text` with `""` and keep `content.mimeType` + `size`. Sensor POST bodies and GraphQL JSON responses stay intact (that's what Harvey needs).
- **Keep** all request headers, all cookies, all `Set-Cookie`, all timings.

Target output: well under 10 MB. If it's still too big, the script has a second pass that also drops non-Kmart-host entries entirely and truncates any remaining body over 200 KB.

### Step 2 — Combine into one uploadable file

Two options depending on what Harvey's uploader accepts — I'll produce both so you can try whichever works:

1. `public/harvey-bundle.zip` — the slim HAR + `kmart.js` + `antibot.js` + `http.js` + `failing-run.json` + `hyper-solutions-brief.md` + `PROMPT.md`, zipped. This is the ideal single-file upload.
2. `public/kmart-slim.har` on its own — if Harvey rejects `.zip`, upload just the slim HAR and paste the code inline into the prompt box (I'll prepare a version of `PROMPT.md` with the three JS files inlined in fenced code blocks).

Both will be linked from a tiny download page at `/harvey` so you can tap them from mobile.

### Step 3 — You upload

1. Drop your 56 MB `.har` into this chat.
2. I run the slim script, produce the zip, and give you two mobile-friendly download links.
3. You upload whichever Harvey accepts and paste the prompt.

### What I need from you

Just the raw HAR file uploaded to this chat. Don't try to trim it yourself — the script will do a better job and keep the sensor payloads intact.

## Technical notes

- HAR is JSON, so slimming is a straightforward `JSON.parse` → filter `log.entries` → `JSON.stringify`. Bun can run the script directly.
- We do not touch cookies or request/response headers — Harvey needs those to see the abck seeding flow. Only large binary-ish response bodies get zeroed out.
- Zip uses Bun's built-in `Bun.write` + a tiny zip lib (or `zip` shelled out if available); either way the output stays under 10 MB because the slim HAR is the only large member.
