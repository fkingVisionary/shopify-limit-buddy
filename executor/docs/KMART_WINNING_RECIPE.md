# Kmart bulletproof recipe (LOCK)

**Bank-confirmed tip:** Fly `gitSha` **`9a7e895`** / undici one-client (#81+#82)  
**Proof run:** GitHub Actions `29790423175` · task `smoke-isp-20260721-002925`  
**Bank:** Revolut 3DS push · **2026-07-21 ~00:30–00:31 UTC**  
**Cart:** SKU `43722280` · $20.00 · ISP exit `45.42.47.235` · `file:resi.proxies`

Score order of truth: **bank/Revolut → Fly milestones → `/run` JSON → smoke ladder.**  
Client timeout or `paydock_3ds_process:false` does **not** mean cart dead if Revolut fired.

---

## Locked runtime (do not “improve” without a new bank proof)

| Knob | Locked value | Notes |
|------|----------------|------|
| Engine | Fly `j1ms-bot-executor` only | Lovable/UI is control plane only |
| Transport | **undici** end-to-end | WWW + Hyper sensors + api GraphQL |
| `sensorTls` | **OFF** | Opt-in only — park/handoff Ghosted GraphQL |
| `apiTls` | **OFF** | Same |
| Proxy | `useProxy:true` → `executor/resi.proxies` | Static AU ISP list |
| Dead pools | refused | WealthProxies / IPFist / “Test Pool” |
| Category | either | skip or browse both cleared on undici |
| Hyper | ≤3 rounds, stop on `ind=0` | No SoftBlock-poll loops |
| Card | `KMART_CARD_*` or task.card | Required for 3DS / bank |
| Monitor | **off** | Never burn ISP on a timer |

**Forbidden on the charge path (until a new tip beats this bank proof):**

- Defaulting `sensorTls` / `apiTls` on  
- Mid-run JA3 switches (tls-worker park → undici PDP → tls api)  
- Treating Fly direct SoftBlock as “Akamai moved”  
- Fail-closed deploy gates that block ship on sensor flake  
- SoftBlock-polling the same egress for hours  

---

## Pass ladder (this tip)

```
akamai_solved → pdp HTML → api_get_token → cart_get JSON
  → cart_atc → checkout address/billing → paydock_tokenize
  → create_3ds_token → (Revolut / ACS) → place_order
```

Proven on `29790423175`:

| Step | Result |
|------|--------|
| undici + ISP | no `sensor_tls_*` / `api_tls_*` |
| `cart_get` | JSON 200 |
| `cart_atc` | sku in cart, $20 |
| `create_3ds_token` | `charge_3ds_id=f31c879c-…` |
| Canvas3ds | challenge started → **Revolut push** |
| Widget | later `chargeAuthReject` — bank already pinged |
| `place_order` | skipped in bot after reject — **not** the score |

---

## Smoke (phone)

1. Confirm `/health` `gitSha` includes this recipe tip (or later **only** if bank-proven).  
2. Actions → **Smoke executor** → Run  
   - `skip_direct`: **on** (default)  
   - `with_card`: **on** for bank proof  
   - `place_order`: on only when you intend a real submit  
3. Artifacts → read `verdict` / `wall` / `ladderCleared` / `paymentSummary`  
4. If Revolut fired: **win**, even if wall=`paydock_3ds_process`

```bash
# Local one-shot (same knobs)
SMOKE_USE_PROXY=1 ./executor/scripts/fly-probe-once.sh
```

---

## Phases (harden → Electron → speed)

Do **not** reorder. Each phase needs a smoke (and bank proof when touching payment).

### Phase 0 — Freeze (now)

- [x] Undici one-client defaults (#81)  
- [x] Smoke YAML valid (#82)  
- [x] Bank proof on ISP (`29790423175`)  
- [ ] Tag / note tip `9a7e895` as charge baseline in deploy notes  
- [ ] No feature PRs that touch `kmart.js` transport/sensor/apiTls without an ISP smoke first  

### Phase 1 — Harden without breaking (next)

Order matters; stop if ISP `cart_get` regresses.

1. **ACS / Canvas3ds completion** after challenge (Revolut push already works)  
   - Prefer completing challenge so `paydock_3ds_process` + `place_order` succeed in-bot  
   - Hint already says prefer no-proxy for widget if cart cleared — try that first  
2. **Smoke scoring** — treat `reached3ds` + `create_3ds_token` as charge-path pass when card on  
3. **Jar SoftBlock protect** — keep refuse `_abck` demotion (already in `http.js`)  
4. **Profile/card from UI** — stop relying only on `KMART_CARD_*` secrets for desktop later  
5. **No TLS experiments on `main`** — branch + explicit `sensorTls:true` only  

### Phase 2 — Electron / desktop

- Point desktop sidecar at **same Fly tip** (or ship identical undici defaults)  
- Do **not** reintroduce Playwright as default Kmart lane  
- Local executor only if Fly tip SHA matches recipe  
- Prove one desktop→Fly ISP run to `create_3ds_token` before any desktop “optimizations”

### Phase 3 — Speed (only after Phase 1 bank-complete order)

- Trim sleeps that are not Hyper-required  
- Parallelize only non-BM work (never parallelize sensor rounds)  
- Keep sticky exit for full checkout duration  
- Measure: warm→cart_get, cart→3ds, 3ds→order — change one at a time  

---

## Rollback

If a tip loses `cart_get` JSON on ISP smoke:

1. Redeploy tip **`56abec1`** (#81 undici defaults) or **`9a7e895`** (this recipe + smoke fix)  
2. Do not “fix” with tls handoff  
3. One ISP smoke with card; score Revolut / milestones  

---

## Related

- `HYPER_HAR_ALIGNMENT.md` — why tls park failed / undici cleared  
- `KMART_REGRESSION_FORENSICS.md` — historical spirals  
- `CHECKOUT_HANDOFF.md` — task contract / profile fields  
