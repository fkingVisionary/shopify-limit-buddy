# Setting up the Node Executor — Beginner Walkthrough

The Lovable app is the **control plane** (UI, task pool, monitoring).
The Node executor is the **worker** that actually fires the checkout
requests through your residential proxy. They talk over HTTPS with a
shared secret.

You only set this up **once**. After that, every task the Lovable app
launches runs through the executor automatically.

---

## What you need before you start

1. **A Fly.io account** (free): https://fly.io/app/sign-up
2. **The `flyctl` CLI** on your laptop
   - macOS:    `brew install flyctl`
   - Windows:  `iwr https://fly.io/install.ps1 -useb | iex`
   - Linux:    `curl -L https://fly.io/install.sh | sh`
3. Your **residential proxy credentials** (the `user:pass@host:port` you
   already use — e.g. `premium-proxy.ipfist.com:1818`).

That's it. No Docker install needed — Fly builds the image in the cloud.

---

## Step 1 — Log in to Fly

Open a terminal and run:

```bash
flyctl auth login
```

A browser opens. Sign in. Close the tab when it says "successfully logged in".

---

## Step 2 — Generate the shared secret

This is the password the Lovable app uses to talk to your executor. Anyone
with this token can run checkout tasks through your proxy, so keep it private.

```bash
openssl rand -hex 32
```

Copy the long hex string it prints. You'll paste it in two places below.
Call it `EXECUTOR_TOKEN`.

(On Windows without openssl, any 40+ char random string works.)

---

## Step 3 — Deploy the executor

From the project root:

```bash
cd executor
flyctl launch --no-deploy --copy-config --name j1ms-bot-executor --region syd
```

- If it asks to set up a postgres DB or Upstash: **No**.
- If it asks to deploy now: **No** (we still need to set the secret).

Then set the secret and deploy:

```bash
flyctl secrets set EXECUTOR_TOKEN=<paste-the-token-from-step-2>
flyctl deploy
```

After 1–2 minutes you'll see something like:

```
https://j1ms-bot-executor.fly.dev
```

That's your **EXECUTOR_URL**. Copy it.

Quick sanity check:

```bash
curl https://j1ms-bot-executor.fly.dev/health
# → {"ok":true,"ts":...}
```

---

## Step 4 — Tell the Lovable app about the executor

Back in the Lovable chat, ask me to add two secrets:

- `EXECUTOR_URL` = the Fly URL from step 3 (e.g. `https://j1ms-bot-executor.fly.dev`)
- `EXECUTOR_TOKEN` = the same token from step 2

I'll open the secret form for you. Paste the values, save.

---

## Step 5 — Smoke test it

In the Lovable chat, say: **"ping the executor"**.

I'll call the `pingExecutor` server function. You should see `ok: true`.

Then: **"run a dry-run task against JB Hi-Fi through the executor with my proxy"**.

You'll get back a full step timeline:

```
warm_home       ✓ 412ms
cart_add        ✓ 287ms
cart_redirect   ✓ 891ms   → /checkouts/cn/xxxxx
checkout_page   ✓ 643ms   142kb cloudflare
```

If `checkout_page` is `✓` (not 403), the proxy is working end-to-end and
you can move on to porting the real GraphQL submit step.

---

## Costs

- Fly.io free tier covers one always-on shared-1x VM (256 MB) — plenty for
  this. `auto_stop_machines = "stop"` is on, so it sleeps when idle and
  cold-starts in ~1s.
- The executor itself costs **$0**.
- Outbound bandwidth: ~50 KB per task. 10k tasks ≈ 500 MB ≈ $0.

---

## Updating the executor later

When you (or I) change anything under `/executor/`, redeploy with:

```bash
cd executor
flyctl deploy
```

That's the whole loop.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl /health` returns 404 or hangs | `flyctl logs` — the app probably crashed. Most common cause: `EXECUTOR_TOKEN` not set. Re-run `flyctl secrets set`. |
| Lovable `pingExecutor` returns `ok: false` | Check `EXECUTOR_URL` has no trailing slash and starts with `https://`. |
| `/run` returns 401 | `EXECUTOR_TOKEN` in Lovable secrets ≠ Fly secret. Re-set both to the same value. |
| `checkout_page` still 403 | Proxy itself is being blocked. Try a different proxy pool / sticky session. The executor proved the request is leaving from the proxy IP — the IP just isn't trusted by Cloudflare. |
