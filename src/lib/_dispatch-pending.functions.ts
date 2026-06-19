// TEMP: dispatch any pending checkout_jobs row. Used for end-to-end testing.
import { createServerFn } from "@tanstack/react-start";

export const dispatchPendingCheckout = createServerFn({ method: "POST" })
  .inputValidator((d: { jobId: string }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const EXECUTOR_TOKEN = process.env.EXECUTOR_TOKEN;
    if (!SUPABASE_URL) return { error: "SUPABASE_URL missing" };
    if (!EXECUTOR_TOKEN) return { error: "EXECUTOR_TOKEN missing" };
    const edgeUrl = `${SUPABASE_URL}/functions/v1/run-checkout`;
    const { error } = await supabaseAdmin.rpc("request_checkout_worker", {
      p_job_id: data.jobId,
      p_url: edgeUrl,
      p_token: EXECUTOR_TOKEN,
    });
    if (error) return { error: error.message };
    return { ok: true };
  });
