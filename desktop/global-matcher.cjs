// Match global MonitorEvents against tasks with monitorSource === "global".

const {
  classifyMonitorInput,
  matchKeywords,
  parseKeywords,
  normalizeKmartPdpUrl,
} = require("./keyword-parse.cjs");
const { EventDedupe } = require("./monitor-events.cjs");

const dedupe = new EventDedupe(30_000);

/**
 * @param {object} evt MonitorEvent
 * @param {object} task
 */
function taskMatchesEvent(task, evt) {
  if (task.monitorEnabled !== true) return false;
  if (task.monitorSource !== "global") return false;
  if (evt.store && evt.store !== "kmart") return false;
  if (evt.inStock === false) return false;

  const input = String(task.monitorInput || task.pdpUrl || "").trim();
  if (!input) return false;

  const classified = classifyMonitorInput(input);
  if (classified.kind === "url") {
    const want = normalizeKmartPdpUrl(classified.value);
    const got = normalizeKmartPdpUrl(evt.url);
    return Boolean(want && got && want === got);
  }
  if (classified.kind === "sku") {
    return String(evt.sku || "") === classified.value || String(evt.url || "").includes(classified.value);
  }
  return matchKeywords(classified.keywords || parseKeywords(input), {
    title: evt.title,
    sku: evt.sku,
    url: evt.url,
  }).ok;
}

/**
 * @param {object} evt
 * @param {object[]} tasks
 * @returns {object[]} matching tasks (not currently checking out)
 */
function matchingTasks(evt, tasks) {
  if (!dedupe.accept(evt)) return [];
  return (tasks || []).filter((t) => {
    if (t.enabled === false) return false;
    if (t.lastStatus === "checking_out" || t.lastStatus === "running" || t.lastStatus === "queued") {
      return false;
    }
    // Only fire for tasks that opted into monitoring and were started
    if (t.monitorEnabled !== true) return false;
    if (t.lastStatus !== "monitoring" && t.lastStatus !== "matched") return false;
    return taskMatchesEvent(t, evt);
  });
}

module.exports = {
  taskMatchesEvent,
  matchingTasks,
};
