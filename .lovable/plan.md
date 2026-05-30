## Goal

Push toward win-rate: tasks fire at exact drop times, and the user gets a Discord ping the moment something happens so they can react (size confirm, captcha solve, share screenshots).

## 1. Drop scheduler

**Data model**
- Add optional `scheduledAt?: number` (ms epoch) to `Task`. Persisted via existing `saveTasks`.
- Add optional `preWarmMs?: number` per task (default `2000`) — controls how early the warm-up requests start.

**Engine wiring** (in `Index()` poll loop, `src/routes/_paired/index.tsx`)
- New tick branch BEFORE the normal "running" branch:
  - For each task with `scheduledAt` set and not yet running:
    - If `now >= scheduledAt` → call `startTask(t.id)` (clears `scheduledAt` after firing).
    - If `now >= scheduledAt - preWarmMs` → fire one no-op `fetch(proxied(${storeUrl}/products.json, t.proxyGroupId))` to warm DNS/TLS/proxy session. Don't update task state.
- Poll-loop interval is already 1.5–4s, fine-grained enough for second-accurate scheduling.

**UI**
- New `<ClockIcon>` button in task card row → opens a small `ScheduleSheet`:
  - Date+time picker (defaults to next round 5 min)
  - "Pre-warm 2s before" toggle
  - "Clear schedule" button
- In task card, when `scheduledAt` is set, show a live countdown chip (`Starts in 04:32`) replacing the play button until fire time.
- **Bulk schedule**: in the bulk-action bar, add a Clock icon. Sheet has:
  - Start time
  - Optional stagger ms between tasks (so 50 tasks don't all hit at exact same ms)

## 2. Discord webhooks

**Settings**
- Settings tab gains a "Notifications" card:
  - Webhook URL input (validated against `https://discord.com/api/webhooks/...` and `https://discordapp.com/api/webhooks/...`)
  - Toggles per event: `In stock`, `Checkout ready`, `Order confirmed`, `Failed` (default: confirmed + failed on)
  - "Send test" button → fires a minimal embed
- Stored under `aio:notify` in localStorage, mirrored to cloud sync (already in place for other prefs).

**Payload (Discord embed)**
- Title: e.g. `✅ Order confirmed — Air Jordan 1 Low`
- Color per event (green/amber/red)
- Fields: Store, Size/Variant, Profile (masked: `John D.****`), Order ID, Elapsed, Proxy group name
- Screenshot URL if `t.screenshotB64` is present (uploaded to a temp slot? — see below)
- Timestamp + group name as footer

**Screenshots from Browserless**
- Current `screenshotB64` is data-URL only. Discord can't embed base64. Two options:
  - **A (no-backend):** strip screenshots from the embed; include a "screenshot available in app" note. Simpler, no infra.
  - **B (later):** upload the screenshot to a Supabase storage bucket and embed the public URL. Defer to a follow-up — keeps this PR small and avoids storage bucket setup.
- Plan picks **A** for now.

**Firing**
- New helper `notifyWebhook(event, task, extras)` in a new file `src/lib/discord.ts`. Pure client-side `fetch` to the webhook URL.
- Hooked into existing state-transition sites in the poll loop: where `updateTask(id, { status: "in_stock" / "checkout_ready" / "confirmed" / "failed" })` is called, also call `notifyWebhook`.
- Dedupe via a `notifiedRef = useRef(new Map<string, Set<event>>())` so we don't double-post on flapping states.

## 3. Push notifications — defer

The PWA / service-worker rules in this stack warn against registering SWs in the preview iframe. Web Push **requires** a service worker, so a full implementation will break the editor preview. The in-page `Notification.requestPermission()` flow is already wired and works while the tab is open.

Recommended outcome of this plan:
- Keep the existing in-tab `Notification` ping.
- Use Discord webhooks as the "remote" channel (works whether the tab is open or not, on every device, no SW required).
- Revisit true Web Push later as a production-only feature with explicit SW guards.

## Files touched

- `src/routes/_paired/index.tsx` — add `scheduledAt` / `preWarmMs` fields, scheduler tick branch, countdown chip, ScheduleSheet, bulk schedule, webhook calls at state transitions, notification settings card in `SettingsView`.
- New `src/lib/discord.ts` — `notifyWebhook(event, task, extras)` builder + sender, payload types, URL validator, "send test" helper.
- No schema, no migrations, no new server functions.

## Out of scope (next pass)

- Real Web Push / PWA install
- Screenshot upload to storage for Discord embeds
- Per-group webhook routing (one workspace webhook for now)
- Discord OAuth for license-role sync