## What I'll do

Create one file on your Desktop: `C:\Users\Administrator\Desktop\script.ps1`

It will:

1. Use your pairing code `P823AM` (hardcoded, no prompts).
2. POST to `https://shopify-limit-buddy.lovable.app/api/public/runner/pair` with a properly built JSON body (no here-string variable-expansion traps).
3. Read `deviceToken` out of the response.
4. Immediately GET `https://shopify-limit-buddy.lovable.app/api/public/runner/poll` with header `x-runner-token: <deviceToken>`.
5. Print the HTTP status and response body for both steps so we can see exactly what happened.

## Script contents

```powershell
$ErrorActionPreference = "Stop"
$base = "https://shopify-limit-buddy.lovable.app"
$code = "P823AM"

# --- Step 1: pair ---
$pairBody = @{ pairingCode = $code; deviceName = "my-runner" } | ConvertTo-Json -Compress
Write-Host "Pairing with code $code..."
$pair = Invoke-WebRequest -Uri "$base/api/public/runner/pair" `
  -Method POST -ContentType "application/json" -Body $pairBody `
  -SkipHttpErrorCheck
Write-Host "Pair HTTP $($pair.StatusCode)"
Write-Host $pair.Content
if ($pair.StatusCode -ne 200) { Write-Host "Pairing failed. Generate a fresh code in Settings and update `$code."; exit 1 }

$token = ($pair.Content | ConvertFrom-Json).deviceToken
Write-Host "Got deviceToken: $($token.Substring(0,8))..."

# --- Step 2: poll ---
Write-Host "Polling for jobs..."
$poll = Invoke-WebRequest -Uri "$base/api/public/runner/poll" `
  -Method GET -Headers @{ "x-runner-token" = $token } `
  -SkipHttpErrorCheck
Write-Host "Poll HTTP $($poll.StatusCode)"
Write-Host $poll.Content
```

## Why this version is safer than the last one

- No here-strings — `ConvertTo-Json` builds the JSON, so there's no chance of `$code` not expanding.
- `Invoke-WebRequest` with `-SkipHttpErrorCheck` shows status + body even on errors (instead of throwing a red wall of text).
- `Authorization: Bearer` is gone; we use `x-runner-token`, which is what the server expects.

## Important reminder

Pairing codes expire after **10 minutes** and are consumed on first successful use. If `P823AM` was generated more than ~10 min ago, or already used, Step 1 will return 401 "Invalid or expired code" — generate a new one in Settings → Local runner and update the `$code` line.

## Run it

```
cd C:\Users\Administrator\Desktop
.\script.ps1
```

Then paste me the full output and we'll go from there.
