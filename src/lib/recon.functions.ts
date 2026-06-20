// Throwaway dev tool: invokes the run-checkout edge function in recon mode
// to dump the DOM of a target store's PDP + cart + checkout. Used to build
// store-specific adapters without guessing selectors.
import { createServerFn } from "@tanstack/react-start";

export const runRecon = createServerFn({ method: "POST" })
  .inputValidator((data: { productUrl: string; proxy?: string }) => {
    if (!data?.productUrl) throw new Error("productUrl required");
    return data;
  })
  .handler(async ({ data }) => {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const executorToken = process.env.EXECUTOR_TOKEN!;
    const url = `${supabaseUrl}/functions/v1/run-checkout?action=recon`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-executor-token": executorToken,
      },
      body: JSON.stringify({ productUrl: data.productUrl, proxy: data.proxy }),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: res.status, body: json ?? text };
  });
