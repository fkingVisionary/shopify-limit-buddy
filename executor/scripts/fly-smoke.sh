#!/usr/bin/env bash
# Full-ladder Fly smoke (advisory). Uses EXECUTOR_TOKEN from env / GH secrets.
# Scores furthest stage — not only failedStep / client timeout.
#
# Usage:
#   EXECUTOR_URL=https://j1ms-bot-executor.fly.dev \
#   EXECUTOR_TOKEN=... \
#   ./executor/scripts/fly-smoke.sh
#
# Optional:
#   SMOKE_USE_PROXY=1     — ISP pool (resi.proxies)
#   SMOKE_WITH_CARD=1     — inject card from KMART_CARD_* if set (may 3DS)
#   SMOKE_PLACE_ORDER=1   — real placeOrder (requires card)
#   SMOKE_OUT_DIR=/tmp/fly-smoke
#   SMOKE_STORE_URL=...
#   SMOKE_TIMEOUT=240

set -euo pipefail

ORIGIN="${EXECUTOR_URL:-https://j1ms-bot-executor.fly.dev}"
TOKEN="${EXECUTOR_TOKEN:-}"
STORE_URL="${SMOKE_STORE_URL:-https://www.kmart.com.au/product/31-piece-make-it-real:-juicy-couture-diy-floaty-pens-43722280/}"
OUT_DIR="${SMOKE_OUT_DIR:-/tmp/fly-smoke}"
TIMEOUT="${SMOKE_TIMEOUT:-240}"
USE_PROXY="${SMOKE_USE_PROXY:-0}"
WITH_CARD="${SMOKE_WITH_CARD:-0}"
PLACE_ORDER="${SMOKE_PLACE_ORDER:-0}"

if [[ -z "$TOKEN" ]]; then
  echo "::error::EXECUTOR_TOKEN required"
  exit 1
fi

ORIGIN=$(EXECUTOR_URL="$ORIGIN" python3 -c 'import os; from urllib.parse import urlparse; u=os.environ["EXECUTOR_URL"].strip(); p=urlparse(u if "://" in u else "https://"+u); print(f"{p.scheme}://{p.netloc}")')
mkdir -p "$OUT_DIR"

TS=$(date -u +%Y%m%d-%H%M%S)
MODE="direct"
[[ "$USE_PROXY" == "1" ]] && MODE="isp"
TASK="smoke-${MODE}-${TS}"
OUT_JSON="$OUT_DIR/${TASK}.json"
SUMMARY="$OUT_DIR/${TASK}.summary.json"

echo "Fly smoke → $ORIGIN mode=$MODE taskId=$TASK timeout=${TIMEOUT}s"

# Build body via python so card injection stays out of shell history.
BODY=$(
  STORE_URL="$STORE_URL" TASK="$TASK" USE_PROXY="$USE_PROXY" \
  WITH_CARD="$WITH_CARD" PLACE_ORDER="$PLACE_ORDER" \
  KMART_CARD_NUMBER="${KMART_CARD_NUMBER:-}" \
  KMART_CARD_CVV="${KMART_CARD_CVV:-}" \
  KMART_CARD_EXPIRY_MONTH="${KMART_CARD_EXPIRY_MONTH:-}" \
  KMART_CARD_EXPIRY_YEAR="${KMART_CARD_EXPIRY_YEAR:-}" \
  KMART_CARD_HOLDER="${KMART_CARD_HOLDER:-}" \
  python3 - <<'PY'
import json, os
place = os.environ.get("PLACE_ORDER") == "1"
with_card = os.environ.get("WITH_CARD") == "1" or place
body = {
  "taskId": os.environ["TASK"],
  "storeUrl": os.environ["STORE_URL"],
  "variantId": 1,
  "qty": 1,
  "dryRun": not place,
  "placeOrder": place,
}
if os.environ.get("USE_PROXY") == "1":
  body["useProxy"] = True
if with_card:
  number = os.environ.get("KMART_CARD_NUMBER", "").strip()
  cvv = os.environ.get("KMART_CARD_CVV", "").strip()
  mm = os.environ.get("KMART_CARD_EXPIRY_MONTH", "").strip()
  yy = os.environ.get("KMART_CARD_EXPIRY_YEAR", "").strip()
  holder = os.environ.get("KMART_CARD_HOLDER", "").strip()
  if number and cvv and mm and yy:
    body["card"] = {
      "number": number,
      "cvv": cvv,
      "expMonth": mm,
      "expYear": yy,
      "holder": holder or "Test User",
    }
    print("card=injected", file=__import__("sys").stderr, flush=True)
  else:
    print("card=missing_env", file=__import__("sys").stderr, flush=True)
print(json.dumps(body))
PY
)
JSON_BODY="$BODY"

