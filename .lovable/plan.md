# Pack B — Power-user upgrades

All three features are phone-testable. No PC runner required to validate the UI, selection state, server fns, or the Jobs view (it'll just show "no runner connected" jobs as pending — which is itself a useful test).

---

## 1. Bulk task actions

Add a multi-select mode to the Tasks tab.

- **Enter select mode**: long-press a task card (or tap a new "Select" button in the toolbar).
- **Selection UI**: checkbox overlay on each card, count badge in header, "Select all" / "Clear" buttons.
- **Bulk action bar** (slides up above the bottom nav when ≥1 selected):
  - Delete (with confirm)
  - Duplicate (×N)
  - Change profile → opens profile picker sheet
  - Change proxy group → opens proxy picker sheet
  - Change store → opens store picker sheet
  - Start / Stop (queues them via existing dispatch)
- Exit select mode on back gesture or "Done".
- Works against the existing `aio:tasks` localStorage shape — cloud-sync hook picks up the writes automatically.

## 2. Proxy & profile polish

**Proxies**
- New server fn `checkProxyHealth` — runs server-side fetch through the proxy to a small endpoint (e.g. `https://api.ipify.org`), returns `{ ok, latencyMs, exitIp, error }`. No PC needed.
- "Test" button per proxy + "Test all" per group, with status pill (green/red/grey + latency).
- Mark dead proxies; "Auto-rotate" toggle on the group skips dead ones during task assignment.
- Per-proxy last-tested timestamp persisted in `aio:proxy-health`.

**Profiles**
- Tag/group support (free-text tags, multi-select filter).
- Duplicate-profile button (one tap, appends " (copy)").
- Quick-edit sheet from the task card so you can fix a typo without leaving Tasks.
- Search bar on the Profiles tab.

## 3. Jobs history tab

New bottom-nav tab **Jobs** built on the existing `listRunnerRecentJobs` + `runner_jobs` / `runner_results` tables.

- List of recent attempts (newest first), grouped by day.
- Each row: store name, variant, profile name, status (pending/success/failed), timing, error reason if any.
- Tap a row → detail sheet with full payload, raw error, timestamps, device that ran it.
- Filters: store, date range, outcome (success / failed / pending).
- Search by order id or error substring.
- **Re-run** button on each row → calls existing `dispatchRunnerJob` with the same payload (queues if no PC connected — visible feedback that the queue works).
- Lightweight server fn `listJobsWithResults` that joins `runner_jobs` + `runner_results` for the current workspace, paginated (50/page).

---

## Technical details

**Files to add**
- `src/components/tasks/BulkActionBar.tsx`
- `src/components/tasks/SelectionContext.tsx` (small context for select-mode + selected IDs)
- `src/components/proxies/ProxyHealthBadge.tsx`
- `src/components/profiles/ProfileTagPicker.tsx`
- `src/components/JobsPanel.tsx` (+ `JobDetailSheet.tsx`)
- `src/lib/proxy-health.functions.ts` — `checkProxyHealth` server fn (workspace-auth'd).
- `src/lib/jobs.functions.ts` — `listJobsWithResults` server fn.

**Files to edit**
- `src/routes/_paired/index.tsx`:
  - Wire selection context + bulk action bar into the Tasks tab.
  - Add **Jobs** tab to bottom nav (5th tab) + tab content.
  - Minor: profile/proxy quick-edit sheets, search inputs.

**Data**
- New localStorage keys (auto-synced via `aio:*` prefix): `aio:proxy-health`, `aio:profile-tags`, `aio:proxy-group-settings` (for auto-rotate flag).
- No schema migration needed — `runner_jobs` and `runner_results` already exist and have `workspace_id` linkage via `device_id` → `runner_devices.workspace_id`. The new `listJobsWithResults` fn filters by the caller's workspace.

**Server fn shape**
```ts
checkProxyHealth({ proxyUrl }) → { ok, latencyMs, exitIp?, error? }
listJobsWithResults({ limit, cursor?, filters? }) → { jobs: [...], nextCursor }
```
Both use `requireWorkspaceDevice` middleware.

**Out of scope (deferred)**
- Mobile polish (Pack A) — separate ask.
- Backup/restore (Pack C) — separate ask.
- No changes to the runner protocol or executor — purely additive on the server + UI.

---

## Testing checklist (all phone-only)

1. Long-press a task → select mode activates, bulk bar slides up.
2. Select 3 tasks → Duplicate → 3 new tasks appear, cloud-sync mirrors them.
3. Add a proxy, hit Test → status pill flips green with latency.
4. Tag a profile "rotation-A", filter by tag.
5. Open Jobs tab → see prior dispatch attempts (will show "pending — no runner" for new ones, which confirms the join + workspace scoping works).
