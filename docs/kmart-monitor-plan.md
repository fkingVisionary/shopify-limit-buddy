# Kmart Global Monitor + Task Monitor Sources + Desktop Feed

Planning doc only — no implementation in this change. Grounded in Cybersole’s
task / Smart Actions model and the current J1m’s Bot desktop + executor layout.

## Goal

Give Kmart (the only active module) a **shared, operator-owned monitor** that
desktop clients can listen to, while keeping **Cyber-style keyword tasks** that
users can also run privately on their own proxies.

Users create **one kind of task**. They choose where the stock signal comes from:

| Monitor source | Who polls | Proxies | Use case |
|---|---|---|---|
| **Private** | That task on the user’s machine | User proxy group | DIY keywords / SKUs you aren’t covering |
| **Global** | Your central Kmart monitor | Your ISP fleet | Your edge — low-ms curated coverage |

Checkout always stays local (desktop → `executor/` sidecar), same as today.

Smart Actions (full trigger/filter/action graphs) stay **out of scope**. The
everyday loop is: task + monitor input + monitor source → in stock → checkout.

---

## Product model (Cyber-aligned)

### Task = monitor input + checkout params

Mirror Cybersole’s task creator, not a separate “automation” product:

- **Store** — Kmart AU (v1 only)
- **Monitor input** — one field, multiple shapes (see syntax below)
- **Monitor source** — `private` | `global`
- **Sizes** — when applicable (often N/A / random for Kmart)
- **Profile**, **proxy group**, **qty**, **task quantity**, **place order**
- **Delays** (later) — monitor / retry / timeout ms

Start the task → it waits for a match + in-stock signal from the chosen source →
runs checkout via the existing executor path.

### Monitor input syntax (from Cybersole docs)

Canonical Cyber form (Shopify-style keyword rules; adopt the same UX):

| Shape | Example | Meaning |
|---|---|---|
| Keywords (AND) | `pokemon,etb` | Title must contain all terms |
| Negatives | `pokemon,etb,-plush,-sock` | Reject if any `-term` appears |
| OR within a slot | `pokemon/pokémon,etb/etb` | `/` = OR inside one comma group |
| PDP URL | `https://www.kmart.com.au/product/…-12345678/` | Skip discovery; watch that product |
| SKU / keycode | `12345678` | Resolve then watch |

Notes:

- Cybersole does **not** require `+` for positives; bare words are positive.
  Accepting optional `+pokemon` in the parser is fine for user habit.
- Keyword monitoring is the “no link yet” path (e.g. Pokémon drop).
- SKU/PDP is the precise restock path.
- Cybersole warns keyword monitoring is the riskiest method — same here.

### Two layers of keywords (do not conflate)

1. **Operator watchlist (global monitor, you only)** — what the central service
   bothers to discover/poll. Not editable by users.
2. **User task filters** — task monitor input. For `global` source, the task
   matches against events *you* already published. For `private` source, the
   task discovers/polls itself with user proxies.

Users never add keywords to the global monitor.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  monitor/  (NEW — same GitHub repo, separate service)     │
│  Operator-owned Kmart watchlist + ISP rotation            │
│  Modes: SKU/PDP restock poll + keyword discovery          │
│  Emits normalized events → feed API (WS/SSE)              │
└─────────────────────────────┬────────────────────────────┘
                              │ events
                              ▼
