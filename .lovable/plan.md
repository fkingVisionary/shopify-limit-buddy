# Get the Kmart/Hyper executor running on your own Fly.io account

I can't create a Fly account or log in for you — Fly accounts must be created and owned by you (billing + 2FA are tied to your email). What I can do is walk you through it command-by-command and wire the Lovable app to whatever URL/token you end up with. The existing `SETUP.md` covers the basics but predates the Hyper Solutions work, so we'll follow this updated flow instead.

## What you'll end up with

- A Fly.io account in your name, with billing card attached
- An app named `j1ms-bot-executor` in region `syd`, running `executor/`
- Three secrets set on that app: `EXECUTOR_TOKEN`, `HYPER_API_KEY`, and your residential proxy URL
- Two secrets set in Lovable (`EXECUTOR_URL`, `EXECUTOR_TOKEN`) so `runOnExecutor` can reach it

## Checkpoints (we stop at each one)

1. **Account + CLI** — you sign up at fly.io, add a card, install `flyctl` on Windows, run `flyctl auth login`. Reply "logged in" and paste the output of `flyctl auth whoami`.
2. **Get the code locally** — clone the repo (or download the ZIP from Lovable) and `cd` into the `executor/` folder. Reply "in executor folder".
3. **Launch the app (no deploy)** — `flyctl launch --no-deploy --copy-config --name j1ms-bot-executor --region syd`. Reply with any prompt you're unsure about.
4. **Generate + set secrets** — I'll give you the exact PowerShell to mint a random `EXECUTOR_TOKEN`, then `flyctl secrets set` for `EXECUTOR_TOKEN`, `HYPER_API_KEY` (your Kmart key), and `PROXY_URL_RESI` (your AU residential proxy in `http://user:pass@host:port` form).
5. **Deploy** — `flyctl deploy`. We watch `flyctl logs` together. Reply with `flyctl status` output so I can confirm the hostname.
6. **Health check** — `curl https://<your-host>/health` should return `{"ok":true}`.
7. **Wire Lovable** — once you confirm the hostname and token, I'll request `EXECUTOR_URL` and `EXECUTOR_TOKEN` via the secure secret form in this chat. Lovable's `runOnExecutor` server function already reads both.
8. **Dry-run** — I trigger `runOnExecutor` against a Kmart PDP URL. Success = chain ends with `akamai_solved` + `pdp_get 200`.

## Doc update (in parallel)

Once we finish, I'll rewrite `SETUP.md` so it reflects the Hyper-only Kmart flow (drop the 2Captcha section, add the `HYPER_API_KEY` step, and note that Browserless is recon-only now). No code changes needed for this plan — purely setup + one doc refresh at the end.

## What I need from you to start step 1

Just confirm you've created the Fly account and run `flyctl auth login`. I'll hand you the exact next command each time you reply.
