// HTTP API for the executor service.
// Single endpoint: POST /run  → runs one checkout task, returns timeline.
// Auth: shared-secret bearer token (EXECUTOR_TOKEN env var).
// Health: GET /health → { ok: true }

import Fastify from "fastify";
import { runCheckout } from "./checkout.js";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.EXECUTOR_TOKEN;

if (!TOKEN) {
  console.error("FATAL: EXECUTOR_TOKEN env var is required");
  process.exit(1);
}

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

app.get("/health", async () => ({ ok: true, ts: Date.now() }));

app.post("/run", async (req, reply) => {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) {
    reply.code(401);
    return { ok: false, error: "unauthorized" };
  }
  const task = req.body;
  if (!task?.taskId || !task?.storeUrl || !task?.variantId) {
    reply.code(400);
    return { ok: false, error: "missing required fields: taskId, storeUrl, variantId" };
  }
  const result = await runCheckout({
    taskId: String(task.taskId),
    storeUrl: String(task.storeUrl),
    variantId: Number(task.variantId),
    qty: Number(task.qty ?? 1),
    profile: task.profile ?? null,
    card: task.card ?? null,
    proxy: task.proxy ?? null,
    dryRun: task.dryRun !== false,
  });
  return result;
});

app
  .listen({ host: "0.0.0.0", port: PORT })
  .then(() => console.log(`executor listening on :${PORT}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
