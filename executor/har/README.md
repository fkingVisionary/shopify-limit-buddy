# HAR reference files

Canonical slim Kmart checkout HAR (241 entries, homepage → PDP → bag →
Paydock GraphQL → `chargePayDockWithToken`):

```text
public/kmart-slim.har
```

Symlink locally if you want it under this folder:

```bash
ln -sf ../../public/kmart-slim.har executor/har/kmart-slim.har
```

## Diff against a run

```bash
# From repo root, with debugTrace:true executor run JSON:
node --max-old-space-size=4096 executor/scripts/har-diff.mjs public/kmart-slim.har --json path/to/run.json
```

See `executor/scripts/README.md` for the golden checklist (get-token → cart →
address → Paydock → 3DS → placeOrder).

## What this slim HAR covers

| Checklist key   | Present | Notes |
| --------------- | ------- | ----- |
| seed (get-token)| yes     | Early API BM seed |
| cart_*          | yes     | createMyCart / updateMyCart ATC |
| addr_*          | yes     | shipping + billing |
| create_3ds      | yes     | GraphQL create3DSToken |
| place_order     | yes     | chargePayDockWithToken |
| paydock_* HTTP  | no      | widget/api.paydock.com filtered out of slim export |

For Paydock tokenize / handle / process header diffs, keep a fuller HAR
(or re-export those hosts) and drop it beside this file via LFS / Release.
