// Private (per-task) Kmart monitor loop — user proxies, Cyber monitor input.
// On match + inStock → callback enqueueCheckout(task).

const {
  classifyMonitorInput,
  matchKeywords,
  normalizeKmartPdpUrl,
  parseKeywords,
} = require("./keyword-parse.cjs");
const { probeKmartPdp, searchKmartProducts } = require("./kmart-stock-probe.cjs");
const { EventDedupe } = require("./monitor-events.cjs");

const DEFAULT_MONITOR_DELAY_MS = 3500;
const DEFAULT_RETRY_DELAY_MS = 5000;

/** @type {Map<string, { stop: () => void }>} */
const active = new Map();

let emit = () => {};
let onMatch = null;

function setEmitter(fn) {
  emit = typeof fn === "function" ? fn : () => {};
}

function setMatchHandler(fn) {
  onMatch = typeof fn === "function" ? fn : null;
}

function delayMs(task) {
  return Math.max(1000, Number(task.monitorDelayMs) || DEFAULT_MONITOR_DELAY_MS);
}

function retryMs(task) {
  return Math.max(1500, Number(task.retryDelayMs) || DEFAULT_RETRY_DELAY_MS);
}

function pickProxy(entries, index) {
  if (!entries?.length) return null;
  return entries[index % entries.length] || null;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolve monitor input to a PDP URL (discovery if keywords).
 */
async function resolveTarget(task, proxyUrl, signal) {
  const input = String(task.monitorInput || task.pdpUrl || "").trim();
  const classified = classifyMonitorInput(input);

  if (classified.kind === "url") {
    const url = normalizeKmartPdpUrl(classified.value);
    return { ok: Boolean(url), url, sku: null, title: null, classified };
  }

  if (classified.kind === "sku") {
    const url = normalizeKmartPdpUrl(classified.value);
    return { ok: Boolean(url), url, sku: classified.value, title: null, classified };
  }

  // Keywords — search until a title matches
  const ast = classified.keywords || parseKeywords(input);
  const query =
    (ast.groups[0] && ast.groups[0][0]) ||
    input.split(",")[0]?.replace(/^-/, "").trim() ||
    input;

  while (!signal.aborted) {
    emit({
      type: "monitor",
      phase: "discovery",
      taskId: task.id,
      message: `Searching “${query}”…`,
    });
    const found = await searchKmartProducts({ query, proxyUrl });
    if (found.ok && found.products?.length) {
      for (const p of found.products) {
        if (matchKeywords(ast, p).ok) {
          return {
            ok: true,
            url: p.url,
            sku: p.sku,
            title: p.title,
            classified,
          };
        }
      }
    }
    emit({
      type: "monitor",
      phase: "discovery",
      taskId: task.id,
      message: found.error
        ? `Discovery: ${found.error}`
        : "No keyword match yet — retrying…",
    });
    await sleep(retryMs(task), signal);
  }
  return { ok: false, url: null, sku: null, title: null, classified };
}

/**
 * @param {{
 *   task: object;
 *   proxyEntries: (string|null)[];
 *   waitForRestock?: boolean; // if true, require OOS→in-stock transition before checkout
 * }} opts
 */
function startTaskMonitor(opts) {
  const task = opts.task;
  const taskId = task.id;
  stopTaskMonitor(taskId);

  const ac = new AbortController();
  const dedupe = new EventDedupe(30_000);
  let proxyIndex = 0;
  let sawOos = opts.waitForRestock !== true;

  const loop = (async () => {
    try {
      emit({
        type: "monitor",
        phase: "start",
        taskId,
        message: opts.waitForRestock ? "Waiting for restock…" : "Monitoring…",
      });

      while (!ac.signal.aborted) {
        const proxyRaw = pickProxy(opts.proxyEntries, proxyIndex);
        proxyIndex += 1;
        // Caller passes already-normalized http(s) proxy URLs (or null).
        const resolved = await resolveTarget(task, proxyRaw || null, ac.signal);
        if (!resolved.ok || !resolved.url) {
          await sleep(retryMs(task), ac.signal);
          continue;
        }

        emit({
          type: "monitor",
          phase: "poll",
          taskId,
          message: `Polling ${resolved.sku || resolved.url}…`,
          resolvedPdpUrl: resolved.url,
          resolvedSku: resolved.sku,
        });

        const probe = await probeKmartPdp({
          url: resolved.url,
          proxyUrl: proxyRaw || null,
          timeoutMs: 15_000,
        });

        if (ac.signal.aborted) break;

        const classified = classifyMonitorInput(
          String(task.monitorInput || task.pdpUrl || ""),
        );
        if (classified.kind === "keywords" && probe.title) {
          if (!matchKeywords(classified.keywords || parseKeywords(task.monitorInput), {
            title: probe.title,
            sku: probe.sku || resolved.sku,
            url: probe.url,
          }).ok) {
            emit({
              type: "monitor",
              phase: "poll",
              taskId,
              message: "Title no longer matches keywords — rediscovering…",
            });
            await sleep(delayMs(task), ac.signal);
            continue;
          }
        }

        if (probe.blocked || !probe.ok) {
          emit({
            type: "monitor",
            phase: "poll",
            taskId,
            message: probe.error || "Probe failed — retrying…",
          });
          await sleep(retryMs(task), ac.signal);
          continue;
        }

        if (probe.inStock === false) {
          sawOos = true;
          emit({
            type: "monitor",
            phase: "poll",
            taskId,
            message: "Out of stock — monitoring…",
            resolvedPdpUrl: probe.url,
            resolvedSku: probe.sku,
          });
          await sleep(delayMs(task), ac.signal);
          continue;
        }

        if (probe.inStock === true) {
          if (!sawOos) {
            emit({
              type: "monitor",
              phase: "poll",
              taskId,
              message: "Still in stock — waiting for OOS before restock arm…",
              resolvedPdpUrl: probe.url,
              resolvedSku: probe.sku,
            });
            await sleep(delayMs(task), ac.signal);
            continue;
          }

          // Time-bucketed dedupe: allow restock re-fire after window; block spam.
          if (!dedupe.accept({
            id: undefined,
            sku: probe.sku || probe.url,
            type: "restock",
            detectedAt: new Date().toISOString(),
          })) {
            await sleep(delayMs(task), ac.signal);
            continue;
          }

          emit({
            type: "monitor",
            phase: "matched",
            taskId,
            message: "In stock — checking out…",
            resolvedPdpUrl: probe.url,
            resolvedSku: probe.sku,
            title: probe.title,
          });

          if (onMatch) {
            await onMatch({
              task,
              resolvedPdpUrl: probe.url,
              resolvedSku: probe.sku || resolved.sku,
              title: probe.title,
              proxyRaw: proxyRaw || null,
            });
          }
          // After a buy attempt, require another OOS→in-stock cycle.
          sawOos = false;
          await sleep(delayMs(task) * 2, ac.signal);
          continue;
        }

        emit({
          type: "monitor",
          phase: "poll",
          taskId,
          message: "Stock unknown — monitoring…",
          resolvedPdpUrl: probe.url,
          resolvedSku: probe.sku,
        });
        await sleep(delayMs(task), ac.signal);
      }
    } catch (e) {
      if (e?.name !== "AbortError") {
        emit({
          type: "monitor",
          phase: "error",
          taskId,
          message: e?.message || String(e),
        });
      }
    } finally {
      active.delete(taskId);
      emit({ type: "monitor", phase: "stop", taskId, message: "Monitor stopped" });
    }
  })();

  active.set(taskId, {
    stop: () => ac.abort(),
    promise: loop,
  });

  return { ok: true, taskId };
}

function stopTaskMonitor(taskId) {
  const row = active.get(taskId);
  if (row) {
    row.stop();
    active.delete(taskId);
    return { removed: true };
  }
  return { removed: false };
}

function stopAll() {
  for (const id of [...active.keys()]) stopTaskMonitor(id);
}

function isMonitoring(taskId) {
  return active.has(taskId);
}

function activeIds() {
  return [...active.keys()];
}

module.exports = {
  setEmitter,
  setMatchHandler,
  startTaskMonitor,
  stopTaskMonitor,
  stopAll,
  isMonitoring,
  activeIds,
  DEFAULT_MONITOR_DELAY_MS,
  DEFAULT_RETRY_DELAY_MS,
};
