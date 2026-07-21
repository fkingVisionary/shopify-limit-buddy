# Toymate AU — Module notes

_Status: adapter restored (isolated from Kmart)_

## Platform

| Signal | Finding |
|--------|---------|
| Host | `toymate.com.au` / `www.toymate.com.au` |
| Stack | BigCommerce (Stencil) + Cloudflare |
| Adapter | `executor/adapters/toymate.js` |
| CF solve | CapSolver `AntiCloudflareTask` (`toymate-cf-solve.js`) |

**Hyper / Akamai / Paydock are not used.** Kmart paths stay untouched.

## Modes (`task.toymateMode`)

1. **`account_gen`** — CapSolver CF warm → create-account form → POST `login.php?action=save_new_account` → save `{ email, password }`.
2. **`checkout`** — CF warm → optional login → PDP → Storefront cart/checkout scaffold. Live card tokenize still needs operator HAR.
3. **`monitor`** — keyword search hit/miss.

## Desktop

- Task store option: **Toymate AU**
- Settings: **CapSolver API key** (passed to sidecar as `CAPSOLVER_API_KEY`)
- **Accounts** tab stores generated logins (`storeId` + email)

## Isolation rules

- Registry: `adapters/index.js` only adds `toymateAdapter` next to `kmartAdapter`.
- Desktop: `buildToymatePayload` is a separate branch from `buildKmartPayload`.
- Do not gate Kmart engine start on CapSolver; do not gate Toymate on Hyper inside the adapter.
