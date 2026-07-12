## Goal
Create solid direction before more implementation: preserve what we learned, roll back to the last better-working state, then rebuild the Kmart flow with controlled comparisons instead of blind patches.

## Recommended next move

1. **Write a checkpoint report first**
   - Document every major attempt so far: what changed, what improved, what regressed, and what evidence we have.
   - Include the latest trace findings:
     - Akamai sensor can solve and `_abck` reaches a validated state.
     - `sbsd_category:round#0` and `sbsd_pdp:round#0` can mint `bm_s`.
     - `sbsd_home:round#0` and all `round#1` payloads are being rejected.
     - PDP/cart still 403 even after some SBSD success, meaning the session is still not fully trusted.
     - `kmartMode` passthrough appears suspicious and needs to be verified from a cleaner state.
   - Save this as a project report so we do not lose the hard-won diagnostics when rolling back.

2. **Rollback using Lovable history, not manual code edits**
   - Use History to restore the version where the flow looked most promising.
   - Based on the screenshot, likely candidates are the successful `@place_order` dry runs or the successful `@cart_atc` real run.
   - After rollback, do not immediately change logic. First run a baseline trace and save it.

   <presentation-actions>
     <presentation-open-history>View History</presentation-open-history>
   </presentation-actions>

3. **Re-establish a clean baseline**
   - Run Kmart dry mode once from the rolled-back state.
   - Save the trace as `rollback-baseline.json`.
   - Summarize only stable facts: final failure step, HTTP statuses, key cookies, SBSD outcomes, and whether PDP/cart is accessible.

4. **Fix instrumentation before changing the checkout strategy**
   - Ensure `kmartMode` actually reaches the executor task.
   - Add trace labels for:
     - mode
     - page URL
     - Hyper payload index
     - script hash/body length
     - `o` cookie length/hash
     - `bm_so`, `bm_s`, `_abck`, `bm_sv` before/after each key request
   - Keep this diagnostic-only. No behavior changes yet.

5. **Compare two flows from the same code state**
   - Run `cart-baseline` and `current` automatically against the same product/variant/proxy settings.
   - Save both traces side by side.
   - Diff the first point where they diverge.

6. **Focus on the likely wall: SBSD round#1**
   - Compare our generated round#1 payload against the HAR round#1 payload.
   - Specifically inspect whether Hyper inputs differ:
     - payload index
     - UUID/session identifiers
     - `o` cookie
     - sensor/script version
     - target URL/referrer
     - cookie jar state
   - Do not chase cart GraphQL or payment until SBSD trust is understood.

7. **Only then make one controlled fix at a time**
   - One hypothesis per change.
   - One run after each change.
   - Save trace names with the hypothesis, e.g. `round1-o-cookie-fix.json`, `round1-url-fix.json`.
   - If a change regresses, revert that single change immediately.

## What I would not do next
- I would not keep editing the current broken state without a report and rollback.
- I would not pivot to a totally different executor/browser approach yet.
- I would not work on payment/place-order while PDP/cart trust is still failing.
- I would not rely on the UI recent-runs list alone; we need saved trace artifacts for comparison.

## Success criteria
We should proceed only when we can answer these clearly:

- Which historical version was the best baseline?
- What exact step regressed after that version?
- Does `kmartMode` actually change executor behavior?
- Why is SBSD round#1 rejected compared with the HAR?
- What is the smallest code change that moves the flow forward?

## User action needed before implementation
Approve this plan, then use the History button to choose the last known better-working version. After that, I’ll create the checkpoint report and run the clean baseline workflow from that restored state.