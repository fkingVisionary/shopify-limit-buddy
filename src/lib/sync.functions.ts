// Cloud sync for workspace-scoped key/value app settings.
// Mirrors `aio:*` localStorage keys to `app_settings.data` so paired devices
// see the same profiles, tasks, stores, proxies, etc.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWorkspaceDevice } from "@/integrations/workspace/middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const loadSync = createServerFn({ method: "GET" })
  .middleware([requireWorkspaceDevice])
  .handler(async ({ context }) => {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("data, updated_at")
      .eq("workspace_id", context.workspaceId)
      .maybeSingle();
    return {
      data: (data?.data ?? {}) as Record<string, string>,
      updatedAt: data?.updated_at ? new Date(data.updated_at).getTime() : 0,
    };
  });

const SaveSchema = z.object({
  data: z.record(z.string().max(128), z.string().max(2_000_000)),
});

export const saveSync = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .inputValidator((d: unknown) => SaveSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          workspace_id: context.workspaceId,
          data: data.data,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true, updatedAt: Date.now() };
  });
