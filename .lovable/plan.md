## Goal

Tighten the Tasks tab so the header reflects what you're actually looking at, every group has a clear way to add its first task, and you can quickly find a task by name or state.

## Changes

### 1. Auto-create "Default" group on first run
- On bootstrap, if `loadTaskGroups()` returns empty, create one group `{ name: "Default" }`, persist it, and set it as `activeGroupId`.
- Removes the "Create a task group first" empty wall for new users — they can immediately add tasks, and rename/add more groups later.

### 2. Per-group stats in header
- Replace the workspace-wide `runningCount` / `stockCount` / `errorCount` and `tasks.length` count with values scoped to `activeGroupId`.
- Derived from `tasks.filter(t => t.groupId === activeGroupId)`.
- The Analytics tab keeps showing workspace-wide numbers — only the Tasks header pills change.

### 3. Quick-add inside an empty group
- When the active group has 0 tasks, render a centered CTA card inside `TasksView` (below the group chips) with:
  - Group name + "No tasks in this group yet"
  - Big `+ New task` button that opens the same Create Task drawer used by the header plus icon.
- Header plus button stays, but the in-group CTA makes the action obvious on first visit to a group.

### 4. Task search + status filter
- Add a search input + status filter row at the top of `TasksView` (just below the group chips, above the select bar).
- Search: case-insensitive match against `productTitle`, `input`, and the resolved store name.
- Status filter chips: `All · Idle · Running · In stock · Failed`. Single-select, defaults to `All`.
- Both are local UI state inside `TasksView` (no persistence). Combined with the active group filter to produce `visibleTasks`.
- Bulk "Select all" continues to operate on the currently visible (filtered) tasks.

## Files touched

- `src/routes/_paired/index.tsx`
  - `Index()` bootstrap effect: auto-create Default group.
  - `Index()` counts block (~L1183-1187): scope to active group; pass into header pills.
  - `TasksView`: add search + status filter state, empty-group CTA, update `visibleTasks` derivation and `allSelected` / "Select all" to use the filtered list.

No schema or backend changes. No new dependencies.

## Out of scope (saved for later)

- Group reorder / per-group color or emoji
- Persisting search/filter across reloads
- Per-group counts on the group chips themselves (currently shown — will stay)
