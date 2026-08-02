#!/usr/bin/env node
/**
 * Stock Fast scoreboard checklist for dual-Revolut angles A/B/C.
 *
 * Usage (after a desktop Fast Bandai checkout):
 *   node executor/scripts/score-stock-fast-angles.mjs [path.jsonl]
 *
 * Expect:
 *   - bandaiCheckoutMode=fast (not autocheckout_test)
 *   - psp via=http-ge-issuer (undici Fast — hard no Playwright pay)
 *   - psp_post_start count = 1
 *   - User confirms Revolut 1 vs 2 for that transactionId
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const file =
  process.argv[2] ||
  process.env.PAY_FORENSICS_PATH ||
  path.join(os.tmpdir(), "j1m-pay-forensics.jsonl");

const classify = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "classify-pay-forensics.mjs",
);

if (!fs.existsSync(file)) {
  console.error("missing forensics file", file);
  console.log(
    JSON.stringify(
      {
        howToTest: [
          "1. Desktop task: bandaiCheckoutMode=fast (UI default). Do NOT use Autocheckout test or Safe/Playwright pay.",
          "2. Start engine, run one Bandai checkout with placeOrder.",
          "3. Confirm issuer via=http-ge-issuer (undici), NOT page-ge-issuer / bandai_ge_http_fork.",
          "4. node executor/scripts/score-stock-fast-angles.mjs",
          "5. Report Revolut 1 vs 2 for the printed transactionId.",
        ],
      },
      null,
      2,
    ),
  );
  process.exit(2);
}

const ran = spawnSync(process.execPath, [classify, file], { encoding: "utf8" });
if (ran.status !== 0 && ran.status != null) {
  process.stderr.write(ran.stderr || ran.stdout || "classify failed\n");
  process.exit(ran.status || 1);
}

let summary;
try {
  summary = JSON.parse(ran.stdout.split("\nNOTE")[0]);
} catch {
  process.stdout.write(ran.stdout);
  process.exit(0);
}

const stock = (summary.groups || []).filter((g) => g.stockFast);
const out = {
  file,
  angles: {
    A_fanout: stock.map((g) => ({
      key: g.key,
      class: g.class,
      fanout: g.fanout,
      askUser: "Revolut lines for fanout.transactionIds — 1 or 2?",
    })),
    B_prepay: {
      prepayMutates: summary.prepayMutates,
      issuerStageMutates: summary.issuerStageMutates,
      httpMutateResponses: summary.httpMutateResponses,
      acsOrRedirectLocations: summary.acsOrRedirectLocations,
      recentPrepay: summary.recentPrepay,
    },
    C_stockFast: {
      stockFastGroups: summary.stockFastGroups,
      groups: stock,
      ready:
        stock.length > 0 &&
        stock.every(
          (g) => g.class === "one_post_two_bank_suspect" || g.psp_post_start === 1,
        ),
    },
  },
  howToTest: [
    "1. Desktop task: bandaiCheckoutMode=fast (UI default). Do NOT use Autocheckout test or Safe/Playwright pay.",
    "2. Start engine, run one Bandai checkout with placeOrder.",
    "3. Confirm issuer via=http-ge-issuer (undici), NOT page-ge-issuer / bandai_ge_http_fork.",
    "4. node executor/scripts/score-stock-fast-angles.mjs",
    "5. Report Revolut 1 vs 2 for the printed transactionId.",
  ],
};

console.log(JSON.stringify(out, null, 2));
if (!stock.length) {
  console.log(
    "\nNo stock Fast (http-ge-issuer / undici) groups yet. Run one Bandai Fast checkout, then re-score.",
  );
  process.exit(0);
}
if (stock.some((g) => g.class === "one_post_two_bank_suspect")) {
  console.log(
    "\nScoreboard ready: 1 client POST on stock Fast. Confirm Revolut 1 vs 2 against fanout.transactionIds.",
  );
}
