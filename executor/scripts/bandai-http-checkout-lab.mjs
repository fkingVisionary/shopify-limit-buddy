// Lab: HTTP-first Bandai checkout (F5 sensor bridge + undici).
import fs from "node:fs";
import { runCheckout } from "../checkout.js";

function loadEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv("/tmp/bandai-lab-creds.env");

function rotate(raw) {
  const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return String(raw).replace(/-session-[^-]+-/, `-session-${sid}-`);
}

const email = process.env.BANDAI_EMAIL;
const password = process.env.BANDAI_PASSWORD;
const proxy = rotate(process.env.BANDAI_PROXY || "");
if (!email || !password || !proxy) {
  console.error("need BANDAI_EMAIL/PASSWORD/PROXY");
  process.exit(1);
}

const task = {
  taskId: `bandai-http-${Date.now()}`,
  storeUrl: "https://p-bandai.com/au/item/A2880191001",
  pdpUrl: "https://p-bandai.com/au/item/A2880191001",
  qty: 1,
  proxy,
  dryRun: true,
  placeOrder: false,
  forceUndici: true,
  bandaiMode: "checkout",
  bandaiBrowserCheckout: false,
  bandaiF5Bridge: true,
  account: { email, password },
};

console.log("taskId", task.taskId);
const res = await runCheckout(task);
console.log(
  JSON.stringify(
    {
      ok: res.ok,
      via: res.via,
      checkoutStage: res.checkoutStage,
      failedStep: res.failedStep,
      error: res.error,
      note: res.note,
      areaItemNo: res.areaItemNo,
      cartSn: res.cartSn,
      cartItemSn: res.cartItemSn,
      checkoutSn: res.checkoutSn,
      steps: (res.steps || []).map((s) => ({
        step: s.step,
        ok: s.ok,
        status: s.status,
        note: s.note,
        ms: s.ms,
      })),
    },
    null,
    2,
  ),
);
process.exit(res.ok ? 0 : 1);