set +e
HTTP=$(curl -sS -o "$OUT_JSON" -w "%{http_code}" \
  -X POST "$ORIGIN/run" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --max-time "$TIMEOUT" \
  -d "$JSON_BODY")
CURL_RC=$?
set -e

# Always try milestones (Fly may still be in 3DS after client timeout).
MILE_JSON="$OUT_DIR/${TASK}.milestones.json"
curl -sS -o "$MILE_JSON" \
  -H "authorization: Bearer $TOKEN" \
  "$ORIGIN/milestones?taskId=$TASK&limit=30&minStage=cart_get" || true

python3 - "$OUT_JSON" "$MILE_JSON" "$SUMMARY" "$HTTP" "$CURL_RC" "$TASK" "$MODE" <<'PY'
import json, sys
from pathlib import Path

out_path, mile_path, summary_path, http, curl_rc, task, mode = sys.argv[1:8]
http = int(http or 0)
curl_rc = int(curl_rc or 0)

data = {}
parse_err = None
try:
    raw = Path(out_path).read_text()
    if raw.strip():
        data = json.loads(raw)
except Exception as e:
    parse_err = str(e)

miles = {}
try:
    miles = json.loads(Path(mile_path).read_text())
except Exception:
    miles = {}

steps = data.get("steps") or []
by = {s.get("step"): s for s in steps if isinstance(s, dict)}

def step_ok(name):
    s = by.get(name)
    if not s:
        return False
    if s.get("ok") is False:
        return False
    st = s.get("status")
    if st is not None and st >= 400:
        return False
    note = str(s.get("note") or "")
    if "all_denied" in note or "Access Denied" in note or "AkamaiGHost" in note:
        return False
    return True

def pdp_ok():
    # First pdp_get often Ghost-denies on ISP; pdp_get#2 after SBSD is the real pass.
    import re
    for s in steps:
        if not isinstance(s, dict):
            continue
        st = str(s.get("step") or "")
        if not (st == "pdp_get" or st.startswith("pdp_get#")):
            continue
        if s.get("ok") is False:
            continue
        note = str(s.get("note") or "")
        if "Access Denied" in note or "AkamaiGHost" in note:
            continue
        if "| ok " in note or "DOCTYPE" in note or "text/html; charset" in note:
            return True
        m = re.search(r"\b(\d+)b\b", note)
        if m and int(m.group(1)) > 50_000:
            return True
    return False

ladder = [
    ("akamai_solved", step_ok("akamai_solved")),
    ("pdp_get", pdp_ok()),
    ("api_get_token", step_ok("api_get_token")),
    ("cart_get", step_ok("cart_get")),
    ("cart_atc", step_ok("cart_atc")),
    ("checkout_set_address", step_ok("checkout_set_address")),
    ("paydock_tokenize", step_ok("paydock_tokenize")),
    ("create_3ds_token", step_ok("create_3ds_token")),
    ("paydock_3ds_process", step_ok("paydock_3ds_process")),
    ("place_order", step_ok("place_order") and "skipped" not in str((by.get("place_order") or {}).get("note") or "")),
]

