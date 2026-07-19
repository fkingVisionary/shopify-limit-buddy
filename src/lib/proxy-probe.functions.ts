import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWorkspaceDevice } from "@/integrations/workspace/middleware";
import { classifyProxy } from "@/lib/proxy-format";
import {
  classifyDiagnoseProxyCheck,
  makeErrorProbeResult,
  makeInvalidProbeResult,
  type ProxyProbeResult,
} from "@/lib/proxy-probe";
import { resolveProbeUrl } from "@/lib/proxy-probe-stores";

const Schema = z.object({
  proxyUrl: z.string().min(1).max(2000),
  storeId: z.string().min(1).max(64).default("kmart"),
  customUrl: z.string().max(2000).optional().nullable(),
});

function executorOrigin(rawUrl: string): string {
  return rawUrl
    .replace(/\/$/, "")
    .replace(/\/(health|health\/diagnose|run|progress\/[^/]+|recon|akamai\/lab|transport\/diagnose)$/i, "");
}

/**
 * Probe one raw proxy against a store via executor POST /health/diagnose.
 * Lightweight: no fingerprint, no direct probe.
 * For Exit IP only / template proxies, the UI uses checkProxyExit instead.
 */
export const probeProxyAgainstStore = createServerFn({ method: "POST" })
  .middleware([requireWorkspaceDevice])
  .inputValidator((d: unknown) => Schema.parse(d))
  .handler(async ({ data }): Promise<ProxyProbeResult> => {
    const classification = classifyProxy(data.proxyUrl);
    if (classification.kind === "invalid") {
      return makeInvalidProbeResult(classification.reason ?? "invalid format");
    }
    if (classification.kind === "template") {
      return makeInvalidProbeResult(
        "URL-template proxies cannot use the executor store probe — switch to Exit IP only, or use host:port:user:pass",
      );
    }

    const { store, targetUrl } = resolveProbeUrl(data.storeId, data.customUrl);
    if (store.mode !== "executor") {
      return makeErrorProbeResult("Store probe mode is not executor — use Exit IP only path");
    }

    const rawUrl = process.env.EXECUTOR_URL;
    const token = (process.env.EXECUTOR_TOKEN ?? "").trim();
    if (!rawUrl || !token) {
      return makeErrorProbeResult("EXECUTOR_URL or EXECUTOR_TOKEN not configured");
    }

    const url = executorOrigin(rawUrl);
    const proxyForExecutor = classification.url ?? data.proxyUrl.trim();
    const t0 = Date.now();
    try {
      const res = await fetch(`${url}/health/diagnose`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          proxy: proxyForExecutor,
          targetUrl: targetUrl || "https://www.kmart.com.au/",
          fingerprint: false,
          proxyProbe: true,
          directProbe: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const rawBody = await res.text().catch(() => "");
      let body: Record<string, unknown> = {};
      if (rawBody) {
        try {
          body = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          body = { rawBody: rawBody.slice(0, 500) };
        }
      }

      if (res.status === 401) {
        return makeErrorProbeResult(
          `Executor unauthorized at ${new URL(url).host} — EXECUTOR_TOKEN mismatch`,
          Date.now() - t0,
        );
      }

      const checks = (body as { checks?: { proxy?: Parameters<typeof classifyDiagnoseProxyCheck>[0] } })
        .checks;
      const proxyCheck = checks?.proxy;
      if (!proxyCheck) {
        const err =
          (typeof body.error === "string" && body.error) ||
          (!res.ok ? `Executor returned HTTP ${res.status}` : "diagnose returned no proxy check");
        return makeErrorProbeResult(err, Date.now() - t0);
      }

      return classifyDiagnoseProxyCheck(proxyCheck, Date.now() - t0);
    } catch (e) {
      return makeErrorProbeResult(e instanceof Error ? e.message : String(e), Date.now() - t0);
    }
  });

export type { ProxyProbeResult };
