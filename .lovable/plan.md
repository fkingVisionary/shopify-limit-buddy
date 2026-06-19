## Current checkout workflow

The Browserless plan now supports longer sessions, so checkout runs as one `/function` call with a 5-minute transport timeout.

Flow:

```text
launch → cart_add → checkout_load → address_fill → shipping → payment → submit → result
```

Important notes:

- No chained phase handoff, no cookie/session restore, and no token juggling between browser sessions.
- The worker opens the plain `/checkout` route after cart add, then fills profile data inside the checkout page.
- Browserless timeout is `300000` ms.
- `checkout_jobs.stage` continues to drive the polling UI.
