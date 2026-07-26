#!/usr/bin/env bash
# Exactly ONE Fly /run. No retries. No loops.
#
# Usage:
#   EXECUTOR_TOKEN=... ./executor/scripts/fly-probe-once.sh
#   EXECUTOR_TOKEN=... SMOKE_USE_PROXY=1 ./executor/scripts/fly-probe-once.sh
#   EXECUTOR_TOKEN=... API_TLS=1 SMOKE_USE_PROXY=1 ./executor/scripts/fly-probe-once.sh
#
# Env:
#   EXECUTOR_URL      default https://j1ms-bot-executor.fly.dev
#   SMOKE_USE_PROXY=1 ISP pool (resi.proxies)
#   API_TLS=1|0       force apiTls true/false (omit = executor default)
#   SMOKE_STORE_URL   product URL
#   SMOKE_OUT_DIR     default /tmp/fly-probe
#   SMOKE_TIMEOUT     default 240

set -euo pipefail
export SMOKE_OUT_DIR="${SMOKE_OUT_DIR:-/tmp/fly-probe}"
export SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-240}"

# Optional apiTls override via body — fly-smoke.sh does not send it yet,
# so build a one-shot here.
ORIGIN="${EXECUTOR_URL:-https://j1ms-bot-executor.fly.dev}"
TOKEN="${EXECUTOR_TOKEN:-}"
STORE_URL="${SMOKE_STORE_URL:-https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/}"
USE_PROXY="${SMOKE_USE_PROXY:-0}"
TIMEOUT="${SMOKE_TIMEOUT:-240}"
OUT_DIR="${SMOKE_OUT_DIR}"

if [[ -z "$TOKEN" ]]; then
  echo "::error::EXECUTOR_TOKEN required"
  exit 1
fi

ORIGIN=$(EXECUTOR_URL="$ORIGIN" python3 -c 'import os; from urllib.parse import urlparse; u=os.environ["EXECUTOR_URL"].strip(); p=urlparse(u if "://" in u else "https://"+u); print(f"{p.scheme}://{p.netloc}")')
mkdir -p "$OUT_DIR"

MODE="direct"
[[ "$USE_PROXY" == "1" ]] && MODE="isp"
TASK="probe-once-${MODE}-$(date -u +%Y%m%d-%H%M%S)"
OUT_JSON="$OUT_DIR/${TASK}.json"
SUMMARY="$OUT_DIR/${TASK}.summary.json"

BODY=$(
  STORE_URL="$STORE_URL" TASK="$TASK" USE_PROXY="$USE_PROXY" \
  API_TLS="${API_TLS:-}" \
  python3 - <<'PY'
import json, os
body = {
  "taskId": os.environ["TASK"],
  "storeUrl": os.environ["STORE_URL"],
  "variantId": 1,
  "qty": 1,
  "dryRun": True,
}
if os.environ.get("USE_PROXY") == "1":
  body["useProxy"] = True
api = os.environ.get("API_TLS", "").strip()
if api == "1":
  body["apiTls"] = True
elif api == "0":
  body["apiTls"] = False
print(json.dumps(body))
PY
)

echo "ONE shot → $ORIGIN mode=$MODE taskId=$TASK apiTls=${API_TLS:-default}"
set +e
HTTP=$(curl -sS -o "$OUT_JSON" -w "%{http_code}" \
  -X POST "$ORIGIN/run" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --max-time "$TIMEOUT" \
  -d "$BODY")
CURL_RC=$?
set -e

MILE_JSON="$OUT_DIR/${TASK}.milestones.json"
curl -sS -o "$MILE_JSON" \
  -H "authorization: Bearer $TOKEN" \
  "$ORIGIN/milestones?taskId=$TASK&limit=20&minStage=cart_get" || true

python3 - "$OUT_JSON" "$MILE_JSON" "$SUMMARY" "$HTTP" "$CURL_RC" "$TASK" "$MODE" <<'PY'
import json, sys
from pathlib import Path
out_path, mile_path, summary_path, http, curl_rc, task, mode = sys.argv[1:8]
http, curl_rc = int(http or 0), int(curl_rc or 0)
data = {}
try:
    raw = Path(out_path).read_text()
    if raw.strip():
        data = json.loads(raw)
except Exception as e:
    data = {"parseError": str(e)}
steps = data.get("steps") or []
by = {s.get("step"): s for s in steps}

def ok(name):
    s = by.get(name)
    if not s:
        return False
    note = str(s.get("note") or "")
    if "all_denied" in note or "Access Denied" in note:
        return False
    if s.get("ok") is False:
        return False
    st = s.get("status")
    if st is not None and st >= 400:
        return False
    return True

ladder = {
    "akamai_solved": ok("akamai_solved"),
    "api_tls_handoff": ok("api_tls_handoff") if "api_tls_handoff" in by else None,
    "pdp_get": ok("pdp_get"),
    "api_get_token": ok("api_get_token"),
    "cart_get": ok("cart_get"),
    "cart_atc": ok("cart_atc"),
    "checkout_set_address": ok("checkout_set_address"),
}
handoff = by.get("api_tls_handoff")
summary = {
    "taskId": task,
    "mode": mode,
    "http": http,
    "curlRc": curl_rc,
    "ok": data.get("ok"),
    "failedStep": data.get("failedStep"),
    "checkoutStage": data.get("checkoutStage"),
    "resolveIp": (by.get("resolve_ip") or {}).get("note"),
    "transport": data.get("transport"),
    "gitSha": data.get("gitSha"),
    "elapsedMs": data.get("elapsedMs"),
    "ladder": ladder,
    "apiTlsHandoff": (handoff or {}).get("note") if handoff else None,
    "cartNote": str((by.get("cart_get") or {}).get("note") or "")[:160],
}
Path(summary_path).write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
if ladder.get("cart_get"):
    sys.exit(0)
if data.get("failedStep") == "akamai_unsolved":
    sys.exit(3)
sys.exit(2)
PY