rank = {
    "cart_get": 10,
    "cart_atc": 20,
    "checkout": 30,
    "tokenize": 40,
    "3ds": 50,
    "place_order": 60,
    "ordered": 70,
}

stage = data.get("checkoutStage")
if data.get("orderNumber"):
    stage = "ordered"
elif step_ok("paydock_3ds_process") or step_ok("create_3ds_token"):
    stage = stage or "3ds"
elif step_ok("paydock_tokenize"):
    stage = stage or "tokenize"
elif step_ok("checkout_set_address"):
    stage = stage or "checkout"
elif step_ok("cart_atc"):
    stage = stage or "cart_atc"
elif step_ok("cart_get"):
    stage = stage or "cart_get"

mile_rows = miles.get("milestones") if isinstance(miles, dict) else None
best_mile = None
if isinstance(mile_rows, list) and mile_rows:
    best_mile = mile_rows[0]
    for r in mile_rows:
        if (rank.get(str(r.get("stage")), 0) > rank.get(str((best_mile or {}).get("stage")), 0)):
            best_mile = r

reached3ds = bool(
    (best_mile or {}).get("reached3ds")
    or (data.get("milestone") or {}).get("reached3ds")
    or stage in ("3ds", "place_order", "ordered")
    or any(str(s.get("step") or "").startswith(("paydock_3ds", "create_3ds")) for s in steps)
)

ip = (by.get("resolve_ip") or {}).get("note")
summary = {
    "taskId": task,
    "mode": mode,
    "http": http,
    "curlRc": curl_rc,
    "parseError": parse_err,
    "ok": data.get("ok"),
    "failedStep": data.get("failedStep"),
    "checkoutStage": data.get("checkoutStage"),
    "furthestStage": stage,
    "reached3ds": reached3ds,
    "orderNumber": data.get("orderNumber"),
    "paymentStatus": data.get("paymentStatus"),
    "transport": data.get("transport"),
    "gitSha": data.get("gitSha") or miles.get("gitSha"),
    "proxySource": data.get("proxySource"),
    "resolveIp": ip,
    "elapsedMs": data.get("elapsedMs"),
    "nsteps": len(steps),
    "ladder": {k: v for k, v in ladder},
    "milestoneBest": best_mile,
    "paymentSummary": data.get("paymentSummary"),
    "timedOut": curl_rc != 0 or http in (0, 524),
}

Path(summary_path).write_text(json.dumps(summary, indent=2) + "\n")

print(f"http={http} curl={curl_rc} ok={summary['ok']} failedStep={summary['failedStep']}")
print(f"furthest={stage} reached3ds={reached3ds} ip={ip} transport={summary['transport']} gitSha={str(summary.get('gitSha') or '')[:12]}")
print("ladder " + " ".join(f"{k}={'OK' if v else 'NO'}" for k, v in ladder))
if best_mile:
    print(f"milestone stage={best_mile.get('stage')} reached3ds={best_mile.get('reached3ds')} live={best_mile.get('live')}")
if summary.get("paymentSummary"):
    ps = summary["paymentSummary"]
    print(
        "payment",
        {k: ps.get(k) for k in ("card", "oneTimeToken", "acsAttempted", "acsOk", "placeOrder", "orderNumber", "paymentStatus")},
    )
print(f"wrote {summary_path}")

# Exit: 0 if cart_get OK (baseline green). Higher stages are bonus.
if summary["timedOut"] and reached3ds:
    print("RESULT=timeout_but_3ds")
    sys.exit(0)
if step_ok("cart_get"):
    print("RESULT=pass_cart_get")
    sys.exit(0)
if any(str(s.get("step")) == "akamai_unsolved" for s in steps) or summary["failedStep"] == "akamai_unsolved":
    print("RESULT=sensor_flake")
    sys.exit(3)
print("RESULT=fail")
sys.exit(2)
PY