┌──────────────────────────────────────────────────────────┐
│  desktop/ (Electron)                                       │
│  • Monitor Feed tab — live visual stream of global events │
│  • Tasks — monitorSource private|global                    │
│  • Private monitor loop (user proxies) when source=private │
│  • Global subscriber — match task input → start checkout   │
│  • executor/ sidecar — unchanged checkout engine           │
└──────────────────────────────────────────────────────────┘
```

Keep boundaries hard:

- **`monitor/`** — detect + publish only (no checkout, no profiles, no cards)
- **`desktop/`** — UI, local task state, subscribe/match, dispatch checkout
- **`executor/`** — buy path only (already exists)

Same monorepo, separate service folder — matches `executor/`, `desktop/`,
`runner/` as optional sidecars. Do **not** bake the 24/7 poller into the
Electron renderer or the TanStack web app.

---

## Global monitor service (`monitor/`)

### Ownership

Fully under operator control:

- Curated SKU/PDP list
- Curated discovery keyword queries (e.g. `pokemon`, `tcg`)
- Poll intervals, concurrency, ISP pool
- What gets published to the feed

No user-driven registration into the global poll set (avoids watchlist bloat
and protects the latency edge).

### Event schema (v1 draft)

```ts
type MonitorEvent = {
  id: string;              // unique event id (dedupe client-side)
  store: "kmart";
  type: "new" | "restock" | "oos";  // oos optional later
  title: string;
  url: string;             // PDP
  sku: string;             // keycode when known
  inStock: boolean;
  price?: number;
  currency?: "AUD";
  sizes?: string[];        // if ever relevant
  detectedAt: string;      // ISO
  source: "sku_poll" | "discovery";
};
```

Clients treat the feed as append-only. Deduplicate by `id` or `(sku, type, detectedAt window)`.

### Internal loops

1. **SKU/PDP poller (ship first)**  
   Hot list of known products → availability via whatever stable Kmart path we
   settle on (GraphQL availability / PDP parse — exact adapter TBD in impl).  
   Optimize for **time-to-detect** with cheap rotating **AU ISP** proxies.
   Monitor proxy pool ≠ checkout proxy pool.

2. **Discovery / keyword loop (ship second)**  
   Operator queries (search / newest / category). New titles matching operator
   rules → emit `type: "new"` with resolved URL/SKU. Optionally promote that
   SKU onto the fast poller for subsequent restocks.

### Feed delivery

v1 preference: **WebSocket or SSE** from `monitor/` (or a thin relay on the
control plane) that desktop connects to when online.

Auth: desktop API key / license already exists — reuse to gate the feed so
random clients can’t siphon it. Details TBD with existing
`DESKTOP_AUTH_MODE` / validate-key path.

Ops: run as its own process (Fly/Railway/VPS). Electron does not host the
global poller.

### Deliberate non-goals for monitor v1

- Multi-store
- User-submitted global keywords
- Full Cybersole Smart Actions DSL
- Checkout inside the monitor
- Perfect historical catalog

---

## Desktop task changes

### Extend local task model (`desktop/store.cjs`)

Today tasks are roughly: `pdpUrl`, `qty`, `quantity`, `profileId`, `proxyGroupId`,
`placeOrder`, `kmartMode`, `enabled`.

Add:

```ts
type MonitorSource = "private" | "global";

// monitorInput replaces/generalizes pdpUrl-only:
// raw string: URL | SKU | keyword expression
monitorInput: string;
monitorSource: MonitorSource;  // default "global" once feed exists; "private" until then
// keep pdpUrl as resolved/cached field once matched (optional)
resolvedPdpUrl?: string;
resolvedSku?: string;
status?: "idle" | "monitoring" | "matched" | "checking_out" | "confirmed" | "failed";
```

UI task form (Cyber-style):

- Monitor input (placeholder examples for keywords / URL / SKU)
- Monitor source toggle: Private | Global
- Existing profile / proxy / qty / place order

### Runtime behavior

**Private**

1. Parse `monitorInput`
2. If URL/SKU → poll that product on user proxies
3. If keywords → discovery loop on user proxies (search/list) until title
   matches positives/negatives/OR rules → then poll that PDP for stock
4. In stock → hand off to existing `job-runner` / executor checkout

**Global**

1. Subscribe to feed (shared connection for the app)
2. For each event, evaluate task’s `monitorInput` against event
   (`title` / `url` / `sku`)
3. Match + `inStock` → set resolved PDP/SKU → start checkout
4. Debounce / one-shot per event id so restock spam doesn’t multi-fire

Proxy group on a **global** task is still used for **checkout**, not for
global detection.

---

## Electron Monitor Feed (visual)

Add a **Monitor** tab in `desktop/renderer` (alongside Tasks / Profiles /
Proxies / Results / Settings), Cyber “Monitor Feed” inspired:

### Layout (one composition, feed-first)

- Live scrolling list of recent global events (newest first)
- Each row: relative time, `new`/`restock` badge, title, SKU, store, stock hint
- Click row → copy URL / “Create task from this” (prefill monitor input +
  `monitorSource: global`)
- Header: connection state (`Live` / `Reconnecting` / `Offline`), event rate,
  optional local filter box (client-side only: filter what *you see*, does not
  change the server watchlist)
- Empty/offline states that make ownership clear: “Global feed is operator-run;
  start a private task to monitor with your proxies”

### Data path

```
monitor service → WS/SSE → main process (or renderer via preload)
  → ring buffer in memory (+ optional persist last N in db.json)
  → Monitor tab renders
  → task matcher consumes same bus
