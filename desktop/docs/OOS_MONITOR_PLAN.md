# Plan: OOS labeling + restock monitor (Electron)

**Goal:** Show OOS when checkout naturally finds no stock; keep the task armed;
poll with the **task’s own proxies**; when stock returns, fire one full checkout.
**Non-goal:** Do not put a stock poll in front of the charge path. Do not enable
Fly `MONITOR_ENABLE` or any co-located timer on the executor process.

**Charge path stays:** undici one-client bible (`executor/docs/KMART_WINNING_RECIPE.md`).
Monitor is a **desktop control-plane loop** that *calls* `/run`; it is not inside
`kmart.js` BM/GraphQL.

---

## Do we need Electron to build/test?

| Piece | Where it lives | Can test without Electron? |
|-------|----------------|----------------------------|
| **A. OOS labeling** | Executor result → UI maps status | **Yes** — Fly `/run` or local sidecar curl; assert `failedStep` / new `stockStatus` |
| **B. Monitor loop** | Desktop (task state machine + poller) | **Needs Electron (or desktop main process)** for real UX; poller logic can be unit-tested in Node |
| **C. In-stock → checkout** | Desktop calls sidecar `/run` | **Needs desktop + local sidecar** (same as normal Run) |

**Practical sequence for you at home:**

1. Prove **A** on Fly smoke / local sidecar (no Electron required).  
2. Build **B+C** in `desktop/` — that’s where settings, task idle, and proxy-per-task already are.  
3. E2E: Electron → Start engine → monitor task → OOS → ping → checkout.

Web/Lovable is **not** the monitor host (no long-lived poller). Fly must **not**
host the poller (burned ISP last time).

---

## Intended user flow

```
User starts Kmart task (monitor enabled)
  → Full checkout attempt (same /run as today)
  → In stock path: ATC → … → 3DS (unchanged, no pre-check)
  → OOS path: natural fail at PDP/ATC → status=oos, task ARMED
  → While armed: poll stock on task proxies (interval + cooldown from Settings)
  → Ping says available → one /run checkout
  → Success → done | OOS again → armed again | User stop → end
```

First attempt is a **real checkout**, not a lightweight probe. Time-to-cart on
in-stock runs is unaffected.

---

## Phase 0 — Spec lock (no behavior change)

- [ ] Agree signals that mean OOS (see Phase 1).  
- [ ] Agree monitor never sets `MONITOR_ENABLE` on Fly.  
- [ ] Settings fields: `monitorPollMs`, `monitorCooldownMs` (desktop store only).  
- [ ] Task fields: `monitor: boolean`, `monitorArmed: boolean` (local store).  

**Exit:** Short checklist in this doc signed off; no PR to `kmart.js` yet.

---

## Phase 1 — OOS labeling only (executor + UI map)

**Change surface (minimal):**

- In `executor/adapters/kmart.js` (or checkout result shaping): when ATC/PDP/cart
  already failed for stock reasons, set an explicit field e.g.
  `stockStatus: "oos" | "unknown" | "ok"` and/or `failedStep` that UI can trust.
- Prefer **classifying existing failure notes** over new HTTP.
- Desktop Results: show **OOS** (not generic failed) when `stockStatus=oos`.

**Do not:**

- Add a stock GET before `warm_home`.  
- Change undici / sensor / GraphQL defaults.  

**Test (no Electron):**

```bash
# Local sidecar or Fly /run with a known OOS Kmart URL + task.proxy
# Expect: ok=false, stockStatus=oos (or agreed signal), no sensorTls handoff
```

**Exit:** One OOS SKU and one in-stock SKU both classified correctly; in-stock
ladder still reaches `cart_get` / further on ISP.

---

## Phase 2 — Desktop monitor loop (armed idle)

**Change surface:**

- `desktop/` Settings: poll interval + cooldown.  
- Task: “Monitor restock” toggle.  
- After Phase‑1 OOS on a monitor task → `monitorArmed=true`, task stays running/idle.  
- Poller module (e.g. `desktop/monitor-loop.cjs`):  
  - Uses **current task proxy entry only**  
  - Lightweight stock check (dedicated small request **or** reuse a future
    `POST /stock-check` on sidecar — **not** full checkout)  
  - Respects poll + cooldown  
  - User Stop clears armed + cancels timer  

**Do not:**

- Poll from Fly.  
- Use `resi.proxies` file as the monitor pool when task has its own proxy.  
- Auto-fire checkout in this phase (ping → log “would checkout” only is OK for first PR).  

**Test (Electron):**

1. `cd desktop && npm start` → Start engine.  
2. Monitor task + OOS URL + user proxy.  
3. Run → see OOS → armed.  
4. Logs show polls on interval; cooldown after each ping.  

**Exit:** Armed idle stable for 10+ minutes without touching charge-path code.

---

## Phase 3 — In-stock ping → one `/run`

**Change surface:**

- On positive stock ping: call existing `job-runner` / `sidecar.runTask` once
  (same payload builder: task proxy + profile card).  
- If OOS again → re-arm. If success → clear monitor.  
- Cap concurrent checkouts (desktop already serializes jobs — keep that).  

**Test (Electron + real/low-risk SKU):**

- Prefer a SKU you can toggle or a rare restock; or mock stock-check in dev.  
- Prove: ping → full undici checkout starts → stages in Results.  

**Exit:** One end-to-end restock fire without regressing a normal non-monitor Run.

---

## Phase 4 — Harden (only after 1–3)

- Discord/webhook on armed→fire (optional).  
- Jitter on poll to avoid sync stampedes.  
- Document in Kmart bible: “monitor is desktop-only”.  
- Never ship `MONITOR_ENABLE=1` on Fly deploy workflow.  

---

## Stock-check vs checkout (important)

| | Full `/run` checkout | Monitor stock ping |
|--|----------------------|--------------------|
| When | User Run, or monitor fire | Armed idle only |
| Cost | Hyper sensors + GraphQL + … | Must stay cheap |
| Proxy | Task proxy | Same task proxy |
| Failure OOS | Label + arm if monitor | Stay armed + cooldown |

Phase 2 may start with a **minimal** ping (e.g. PDP availability JSON/HTML
signal through sidecar). If ping design is unclear, stub ping in desktop with a
dev flag before wiring real Kmart stock signal — still no change to happy-path
order of `/run`.

---

## Regression gates (every phase)

1. Non-monitor in-stock task: no new steps before `warm_home`; still clears
   `cart_get` on ISP/local sidecar with task proxy.  
2. `/health` on Fly: `monitorEnabled: false`.  
3. Monitor task Stop: zero further polls.  
4. Bible knobs unchanged (`sensorTls`/`apiTls` off).  

---

## Suggested PR slices

1. `stockStatus` on executor result + desktop OOS badge (Phase 1).  
2. Settings + armed state + poller without auto-checkout (Phase 2).  
3. Ping → `runTask` once (Phase 3).  

One phase per PR. No combined “monitor mega-PR”.

---

## Open decisions (resolve in Phase 0)

1. Exact OOS signals from today’s adapter notes (ATC denied / empty lines / PDP copy).  
2. Stock ping implementation: sidecar `/stock-check` vs desktop-only fetch.  
3. Default poll/cooldown (e.g. 5s poll / 30s cooldown — tune later).  
4. Whether monitor is Kmart-only in v1 (yes — recommend Kmart-only).  
