#!/usr/bin/env bash
# Advisory direct (no proxy) Kmart dry-run probe for cart_get JSON 200.
# Deploy workflow runs this with continue-on-error — do not treat exit≠0 as a
# merge blocker. Prefer milestone logging (GET /milestones, kmartMilestone logs)
# over fail-closed gates on an intermittent path that already reaches 3DS.
#
# Usage:
#   EXECUTOR_URL=https://j1ms-bot-executor.fly.dev \
#   EXECUTOR_TOKEN=... \
#   ./executor/scripts/direct-cart-gate.sh
#
# Exit codes:
#   0 — cart_get JSON 200 (pass)
#   2 — GraphQL / cart Access Denied or empty 502
#   3 — Akamai sensor never solved after retries
#   1 — usage / transport error

set -euo pipefail

ORIGIN="${EXECUTOR_URL:-}"
TOKEN="${EXECUTOR_TOKEN:-}"
STORE_URL="${GATE_STORE_URL:-https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/}"
MAX_ATTEMPTS="${GATE_ATTEMPTS:-3}"

if [[ -z "$ORIGIN" || -z "$TOKEN" ]]; then
  echo "::error::EXECUTOR_URL and EXECUTOR_TOKEN required"
  exit 1
fi

ORIGIN=$(python3 -c 'import os; from urllib.parse import urlparse; u=os.environ["EXECUTOR_URL"].strip(); p=urlparse(u if "://" in u else "https://"+u); print(f"{p.scheme}://{p.netloc}")')

echo "Direct cart gate → $ORIGIN (attempts=$MAX_ATTEMPTS)"

hard_fail=0
sensor_flake=0

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  task_id="direct-gate-$(date +%s)-$attempt"
  echo "── attempt $attempt taskId=$task_id"
  tmp=$(mktemp)
  set +e
  http_code=$(curl -sS -o "$tmp" -w "%{http_code}" \
    -X POST "$ORIGIN/run" \
    -H "authorization: Bearer $TOKEN" \
    -H "content-type: application/json" \
    --max-time 180 \
    -d "{\"taskId\":\"$task_id\",\"storeUrl\":\"$STORE_URL\",\"variantId\":1,\"qty\":1,\"dryRun\":true}")
  curl_rc=$?
  set -e

  if [[ $curl_rc -ne 0 ]] || [[ "$http_code" == "502" ]] || [[ "$http_code" == "000" ]]; then
    echo "::error::empty/bad HTTP ${http_code:-curl_$curl_rc} — executor crashed or unreachable (HARD FAIL)"
    rm -f "$tmp"
    exit 2
  fi

  set +e
  python3 - "$tmp" "$http_code" <<'PY'
import json, sys
path, http = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path))
except Exception as e:
    print(f"RESULT=parse_error http={http} err={e}")
    sys.exit(10)

steps = d.get("steps") or []
fs = d.get("failedStep")
ok = d.get("ok")

cart = next((s for s in steps if s.get("step") == "cart_get"), None)
body_full = next((s for s in steps if s.get("step") == "cart_get_body_full"), None)
note = str((cart or {}).get("note") or "")
body_note = str((body_full or {}).get("note") or "")
denied = "Access Denied" in body_note or "AkamaiGHost" in body_note or "all_denied" in note
cart_ok = bool(
    cart
    and cart.get("ok")
    and (cart.get("status") or 0) == 200
    and not denied
)

unsolved = any(str(s.get("step") or "") == "akamai_unsolved" for s in steps)
gql_deny = fs == "gql_deny" or any(str(s.get("step") or "") == "cart_get:all_profiles_denied" for s in steps)

print(f"http={http} ok={ok} failedStep={fs} nsteps={len(steps)} cart_ok={cart_ok} unsolved={unsolved} gql_deny={gql_deny}")
if cart:
    print(f"cart_get status={cart.get('status')} ok={cart.get('ok')} note={note[:160]}")

if cart_ok:
    print("RESULT=pass")
    sys.exit(0)
if len(steps) == 0 and int(http) >= 500:
    print("RESULT=hard_fail_empty")
    sys.exit(2)
if gql_deny or denied or fs == "gql_deny":
    print("RESULT=hard_fail_gql_deny")
    sys.exit(2)
if unsolved or fs == "akamai_unsolved":
    print("RESULT=sensor_flake")
    sys.exit(3)
print("RESULT=other_fail")
sys.exit(2)
PY
  rc=$?
  set -e
  rm -f "$tmp"

  if [[ $rc -eq 0 ]]; then
    echo "✅ Direct cart gate PASS (cart_get JSON 200)"
    exit 0
  fi
  if [[ $rc -eq 3 ]]; then
    echo "⚠️ Akamai sensor unsolved (attempt $attempt/$MAX_ATTEMPTS) — retrying"
    sensor_flake=1
    sleep 4
    continue
  fi
  echo "::error::Direct baseline LOST (GraphQL deny / crash / unexpected). Stop ISP tips; restore green direct."
  exit 2
done

if [[ $sensor_flake -eq 1 ]]; then
  echo "::error::Direct gate: Akamai sensor never solved after $MAX_ATTEMPTS attempts — fail closed (cannot prove cart_get)"
  exit 3
fi
exit 2