```

Keep feed parsing in one module used by both the UI and the task matcher so
the tab is not a toy — it’s the same events tasks arm against.

### Out of scope for feed v1

- Editing operator watchlist from the desktop UI
- Per-user publish
- Fancy analytics dashboards

---

## Implementation phases

### Phase 0 — Spec lock (no infra yet)

- Finalize event JSON + auth approach
- Keyword parser (shared pure module): positives, `-negatives`, `/` OR
- Decide Kmart availability probe for SKU poll (spike in `executor/experiments`
  or a thin `monitor/` spike — read-only)

### Phase 1 — Task UX + private keyword monitor (desktop)

Ship value without depending on the global service:

- Task form: monitor input + parse URL/SKU/keywords
- Private poll/discovery on user proxies
- Auto checkout on match (existing executor)
- Status column on task list (`monitoring` / `matched` / …)

This alone covers “start task with `pokemon,etb,-plush` → own proxies → buy”.

### Phase 2 — `monitor/` service (Kmart SKU/PDP only)

- Operator watchlist config (file or env/admin — keep simple)
- ISP rotation
- Emit restock/new events
- Feed endpoint + auth
- Deploy as separate process

### Phase 3 — Desktop global source + Monitor Feed tab

- WS/SSE client in Electron
- Monitor tab UI
- `monitorSource: global` on tasks
- Shared event bus → matcher → checkout
- “Create task from event” from feed rows

### Phase 4 — Global discovery keywords (operator-only)

- Operator discovery queries for unknown drops
- Emit `type: "new"`; optional promote to SKU poller
- Users still filter with their task monitor input

### Phase 5 — Later (explicitly deferred)

- Smart Actions (trigger / filter / action graphs, run-once, intervals, logs)
- Web dashboard parity for feed/tasks
- Multi-store monitors
- Checkout-feed style social signals

---

## Suggested repo layout (when building)

```
monitor/
  README.md
  package.json          # own runtime (Node), not Bun web app
  src/
    watchlist.ts        # operator config
    pollers/kmart-sku.ts
    pollers/kmart-discovery.ts
    proxies.ts          # ISP pool rotation
    feed/server.ts      # WS/SSE + auth
    events.ts           # schema + normalize
desktop/
  monitor-feed.cjs      # client + ring buffer
  keyword-parse.cjs     # shared syntax
  renderer/             # Monitor tab in index.html / app.js / styles.css
docs/
  kmart-monitor-plan.md # this file
```

Optional later: extract `keyword-parse` to a tiny shared package if the web
dashboard needs the same syntax.

---

## Success criteria

1. Operator can run a Kmart-only monitor on ISPs and publish stock events.
2. Desktop shows a live Monitor Feed of those events.
3. User can create a task with Cyber-style keywords and:
   - **Private** — finds product + checkouts on their proxies, or
   - **Global** — same task shape, arms against the feed, checkouts on match.
4. Users cannot mutate the global watchlist.
5. Checkout path remains desktop → executor; monitor never places orders.

---

## Open decisions (resolve in Phase 0)

1. **Feed transport** — WS vs SSE vs control-plane relay  
2. **Kmart stock probe** — which endpoint is stable enough for tight polling  
3. **Default monitor source** — `global` once live, else `private`  
4. **Match semantics for global + keywords** — title-only vs title+sku  
5. **Multi-fire policy** — one checkout per event id vs restock re-arm rules  
6. **Hosting** — where `monitor/` runs (Railway vs Fly vs VPS) and how desktop
   discovers the feed URL (settings field vs baked control-plane URL)

---

## References

- Cybersole Smart Actions [Overview](https://support.cybersole.io/hc/en-us/articles/4408559901201-Overview) (future; not v1)
- Cybersole [Creating Tasks](https://support.cybersole.io/hc/en-us/articles/4407742747537-Creating-Tasks) — monitor input on the task
- Cybersole Shopify keyword syntax — comma AND, `-` negatives, `/` OR
- Current desktop: `desktop/README.md`, `desktop/store.cjs`, `desktop/renderer/`
- Current checkout: `executor/` Kmart adapter (unchanged responsibility)
