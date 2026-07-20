# Hyper + HAR + green-path alignment (2026-07-20)

Cross-check of tip `81d5acb` (#78 park) against Hyper docs, `public/kmart-slim.har`,
and green artifact `/tmp/kmart-resi-run.json` (Jul 19 direct undici dry `place_order`).

## Hyper rules we must not violate

| Rule (Hyper getting-started / TLS docs) | Tip today | Status |
|---|---|---|
| Same TLS fingerprint **entire session** | tls BM → **undici PDP** → parked tls api | **Violates** — intentional hybrid after keep-tls Ghosted PDP |
| Max **3** sensor posts; stop on `~0~` | Was `sensorRounds=5` + rebind ladder | **Fixed → 3** primary rounds; rebind only if unsolved |
| Script body only on round 1; `context` after | Implemented | OK |
| TLS client = browser impersonation (`tls-client`) | `tls-worker` `chrome_131` | OK for BM; Hyper examples now cite **Chrome133** — we only have up to `chrome_131` / `chrome_116_PSK_PQ` in node-tls-client |
| Same UA / IP / accept-language / cookie jar | Held | OK |
| SBSD when `?v=` present | Home + PDP SBSD | OK (order differs — see below) |

Hyper recommended order (docs): page GET → SBSD → sensors → protected action.  
Our HTTP lane: home GET → sensors → SBSD → PDP. Green undici used that order successfully on direct.

## What the slim HAR shows (real browser)

`public/kmart-slim.har` (241 entries):

- Continuous Chrome session (HTTP/2) — sensors, get-token, category, GraphQL interleaved
- First GraphQL `getMyActiveCart` **200** with rich marketing cookies + BM cookies
- get-token appears **early**, not only after a clean PDP HTML fetch
- No JA3 split — one browser for WWW + `api.kmart.com.au`

## Green HTTP artifact (Jul 19)

`/tmp/kmart-resi-run.json`:

- **undici only**, `explicitProxy=false`, Fly IP `89.187.186.9`
- `akamai_solved` in 3 rounds → first PDP HTML OK → get-token → **cart_get JSON 200** → dry place_order
- Same header profile keys as tonight’s ISP fails

That egress SoftBlocks BM tonight (undici and tls). Direct “always clears Akamai” was that IP + undici, not magic in the adapter.

## Live tip `81d5acb` (park) — one probe

| Step | Result |
|---|---|
| `sensor_tls_handoff` + sensors | `akamai_solved` rounds=3 |
| `sensor_tls_park` | undici PDP; tls parked |
| `pdp_get` / `#2` | Ghost then **HTML OK** |
| `api_tls_handoff` | **reuse parked sensor** |
| `api_get_token` | 200 |
| `cart_get` | **all profiles AkamaiGHost** |

So #78 restored the d167b78 ladder and confirmed reuse ≠ GraphQL clear.

## Experiments that already falsified levers

| Experiment | Result |
|---|---|
| Keep tls for PDP after solve (`5dc0cee`) | PDP#1–#3 Ghost — regression |
| Fresh api tls-worker after undici PDP | get-token OK, GraphQL Ghost |
| Parked sensor tls for api | get-token OK, GraphQL Ghost |
| ISP undici BM (no sensor tls) | SoftBlock plateau |
| Direct undici / tls BM on Fly IP | SoftBlock plateau |
| Playwright `kmartMode=playwright` + ISP on Fly | WWW `ERR_HTTP_RESPONSE_CODE_FAILURE` (headless Chrome edge-deny) |
| Local tls-client home→PDP **without** sensors (chrome_131 / PSK_PQ) | home 200, **PDP 403 Ghost** |

## Capture tooling

```bash
# Real Chromium HAR via ISP (no Hyper) — needs browsers installed
cd executor && npx playwright install chromium
PROXY_LINE='host:port:user:pass' OUT=/tmp/kmart-browser.har node scripts/capture-kmart-har.mjs

# Diff a debugTrace run against slim HAR
node --max-old-space-size=4096 executor/scripts/har-diff.mjs public/kmart-slim.har --json path/to/run.json
```

Fly already ships Playwright+Chrome in the executor image; phone smoke can pass
`"kmartMode":"playwright"` once ISP exits allow headed/headless Chrome (tonight they do not).

## What to try next (priority)

1. **Stop claiming TLS mix is Hyper-correct** — either full chrome TLS session that can fetch PDP (needs different profile/proxy), or accept hybrid and treat GraphQL as a separate trust wall.
2. **Sticky AU residential / mobile** for Playwright lane (Hyper + real Chrome TLS) — static ISP list hard-denies PW at WWW tonight.
3. Upgrade tls-client when **Chrome133+** identifiers ship; try `chrome_116_PSK_PQ` only behind a knob (home OK, bare PDP still Ghost without sensors).
4. Score bank / milestones / `cart_get` JSON — not smoke `fail_N` alone.

## Bottom line

Previous clears were **one client + trusted egress**. Hyper agrees. Tonight ISP + Hyper sensors still mint `_abck`, undici still fetches PDP HTML, and GraphQL still Ghost-denies on the same jar — that is past header-profile exhaustion (see `KMART_REGRESSION_FORENSICS.md` §GraphQL). Park reuse was the correct next step vs fresh worker; it did not clear GraphQL. Next wins are egress class (sticky resi/mobile) or a true single-TLS browser lane that can open PDP, not more SoftBlock polling on Fly direct.
