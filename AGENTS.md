# AGENTS.md

## Cursor Cloud specific instructions

### Product overview
This repo is **J1m's Bot**. `executor/` = checkout engine. `desktop/` = Electron app
that spawns `../executor` as a local sidecar (same code — pull + restart engine).

### Kmart working tip (important)
Success was associated with the direct commit **`a1d9f9c` ("Electron Update")**, which
landed on `main` **without a PR**. That tip is **after** PR #32 (`600b40f`).

Do **not** casually roll `kmart.js` back to PR #32 without the user’s OK — that undoes
the Electron Update module. Prefer proving on **desktop + sticky/ISP proxy**.

### Executor
- `cd executor && npm install && npm run dev`
- Cloud: `PORT=8081 EXECUTOR_TOKEN=devtoken HYPER_API_KEY=… node server.js`
- Desktop uses undici (`kmartMode=current`). **No Playwright** recovery ladder.

### Desktop
- `cd desktop && npm run setup && npm start` → Start engine after every pull.
