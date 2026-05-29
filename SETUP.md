# Executor Setup — Windows Beginner Guide

This guide walks you through everything you need to **buy, install, and configure** to get the Node executor service running on Fly.io from a Windows PC.

You will end up with:

- A residential proxy plan (so requests don't come from a datacenter IP)
- A 2Captcha account (for the rare Akamai sensor step)
- A Fly.io account hosting the executor (small Linux VM in Sydney)
- Your Lovable app pointed at the executor via 2 secrets

Total cost to get going: **~$5–$30/month** depending on proxy plan.

---

## 1. What you need to purchase

| Service | Why | Cost | Link |
|---|---|---|---|
| **Residential proxy** (e.g. IPRoyal, Bright Data, Smartproxy, Oxylabs) | Australian residential IP so Cloudflare/Akamai don't 403 you | from ~$7/GB pay‑as‑you‑go, or ~$15–30/mo small plan | iproyal.com / brightdata.com |
| **2Captcha account** | Solves Akamai sensor when stores require it | Pre‑pay $5–10 to start. ~$2.99 per 1,000 solves | 2captcha.com |
| **Fly.io account** | Hosts the executor (Linux VM, no Mac required) | Free tier covers 1 small VM; add a card for safety | fly.io |

> You already have an IPFist proxy configured (`premium-proxy.ipfist.com:1818`). If that's residential AU, you can skip buying a new proxy. If it's datacenter, replace it.

---

## 2. Install the tools on Windows

You only need **two** things installed locally:

### 2a. Install flyctl (Fly.io CLI)

Open **PowerShell** (Start menu → type "PowerShell" → Enter) and run:

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

Close and reopen PowerShell, then verify:

```powershell
flyctl version
```

You should see a version number. If "command not found", restart your PC so PATH updates.

### 2b. (Optional) Install Node.js — only if you want to test locally

Download the LTS installer from <https://nodejs.org> and run it. Click Next through everything. Verify:

```powershell
node --version
```

You can skip this if you're going straight to Fly.io.

> **Git, WSL, Docker, Mac — none required.** Fly.io builds the container in the cloud.

---

## 3. Create the Fly.io account

1. Go to <https://fly.io/app/sign-up> and sign up
2. Add a payment card (Hobby plan; small VM is free, card is just required)
3. In PowerShell, log in:

```powershell
flyctl auth login
```

A browser opens — approve the login.

---

## 4. Get the executor code onto your PC

You need the `executor/` folder from this Lovable project on your local disk.

Easiest way: click **GitHub** in the top right of Lovable → connect your repo → then on your PC:

```powershell
cd $HOME\Documents
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>\executor
```

(If you don't want GitHub, download the project as a ZIP from Lovable, unzip it, and `cd` into the `executor` folder.)

---

## 5. Deploy the executor to Fly.io

From inside the `executor` folder:

```powershell
flyctl launch --no-deploy --copy-config --name j1ms-bot-executor --region syd
```

Answer prompts:
- Postgres? **No**
- Redis? **No**
- Deploy now? **No**

Generate a shared secret (any random string works; this command makes one):

```powershell
$token = -join ((48..57) + (97..122) | Get-Random -Count 48 | % {[char]$_})
echo $token
```

Copy the printed token — you'll need it twice. Then set it on Fly:

```powershell
flyctl secrets set EXECUTOR_TOKEN=$token
```

Deploy:

```powershell
flyctl deploy
```

Wait ~2 minutes. When it finishes, get your URL:

```powershell
flyctl status
```

Look for `Hostname` — something like `j1ms-bot-executor.fly.dev`. That's your `EXECUTOR_URL`.

Sanity check it's alive:

```powershell
curl https://j1ms-bot-executor.fly.dev/health
```

Should return `{"ok":true}`.

---

## 6. Wire the executor into Lovable

Back in this chat, tell me:

> "Add the executor secrets"

I'll open a secure form for you to paste:
- `EXECUTOR_URL` → `https://j1ms-bot-executor.fly.dev`
- `EXECUTOR_TOKEN` → the token you generated in step 5

---

## 7. Smoke test

After secrets are saved, ask me:

> "Ping the executor"

then:

> "Run a dry-run JB Hi-Fi task through the executor"

If `checkout_page` returns **200** instead of **403**, the proxy is working and you're done.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `flyctl: command not found` | Restart PowerShell or reboot — PATH didn't refresh |
| `flyctl deploy` fails on build | Run `flyctl logs` and paste output here |
| `/health` returns 404 | Wrong URL — re‑run `flyctl status` |
| `checkout_page` still 403 | Proxy isn't residential AU — swap proxy provider |
| 2Captcha "ERROR_ZERO_BALANCE" | Top up at 2captcha.com/enterpage |

---

## Monthly cost estimate

- Fly.io small VM: **~$0–3** (free allowance covers most usage)
- Residential proxy starter: **~$15**
- 2Captcha top‑up: **~$10** (lasts thousands of solves)

**≈ $25/month** to run continuously.
