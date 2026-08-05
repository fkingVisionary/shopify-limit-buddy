/**
 * Loop PayPal guest e2e across fresh Noontide stickies until paypal_approved.
 *   node executor/scripts/bandai-paypal-guest-loop.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const max = Number(process.env.BANDAI_PP_LOOP_MAX) || 10;

for (let i = 0; i < max; i++) {
  console.log(`\n======== ATTEMPT ${i + 1}/${max} pick=${i} ========`);
  const offset = Math.max(0, Number(process.env.BANDAI_PROXY_PICK_OFFSET) || 0);
  const pick = offset + i;
  const r = spawnSync(process.execPath, ["executor/scripts/bandai-paypal-guest-e2e.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 600_000,
    // Inherit so SoftBlock/rotate progress is visible (pipe+Tee was buffering forever).
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      BANDAI_PROXY_GROUP: process.env.BANDAI_PROXY_GROUP || "px_noontide_resi_dual",
      BANDAI_PROXY_PICK: String(pick),
      BANDAI_E2E_WALL_MS: process.env.BANDAI_E2E_WALL_MS || String(8 * 60_000),
    },
  });
  console.log("exit", r.status, "pick", pick);

  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(path.join(root, "artifacts/bandai-paypal-guest-e2e.json"), "utf8"));
  } catch {
    /* ignore */
  }
  const ps = summary?.result?.paymentStatus;
  const note = String(summary?.result?.note || "");
  const failed = summary?.result?.failedStep;
  console.log(
    "STATUS",
    JSON.stringify({
      ps,
      failed,
      note: note.slice(0, 260),
      url: String(summary?.result?.finalUrl || "").slice(0, 120),
      guest: summary?.result?.paypalGuest || null,
    }),
  );

  if (ps === "paypal_approved" || r.status === 0) {
    console.log("SUCCESS");
    process.exit(0);
  }

  if (ps === "paypal_approve_failed") {
    const dir = path.join(root, "artifacts/paypal-guest");
    const files = fs
      .readdirSync(dir)
      .filter((f) => /after-advance|done-fail/.test(f) && f.endsWith(".txt"))
      .sort()
      .slice(-4);
    for (const f of files) {
      console.log("---", f, "---");
      console.log(fs.readFileSync(path.join(dir, f), "utf8").slice(0, 900));
    }
  }
}

process.exit(3);
