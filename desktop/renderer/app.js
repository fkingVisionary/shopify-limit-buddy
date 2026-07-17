/* global desktop from preload */
const $ = (id) => document.getElementById(id);

let state = null;
let editingTask = false;
let activeProxyGroupId = null;
let homeMetric = "checkouts";
let homePeriod = "today";
/** @type {{ stores: Array<{id:string,label:string,probeUrl:string,notes?:string}>, defaultStoreId: string } | null} */
let probeStores = null;
const proxyTestResults = new Map();
let proxyTestingGroupId = null;

function setTab(name) {
  document.querySelectorAll(".topnav-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${name}`);
  });
}

document.querySelectorAll(".topnav-tabs button").forEach((b) => {
  b.onclick = () => setTab(b.dataset.tab);
});

function tickClock() {
  const el = $("clock");
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString([], { hour12: true });
}
setInterval(tickClock, 1000);
tickClock();

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function activeGroupId() {
  return state?.settings?.activeGroupId || state?.taskGroups?.[0]?.id || null;
}

function storeById(id) {
  return (state?.stores || []).find((s) => s.id === id) || null;
}

function profileById(id) {
  return (state?.profiles || []).find((p) => p.id === id) || null;
}

function proxyGroupById(id) {
  return (state?.proxyGroups || []).find((g) => g.id === id) || null;
}

function isKmartStoreId(storeId) {
  const s = storeById(storeId);
  if (!s) return true;
  return s.adapter === "kmart" || /kmart/i.test(s.id) || /kmart\.com\.au/i.test(s.url || "");
}

function taskIsActive(t) {
  return (
    t?.lastStatus === "queued" ||
    t?.lastStatus === "running" ||
    t?.lastStatus === "monitoring" ||
    t?.lastStatus === "matched" ||
    t?.lastStatus === "checking_out"
  );
}

function progressLine(t) {
  if (t.lastProgress) return t.lastProgress;
  if (t.lastStatus === "queued") return "Queued…";
  if (t.lastStatus === "running" || t.lastStatus === "checking_out") return "Checking out…";
  if (t.lastStatus === "monitoring") return "Monitoring…";
  if (t.lastStatus === "matched") return "Matched…";
  if (t.lastOrderNumber) return `Order ${t.lastOrderNumber}`;
  if (t.lastError) return t.lastError;
  if (t.lastCheckoutStage) return t.lastCheckoutStage;
  return null;
}

function groupTaskStats(groupId) {
  const tasks = (state.tasks || []).filter((t) => t.groupId === groupId);
  let ok = 0, err = 0, run = 0, idle = 0;
  for (const t of tasks) {
    if (t.lastStatus === "confirmed" || t.lastStatus === "ok") ok++;
    else if (t.lastStatus === "failed") err++;
    else if (taskIsActive(t)) run++;
    else idle++;
  }
  return { total: tasks.length, ok, err, run, idle };
}

function fillTaskSelects() {
  const prof = $("taskProfile");
  const px = $("taskProxy");
  const storeSel = $("taskStore");
  if (!prof || !px || !storeSel) return;
  const curP = prof.value;
  const curX = px.value;
  const curS = storeSel.value;
  const stores = state.stores || [];
  storeSel.innerHTML =
    stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.preset ? "" : " (custom)"}</option>`).join("") +
    `<option value="__add">＋ Add custom store…</option>`;
  prof.innerHTML =
    `<option value="">Select profile…</option>` +
    (state.profiles || []).map((p) => `<option value="${p.id}">${esc(p.name || p.email || p.id)}</option>`).join("");
  const kmart = isKmartStoreId(storeSel.value === "__add" ? curS : storeSel.value || curS || stores[0]?.id);
  $("taskProxyLabel").textContent = kmart ? "Connection" : "Proxies";
  px.innerHTML =
    `<option value="">${kmart ? "Automatic" : "Direct (no proxy)"}</option>` +
    (state.proxyGroups || []).map((g) => `<option value="${g.id}">${esc(g.name)} (${g.entries?.length || 0})</option>`).join("");
  if (curS && curS !== "__add" && stores.some((s) => s.id === curS)) storeSel.value = curS;
  else if (stores[0]) storeSel.value = stores[0].id;
  if (curP) prof.value = curP;
  if (curX) px.value = curX;
  updateTaskFormForStore();
}

function updateTaskFormForStore() {
  const storeId = $("taskStore").value;
  const kmart = isKmartStoreId(storeId);
  $("taskInputLabel").textContent = kmart ? "Product" : "Input";
  $("taskPdp").placeholder = kmart
    ? "URL, SKU, or keywords — e.g. pokemon,etb,-plush"
    : "URL, SKU, or keywords";
  $("taskInputHint").textContent = kmart
    ? "URL/SKU preferred. Keywords need Monitor for restock. Start checks stock first when possible."
    : "Store adapters beyond Kmart are coming — you can still organize tasks now.";
  $("taskPlaceOrderWrap").hidden = !kmart;
  const monWrap = $("taskMonitorEnabledWrap");
  const srcWrap = $("taskMonitorSourceWrap");
  if (monWrap) monWrap.hidden = !kmart;
  const enabled = $("taskMonitorEnabled")?.checked === true;
  if (srcWrap) srcWrap.hidden = !kmart || !enabled;
  const src = $("taskMonitorSource");
  if (src) src.disabled = !kmart || !enabled;
  $("taskProxyLabel").textContent = kmart ? "Connection" : "Proxies";
  const px = $("taskProxy");
  const first = px.querySelector("option[value='']");
  if (first) first.textContent = kmart ? "Automatic" : "Direct (no proxy)";
  const hint = $("taskProxyHint");
  if (hint) {
    hint.textContent =
      enabled && $("taskMonitorSource")?.value === "global"
        ? "Proxies: stock check + checkout. Detect waits on the in-house global feed."
        : "Proxies: stock check, private detect (if on), and checkout.";
  }
}

function renderTaskGroups() {
  const el = $("taskGroupList");
  if (!el) return;
  const groups = state.taskGroups || [];
  const active = activeGroupId();
  el.innerHTML = groups
    .map((g) => {
      const stats = groupTaskStats(g.id);
      return `<button type="button" class="rail-item ${g.id === active ? "active" : ""}" data-select-group="${g.id}">
        <div>
          <div class="rail-name">${esc(g.name)}</div>
          <div class="rail-stats">
            <span class="ok">${stats.ok}</span>
            <span class="err">${stats.err}</span>
            <span class="run">${stats.run}</span>
            <span>${stats.idle}</span>
          </div>
        </div>
        <span class="rail-count">${stats.total}</span>
      </button>`;
    })
    .join("");
}

function renderTasks() {
  const el = $("taskList");
  const gate = $("taskEmpty");
  const table = $("taskTable");
  const groups = state.taskGroups || [];
  const active = activeGroupId();
  const profiles = state.profiles || [];
  const q = ($("taskSearch")?.value || "").trim().toLowerCase();

  renderTaskGroups();

  const g = groups.find((x) => x.id === active);
  const stats = active ? groupTaskStats(active) : { total: 0, ok: 0, err: 0, run: 0, idle: 0 };
  $("taskGroupTitle").textContent = g?.name || "Tasks";
  $("taskGroupMeta").textContent = `${stats.total} task${stats.total === 1 ? "" : "s"}`;
  $("taskGroupStats").innerHTML = `
    <div class="stat-pill ok" title="Success">${stats.ok}</div>
    <div class="stat-pill err" title="Failed">${stats.err}</div>
    <div class="stat-pill run" title="Running">${stats.run}</div>
    <div class="stat-pill idle" title="Idle">${stats.idle}</div>`;

  if (!groups.length) {
    gate.hidden = false;
    table.hidden = true;
    gate.innerHTML = `<strong>Create a task group first</strong><div class="meta">Groups keep drops organized.</div>
      <button type="button" class="btn-accent" id="btnEmptyAddGroup">New group</button>`;
    $("btnOpenCreateTask").disabled = true;
    return;
  }
  if (!profiles.length) {
    gate.hidden = false;
    table.hidden = true;
    gate.innerHTML = `<strong>Add a profile first</strong><div class="meta">Checkout needs shipping and card details.</div>
      <button type="button" class="btn-accent" id="btnEmptyGoProfiles">Go to Profiles</button>`;
    $("btnOpenCreateTask").disabled = true;
    return;
  }

  gate.hidden = true;
  table.hidden = false;
  $("btnOpenCreateTask").disabled = false;

  let tasks = (state.tasks || []).filter((t) => t.groupId === active);
  if (q) {
    tasks = tasks.filter((t) =>
      [t.label, t.monitorInput, t.pdpUrl, t.storeName, t.lastStatus, t.lastProgress, t.monitorSource]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }

  if (!tasks.length) {
    el.innerHTML = `<tr class="table-empty"><td colspan="6">No tasks in this group — use Task creator.</td></tr>`;
    return;
  }

  el.innerHTML = tasks
    .map((t) => {
      const activeRun = taskIsActive(t);
      const badge =
        t.lastStatus === "confirmed" || t.lastStatus === "ok"
          ? "ok"
          : t.lastStatus === "failed"
            ? "err"
            : activeRun
              ? "run"
              : "";
      const statusLabel = t.lastStatus || "idle";
      const progress = progressLine(t);
      const prof = profileById(t.profileId);
      const px = proxyGroupById(t.proxyGroupId);
      const inputLine = t.monitorInput || t.pdpUrl || "";
      const src = t.monitorEnabled
        ? t.monitorSource === "private"
          ? "monitor:private"
          : "monitor:global"
        : "checkout";
      const toggle = activeRun
        ? `<button type="button" class="danger" data-stop-task="${t.id}">Stop</button>`
        : `<button type="button" class="secondary" data-run-task="${t.id}">Start</button>`;
      return `<tr>
        <td>${esc(t.storeName || t.store || "—")}</td>
        <td>
          <div>${esc(t.label || "Task")} <span class="cell-sub">[${esc(src)}]</span></div>
          <div class="cell-sub">${esc(inputLine)}</div>
        </td>
        <td>${esc(prof?.name || "—")}</td>
        <td>${esc(px?.name || (isKmartStoreId(t.storeId) ? "Automatic" : "Direct"))}</td>
        <td>
          <span class="badge ${badge}">${esc(statusLabel)}</span>
          ${progress ? `<div class="cell-sub">${esc(progress)}</div>` : ""}
        </td>
        <td class="col-actions"><div class="row-actions">
          ${toggle}
          <button type="button" class="secondary" data-edit-task="${t.id}">Edit</button>
          <button type="button" class="danger" data-del-task="${t.id}">Del</button>
        </div></td>
      </tr>`;
    })
    .join("");
}

function renderProxyGroups() {
  const el = $("proxyGroupList");
  if (!el) return;
  const rows = state.proxyGroups || [];
  if (!activeProxyGroupId || !rows.some((g) => g.id === activeProxyGroupId)) {
    activeProxyGroupId = rows[0]?.id || null;
  }
  el.innerHTML = rows
    .map(
      (g) => `<button type="button" class="rail-item ${g.id === activeProxyGroupId ? "active" : ""}" data-select-proxy-group="${g.id}">
        <span class="rail-name">${esc(g.name)}</span>
        <span class="rail-count">${g.entries?.length || 0}</span>
      </button>`,
    )
    .join("") || `<div class="hint pad-x" style="padding:12px">No groups yet</div>`;
}

function renderProxies() {
  renderProxyGroups();
  const g = proxyGroupById(activeProxyGroupId);
  $("proxyGroupTitle").textContent = g?.name || "Proxies";
  const n = g?.entries?.length || 0;
  $("proxyGroupMeta").textContent = `${n} prox${n === 1 ? "y" : "ies"} loaded`;

  const el = $("proxyEntryList");
  if (!g) {
    el.innerHTML = `<tr class="table-empty"><td colspan="5">Create a proxy group to get started.</td></tr>`;
    return;
  }
  const results = proxyTestResults.get(g.id) || {};
  const testing = proxyTestingGroupId === g.id;
  const entries = g.entries || [];
  if (!entries.length) {
    el.innerHTML = `<tr class="table-empty"><td colspan="5">No proxies in this group — click Add proxies.</td></tr>`;
    return;
  }
  el.innerHTML = entries
    .map((entry, i) => {
      const r = results[i];
      const badgeCls = !r ? "" : r.ok ? "ok" : r.status === "timeout" ? "run" : "err";
      const status = !r ? (testing ? "Testing…" : "—") : r.label || r.status || (r.ok ? "OK" : "Fail");
      return `<tr>
        <td><code>${esc(entry)}</code></td>
        <td><span class="badge ${badgeCls}">${esc(status)}</span></td>
        <td>${r?.exitIp ? esc(r.exitIp) : "—"}</td>
        <td>${r?.ok ? `${r.latencyMs}ms` : r?.error ? esc(r.error) : "—"}</td>
        <td class="col-actions"><div class="row-actions">
          <button type="button" class="secondary" data-edit-px="${g.id}">Edit</button>
        </div></td>
      </tr>`;
    })
    .join("");
}

function fillProxyProbeStores() {
  const sel = $("proxyProbeStore");
  if (!sel || !probeStores?.stores?.length) return;
  const cur = sel.value;
  sel.innerHTML = probeStores.stores
    .map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`)
    .join("");
  const preferred = cur || probeStores.defaultStoreId || "kmart";
  if (probeStores.stores.some((s) => s.id === preferred)) sel.value = preferred;
  updateProxyProbeNotes();
}

function updateProxyProbeNotes() {
  const notes = $("proxyProbeNotes");
  const sel = $("proxyProbeStore");
  if (!notes || !sel || !probeStores?.stores) return;
  const store = probeStores.stores.find((s) => s.id === sel.value);
  notes.textContent = store?.notes || "Uses local executor CONNECT + store GET (same stack as checkout).";
  const custom = $("proxyProbeCustomUrl");
  if (custom && store?.probeUrl && !custom.dataset.touched) custom.placeholder = store.probeUrl;
}

function renderProfiles() {
  const el = $("profileList");
  const q = ($("profileSearch")?.value || "").trim().toLowerCase();
  let rows = state.profiles || [];
  $("profileRailCount").textContent = String(rows.length);
  $("profileMeta").textContent = `${rows.length} profile${rows.length === 1 ? "" : "s"} loaded`;
  if (q) {
    rows = rows.filter((p) =>
      [p.name, p.email, p.card_name, p.city, p.address1].join(" ").toLowerCase().includes(q),
    );
  }
  if (!rows.length) {
    el.innerHTML = `<tr class="table-empty"><td colspan="6">No profiles yet — click Add profile.</td></tr>`;
    return;
  }
  el.innerHTML = rows
    .map((p) => {
      const card = String(p.card_number || "");
      const last4 = card.slice(-4) || "????";
      return `<tr>
        <td>${esc(p.name || "Profile")}</td>
        <td>${esc(p.email || "—")}</td>
        <td>${esc(p.card_name || "—")}</td>
        <td>•••• ${esc(last4)}</td>
        <td>
          <div>${esc(p.address1 || "—")}</div>
          <div class="cell-sub">${esc([p.city, p.province, p.zip].filter(Boolean).join(" "))}</div>
        </td>
        <td class="col-actions"><div class="row-actions">
          <button type="button" class="secondary" data-edit-prof="${p.id}">Edit</button>
          <button type="button" class="danger" data-del-prof="${p.id}">Del</button>
        </div></td>
      </tr>`;
    })
    .join("");
}

function periodStart(period) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === "week") d.setDate(d.getDate() - 6);
  if (period === "month") d.setDate(1);
  return d.getTime();
}

function renderHome() {
  const results = state.results || [];
  const since = periodStart(homePeriod);
  const inPeriod = results.filter((r) => (r.at || 0) >= since);
  const oks = inPeriod.filter((r) => r.ok && !r.cancelled);
  const label = homeMetric === "spend" ? "Spend" : "Checkouts";
  $("homeStatLabel").textContent =
    homeMetric === "spend" ? `${oks.length} successful · spend N/A` : `${oks.length} Checkouts`;
  $("homeEmpty").hidden = oks.length > 0;
  $("homeEmpty").querySelector("p").textContent =
    homeMetric === "spend" ? "Spend tracking comes later." : "You haven't made any checkouts for this period.";

  const feed = $("checkoutFeed");
  const feedRows = results.filter((r) => r.ok && r.orderNumber).slice(0, 30);
  if (!feedRows.length) {
    feed.innerHTML = `<div class="hint">Successful checkouts will show up here.</div>`;
    return;
  }
  feed.innerHTML = feedRows
    .map((r) => {
      const task = (state.tasks || []).find((t) => t.id === r.taskId);
      return `<div class="feed-item">
        <strong>${esc(task?.label || r.orderNumber || r.runId)}</strong>
        <div class="feed-meta">
          <span class="badge ok">Order</span>
          <span>${esc(r.orderNumber || "")}</span>
          <span>${r.at ? new Date(r.at).toLocaleString() : ""}</span>
        </div>
      </div>`;
    })
    .join("");
}

function renderSettings() {
  const s = state.settings || {};
  $("setApiKey").value = s.apiKey || "";
  $("setControlPlane").value = s.controlPlaneUrl || "";
  $("setHyper").value = s.hyperApiKey || "";
  $("setMax").value = s.maxConcurrent ?? 5;
  $("setPlaceOrder").checked = s.placeOrderDefault !== false;
  $("licenseMsg").textContent = s.licenseMessage
    ? `License: ${s.licenseStatus} — ${s.licenseMessage}`
    : `License: ${s.licenseStatus || "unknown"}`;
}

function formatMonitorTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const base = d.toLocaleTimeString([], {
    hour12: true,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return base.replace(/(\d{1,2}:\d{2}:\d{2})/, `$1.${ms}`);
}

function formatMonitorPrice(e) {
  if (e.price == null || !Number.isFinite(Number(e.price))) return null;
  const n = Number(e.price);
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

function monitorTypeLabel(type) {
  if (type === "new") return "NewProduct";
  if (type === "restock") return "Restock";
  return type || "Update";
}

function renderMonitorFeed() {
  const feed = state?.monitorFeed || { status: "offline", recent: [], eventsPerMin: 0 };
  const badge = $("monitorConnBadge");
  const rate = $("monitorRate");
  const list = $("monitorList");
  const empty = $("monitorEmpty");
  if (!list) return;

  const st = feed.status || "offline";
  if (badge) {
    badge.textContent = st === "live" ? "Live" : st === "reconnecting" ? "Reconnecting" : st === "connecting" ? "Connecting" : "Offline";
    badge.className = `badge ${st === "live" ? "ok" : st === "offline" ? "err" : "run"}`;
  }
  if (rate) rate.textContent = `${feed.eventsPerMin || 0}/min`;

  const q = ($("monitorFilter")?.value || "").trim().toLowerCase();
  let rows = Array.isArray(feed.recent) ? feed.recent.slice() : [];
  // Never show chrome/garbage titles (bad server parses or stale feed).
  rows = rows.filter((e) => {
    const t = String(e?.title || "").trim();
    if (t.length < 5) return false;
    if (/^(footer|header|menu|nav|home|search|cart|login|account|kmart|shop|categories|untitled)/i.test(t)) {
      return false;
    }
    return true;
  });
  if (q) {
    rows = rows.filter((e) =>
      [e.title, e.sku, e.url, e.type, ...(e.sizes || [])].join(" ").toLowerCase().includes(q),
    );
  }

  if (empty) empty.hidden = rows.length > 0;
  if (!rows.length) {
    list.innerHTML = "";
    return;
  }

  list.innerHTML = rows
    .map((e) => {
      const price = formatMonitorPrice(e);
      const typeLabel = monitorTypeLabel(e.type);
      const sizes = Array.isArray(e.sizes) ? e.sizes.filter(Boolean) : [];
      const sizeBlock = sizes.length
        ? `<div class="mf-sizes-label">Available sizes</div>
           <div class="mf-sizes">${sizes.map((s) => `<span class="mf-chip" title="${esc(s)}">${esc(s)}</span>`).join("")}</div>`
        : e.sku
          ? `<div class="mf-sizes-label">SKU</div>
             <div class="mf-sizes"><span class="mf-chip">${esc(e.sku)}</span></div>`
          : "";
      const thumb = e.imageUrl
        ? `<img class="mf-thumb" src="${esc(e.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : `<div class="mf-thumb mf-thumb-fallback">Kmart</div>`;
      const input = e.url || e.sku || "";
      return `<article class="mf-card" role="listitem" data-monitor-id="${esc(e.id || "")}">
        ${thumb}
        <div class="mf-card-body">
          <div class="mf-card-top">
            <h3 class="mf-title">${esc(e.title || "Untitled product")}</h3>
            <time class="mf-time">${esc(formatMonitorTime(e.detectedAt))}</time>
          </div>
          <div class="mf-meta">
            ${price ? `<span class="mf-price">${esc(price)}</span>` : ""}
            <span class="mf-site">↗ <a href="${esc(e.url || "#")}" data-open-monitor-url="${esc(encodeURIComponent(e.url || ""))}">Kmart</a></span>
            <span class="mf-tag">${esc(typeLabel)}</span>
            ${e.inStock === false ? `<span class="mf-tag">OOS</span>` : ""}
          </div>
          ${sizeBlock}
          <div class="mf-actions">
            <button type="button" class="mf-action" data-create-from-monitor="${esc(encodeURIComponent(input))}">
              <span class="ico">⚡</span> Launch Quicktask
            </button>
            <button type="button" class="mf-action" data-copy-monitor-url="${esc(encodeURIComponent(e.url || ""))}">
              <span class="ico">🔗</span> Copy link
            </button>
          </div>
        </div>
      </article>`;
    })
    .join("");
}

function applyState(next) {
  state = next;
  fillTaskSelects();
  renderTasks();
  renderProxies();
  renderProfiles();
  renderHome();
  renderSettings();
  renderMonitorFeed();
}

function appendLog(html, cls) {
  const log = $("liveLog");
  if (!log) return;
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.innerHTML = html;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

async function refresh() {
  applyState(await window.desktop.getState());
}

function openDialog(el) {
  if (typeof el.showModal === "function") el.showModal();
  else el.setAttribute("open", "");
}
function closeDialog(el) {
  if (typeof el.close === "function") el.close();
  else el.removeAttribute("open");
}

function resetTaskForm() {
  editingTask = false;
  $("taskId").value = "";
  $("taskFormTitle").textContent = "+ New task";
  $("taskSubmitBtn").textContent = "Create task";
  $("taskQuantityWrap").hidden = false;
  $("taskForm").reset();
  $("taskPlaceOrder").checked = true;
  $("taskQuantity").value = "1";
  $("taskQty").value = "1";
  if ($("taskMonitorEnabled")) $("taskMonitorEnabled").checked = false;
  if ($("taskMonitorSource")) $("taskMonitorSource").value = "global";
  $("addStoreFields").hidden = true;
  fillTaskSelects();
}

function openCreateTask() {
  resetTaskForm();
  openDialog($("taskDialog"));
}

function openEditTask(task) {
  editingTask = true;
  fillTaskSelects();
  $("taskId").value = task.id;
  $("taskFormTitle").textContent = "Edit task";
  $("taskSubmitBtn").textContent = "Save task";
  $("taskQuantityWrap").hidden = true;
  $("taskLabel").value = task.label || "";
  if (task.storeId && storeById(task.storeId)) $("taskStore").value = task.storeId;
  $("taskPdp").value = task.monitorInput || task.pdpUrl || "";
  if ($("taskMonitorEnabled")) $("taskMonitorEnabled").checked = task.monitorEnabled === true;
  if ($("taskMonitorSource")) $("taskMonitorSource").value = task.monitorSource === "private" ? "private" : "global";
  $("taskQty").value = task.qty || 1;
  $("taskProfile").value = task.profileId || "";
  $("taskProxy").value = task.proxyGroupId || "";
  $("taskPlaceOrder").checked = task.placeOrder !== false;
  $("addStoreFields").hidden = true;
  updateTaskFormForStore();
  openDialog($("taskDialog"));
}

function openCreateProfile() {
  $("profId").value = "";
  $("profileFormTitle").textContent = "New profile";
  $("profileForm").reset();
  openDialog($("profileDialog"));
}

function openEditProfile(p) {
  $("profileFormTitle").textContent = "Edit profile";
  $("profId").value = p.id;
  $("profName").value = p.name || "";
  $("profFirst").value = p.first_name || "";
  $("profLast").value = p.last_name || "";
  $("profEmail").value = p.email || "";
  $("profPhone").value = p.phone || "";
  $("profAddress1").value = p.address1 || "";
  $("profCity").value = p.city || "";
  $("profProvince").value = p.province || "";
  $("profZip").value = p.zip || "";
  $("profCardNumber").value = p.card_number || "";
  $("profCardName").value = p.card_name || "";
  $("profMm").value = p.card_exp_month || "";
  $("profYy").value = p.card_exp_year || "";
  $("profCvv").value = p.card_cvv || "";
  openDialog($("profileDialog"));
}

function openCreateProxy() {
  $("pxId").value = "";
  $("proxyFormTitle").textContent = "New proxy group";
  $("proxyForm").reset();
  openDialog($("proxyDialog"));
}

function openEditProxy(g) {
  $("proxyFormTitle").textContent = "Edit proxy group";
  $("pxId").value = g.id;
  $("pxName").value = g.name || "";
  $("pxEntries").value = (g.entries || []).join("\n");
  openDialog($("proxyDialog"));
}

async function addGroupPrompt(defaultName = "") {
  const name = window.prompt("New group name", defaultName);
  if (!name) return;
  const res = await window.desktop.upsertTaskGroup({ name });
  if (res.snapshot) applyState(res.snapshot);
  else if (!res.ok) appendLog(esc(res.error), "err");
}

$("btnOpenCreateTask").onclick = () => openCreateTask();
$("btnOpenCreateProfile").onclick = () => openCreateProfile();
$("btnOpenCreateProxy").onclick = () => openCreateProxy();
$("btnAddProxies").onclick = () => {
  const g = proxyGroupById(activeProxyGroupId);
  if (g) openEditProxy(g);
  else openCreateProxy();
};
$("taskDialogClose").onclick = () => closeDialog($("taskDialog"));
$("profileDialogClose").onclick = () => closeDialog($("profileDialog"));
$("proxyDialogClose").onclick = () => closeDialog($("proxyDialog"));

$("taskStore").onchange = () => {
  if ($("taskStore").value === "__add") $("addStoreFields").hidden = false;
  else {
    $("addStoreFields").hidden = true;
    updateTaskFormForStore();
  }
};
if ($("taskMonitorSource")) {
  $("taskMonitorSource").onchange = () => updateTaskFormForStore();
}
if ($("taskMonitorEnabled")) {
  $("taskMonitorEnabled").onchange = () => updateTaskFormForStore();
}
if ($("monitorFilter")) {
  $("monitorFilter").oninput = () => renderMonitorFeed();
}
document.querySelectorAll("[data-mf-pane]").forEach((btn) => {
  btn.onclick = () => {
    const pane = btn.dataset.mfPane;
    document.querySelectorAll(".mf-tab").forEach((b) => b.classList.toggle("active", b === btn));
    const feed = $("mfPaneFeed");
    const smart = $("mfPaneSmart");
    if (feed) feed.classList.toggle("active", pane === "feed");
    if (smart) smart.classList.toggle("active", pane === "smart");
  };
});
if ($("btnMonitorConnect")) {
  $("btnMonitorConnect").onclick = async () => {
    const res = await window.desktop.monitorFeedConnect();
    if (res?.ok === false) appendLog(esc(res.error || "Global monitor reconnect failed"), "err");
    else appendLog("Global monitor reconnecting…", "muted");
    await refresh();
  };
}
$("btnCancelCustomStore").onclick = () => {
  $("addStoreFields").hidden = true;
  fillTaskSelects();
};
$("btnSaveCustomStore").onclick = async () => {
  const res = await window.desktop.addCustomStore({
    name: $("newStoreName").value,
    url: $("newStoreUrl").value,
  });
  if (!res.ok) {
    appendLog(esc(res.error || "Could not add store"), "err");
    return;
  }
  if (res.snapshot) applyState(res.snapshot);
  $("addStoreFields").hidden = true;
  $("newStoreName").value = "";
  $("newStoreUrl").value = "";
  if (res.store?.id) $("taskStore").value = res.store.id;
  updateTaskFormForStore();
};

$("taskSearch").oninput = () => renderTasks();
$("profileSearch").oninput = () => renderProfiles();

document.querySelectorAll("[data-home-metric]").forEach((b) => {
  b.onclick = () => {
    homeMetric = b.dataset.homeMetric;
    document.querySelectorAll("[data-home-metric]").forEach((x) => x.classList.toggle("active", x === b));
    renderHome();
  };
});
document.querySelectorAll("[data-home-period]").forEach((b) => {
  b.onclick = () => {
    homePeriod = b.dataset.homePeriod;
    document.querySelectorAll("[data-home-period]").forEach((x) => x.classList.toggle("active", x === b));
    renderHome();
  };
});

$("btnStartGroup").onclick = async () => {
  const ids = (state.tasks || []).filter((t) => t.groupId === activeGroupId()).map((t) => t.id);
  if (!ids.length) {
    appendLog("No tasks in this group", "err");
    return;
  }
  const res = await window.desktop.runTasks(ids);
  if (!res.ok) appendLog(esc(res.error), "err");
  else appendLog(
    res.checkout
      ? `Checkout ${res.checkout}, monitoring ${res.monitoring ?? 0}`
      : `Monitoring ${res.monitoring ?? res.enqueued ?? ids.length} task(s)`,
    "ok",
  );
  if (res.snapshot) applyState(res.snapshot);
};

$("btnStopGroup").onclick = async () => {
  const ids = (state.tasks || []).filter((t) => t.groupId === activeGroupId() && taskIsActive(t)).map((t) => t.id);
  for (const id of ids) await window.desktop.stopTask(id);
  appendLog(ids.length ? `Stopped ${ids.length} task(s)` : "Nothing running", "muted");
  await refresh();
};

$("btnClearTasks").onclick = async () => {
  const ids = (state.tasks || []).filter((t) => t.groupId === activeGroupId()).map((t) => t.id);
  if (!ids.length) return;
  if (!window.confirm(`Clear ${ids.length} task(s) in this group?`)) return;
  for (const id of ids) await window.desktop.deleteTask(id);
  await refresh();
};

$("btnClearProfiles").onclick = async () => {
  const ids = (state.profiles || []).map((p) => p.id);
  if (!ids.length) return;
  if (!window.confirm(`Delete all ${ids.length} profiles?`)) return;
  for (const id of ids) await window.desktop.deleteProfile(id);
  await refresh();
};

$("btnClearProxies").onclick = async () => {
  const g = proxyGroupById(activeProxyGroupId);
  if (!g) return;
  if (!window.confirm(`Clear all proxies in "${g.name}"?`)) return;
  applyState(await window.desktop.upsertProxyGroup({ id: g.id, name: g.name, entriesText: "" }));
};

$("btnTestProxies").onclick = async () => {
  const groupId = activeProxyGroupId;
  if (!groupId) return;
  proxyTestingGroupId = groupId;
  proxyTestResults.set(groupId, {});
  renderProxies();
  appendLog("Testing proxies…", "muted");
  try {
    const res = await window.desktop.testProxyGroup({
      groupId,
      storeId: $("proxyProbeStore")?.value || "kmart",
      customUrl: $("proxyProbeCustomUrl")?.value?.trim() || null,
    });
    if (!res.ok) appendLog(esc(res.error || "Proxy test failed"), "err");
    else {
      const map = {};
      (res.results || []).forEach((r, i) => {
        map[i] = r;
      });
      proxyTestResults.set(groupId, map);
      appendLog(
        `Proxy test done — ${res.summary?.ok ?? 0}/${res.summary?.total ?? 0} ok`,
        res.summary?.fail ? "err" : "ok",
      );
    }
  } catch (e) {
    appendLog(esc(e?.message || String(e)), "err");
  } finally {
    proxyTestingGroupId = null;
    renderProxies();
  }
};

document.body.addEventListener("click", async (e) => {
  const raw = e.target;
  if (!(raw instanceof HTMLElement)) return;
  const t = raw.closest("[data-select-group],[data-select-proxy-group],[data-edit-task],[data-del-task],[data-run-task],[data-stop-task],[data-copy-monitor-url],[data-create-from-monitor],[data-open-monitor-url],[data-edit-prof],[data-del-prof],[data-edit-px],[data-del-px]") || raw;

  if (raw.id === "btnAddGroup" || raw.id === "btnEmptyAddGroup" || t.id === "btnAddGroup" || t.id === "btnEmptyAddGroup") {
    await addGroupPrompt();
    return;
  }
  if (raw.id === "btnEmptyGoProfiles") {
    setTab("profiles");
    return;
  }
  if (t.dataset.selectGroup) {
    applyState(await window.desktop.setActiveGroup(t.dataset.selectGroup));
    return;
  }
  if (t.dataset.selectProxyGroup) {
    activeProxyGroupId = t.dataset.selectProxyGroup;
    renderProxies();
    return;
  }
  if (t.dataset.editTask) {
    const task = state.tasks.find((x) => x.id === t.dataset.editTask);
    if (task) openEditTask(task);
  }
  if (t.dataset.delTask) applyState(await window.desktop.deleteTask(t.dataset.delTask));
  if (t.dataset.runTask) {
    const res = await window.desktop.runTasks([t.dataset.runTask]);
    if (!res.ok) appendLog(esc(res.error), "err");
    else appendLog(
      res.checkout
        ? `Checkout ${res.checkout}, monitoring ${res.monitoring ?? 0}`
        : `Monitoring ${res.monitoring ?? res.enqueued ?? 0} task(s)`,
      "ok",
    );
    if (res.snapshot) applyState(res.snapshot);
  }
  if (t.dataset.copyMonitorUrl) {
    e.preventDefault();
    let url = t.dataset.copyMonitorUrl;
    try { url = decodeURIComponent(url); } catch { /* keep */ }
    if (url && navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => appendLog("Copied link", "muted")).catch(() => {});
    }
  }
  if (t.dataset.createFromMonitor) {
    e.preventDefault();
    let input = t.dataset.createFromMonitor;
    try { input = decodeURIComponent(input); } catch { /* keep */ }
    resetTaskForm();
    $("taskPdp").value = input;
    if ($("taskMonitorEnabled")) $("taskMonitorEnabled").checked = true;
    if ($("taskMonitorSource")) $("taskMonitorSource").value = "global";
    updateTaskFormForStore();
    setTab("tasks");
    openDialog($("taskDialog"));
  }
  if (t.dataset.openMonitorUrl) {
    e.preventDefault();
    let url = t.dataset.openMonitorUrl;
    try { url = decodeURIComponent(url); } catch { /* keep */ }
    if (url) window.open(url, "_blank", "noopener");
  }
  if (t.dataset.stopTask) {
    const res = await window.desktop.stopTask(t.dataset.stopTask);
    appendLog("Task stopped", "muted");
    if (res.snapshot) applyState(res.snapshot);
  }
  if (t.dataset.editProf) {
    const p = state.profiles.find((x) => x.id === t.dataset.editProf);
    if (p) openEditProfile(p);
  }
  if (t.dataset.delProf) applyState(await window.desktop.deleteProfile(t.dataset.delProf));
  if (t.dataset.editPx) {
    const g = state.proxyGroups.find((x) => x.id === t.dataset.editPx);
    if (g) openEditProxy(g);
  }
  if (t.dataset.delPx) applyState(await window.desktop.deleteProxyGroup(t.dataset.delPx));
});

// Long-press rename/delete on task group rail via context menu
$("taskGroupList").addEventListener("contextmenu", async (e) => {
  const btn = e.target.closest("[data-select-group]");
  if (!btn) return;
  e.preventDefault();
  const g = (state.taskGroups || []).find((x) => x.id === btn.dataset.selectGroup);
  if (!g) return;
  const action = window.prompt(`Group "${g.name}" — type rename or delete`, "rename");
  if (!action) return;
  if (/^del/i.test(action)) {
    if (window.confirm(`Delete group "${g.name}"? Tasks won't be deleted.`)) {
      const res = await window.desktop.deleteTaskGroup(g.id);
      if (res.snapshot) applyState(res.snapshot);
      else if (!res.ok) appendLog(esc(res.error), "err");
    }
  } else {
    const next = window.prompt("Rename group", g.name);
    if (next) {
      const res = await window.desktop.upsertTaskGroup({ id: g.id, name: next });
      if (res.snapshot) applyState(res.snapshot);
    }
  }
});

$("taskForm").onsubmit = async (e) => {
  e.preventDefault();
  if ($("taskStore").value === "__add") {
    appendLog("Save the custom store first", "err");
    return;
  }
  if (!$("taskProfile").value) {
    appendLog("Select a profile", "err");
    return;
  }
  const monitorInput = $("taskPdp").value.trim();
  const payload = {
    id: $("taskId").value || undefined,
    groupId: activeGroupId(),
    storeId: $("taskStore").value,
    label: $("taskLabel").value,
    monitorInput,
    monitorEnabled: $("taskMonitorEnabled")?.checked === true,
    monitorSource: $("taskMonitorSource")?.value === "private" ? "private" : "global",
    pdpUrl: monitorInput,
    qty: Number($("taskQty").value),
    profileId: $("taskProfile").value || null,
    proxyGroupId: $("taskProxy").value || null,
    placeOrder: $("taskPlaceOrder").checked,
  };
  if (editingTask && payload.id) {
    applyState(await window.desktop.upsertTask(payload));
  } else {
    const n = Number($("taskQuantity").value) || 1;
    const res = await window.desktop.createTasks(payload, n);
    if (res.snapshot) applyState(res.snapshot);
    appendLog(`Created ${res.created || n} task(s)`, "ok");
  }
  closeDialog($("taskDialog"));
  resetTaskForm();
};

$("profileForm").onsubmit = async (e) => {
  e.preventDefault();
  applyState(
    await window.desktop.upsertProfile({
      id: $("profId").value || undefined,
      name: $("profName").value,
      first_name: $("profFirst").value,
      last_name: $("profLast").value,
      email: $("profEmail").value,
      phone: $("profPhone").value,
      address1: $("profAddress1").value,
      city: $("profCity").value,
      province: $("profProvince").value,
      zip: $("profZip").value,
      card_number: $("profCardNumber").value,
      card_name: $("profCardName").value,
      card_exp_month: $("profMm").value,
      card_exp_year: $("profYy").value,
      card_cvv: $("profCvv").value,
    }),
  );
  closeDialog($("profileDialog"));
};

$("proxyForm").onsubmit = async (e) => {
  e.preventDefault();
  const snap = await window.desktop.upsertProxyGroup({
    id: $("pxId").value || undefined,
    name: $("pxName").value,
    entriesText: $("pxEntries").value,
  });
  applyState(snap);
  const created = (snap.proxyGroups || []).find((g) => g.name === $("pxName").value);
  if (created) activeProxyGroupId = created.id;
  closeDialog($("proxyDialog"));
};

$("btnSaveSettings").onclick = async () => {
  applyState(
    await window.desktop.saveSettings({
      apiKey: $("setApiKey").value.trim(),
      controlPlaneUrl: $("setControlPlane").value.trim().replace(/\/$/, ""),
      hyperApiKey: $("setHyper").value.trim(),
      maxConcurrent: Number($("setMax").value) || 5,
      placeOrderDefault: $("setPlaceOrder").checked,
    }),
  );
  appendLog("Settings saved", "muted");
  const started = await window.desktop.startEngine();
  if (started.snapshot) applyState(started.snapshot);
  if (!started.ok) appendLog(esc(started.error || "Engine not ready"), "err");
};

$("btnValidate").onclick = async () => {
  await $("btnSaveSettings").onclick();
  const res = await window.desktop.validateLicense();
  if (res.snapshot) applyState(res.snapshot);
  appendLog(esc(res.message || (res.ok ? "OK" : "Invalid")), res.ok ? "ok" : "err");
};

function patchTaskLive(taskId, patch) {
  if (!state?.tasks || !taskId) return;
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  Object.assign(t, patch);
  renderTasks();
}

window.desktop.onEvent((evt) => {
  if (evt.type === "snapshot" && evt.data) applyState(evt.data);
  if (evt.type === "queue" || evt.type === "runner") {
    if (state) {
      state.runner = {
        running: evt.running,
        inflight: evt.inflight,
        queued: evt.queued,
        maxConcurrent: evt.maxConcurrent,
      };
    }
  }
  if (evt.type === "proxy-test" && evt.groupId != null) {
    const map = proxyTestResults.get(evt.groupId) || {};
    map[evt.index] = evt.result;
    proxyTestResults.set(evt.groupId, map);
    renderProxies();
  }
  if (evt.type === "monitor") {
    if (evt.taskId && evt.message) {
      patchTaskLive(evt.taskId, {
        lastStatus: evt.phase === "matched" ? "matched" : "monitoring",
        lastProgress: evt.message,
        resolvedPdpUrl: evt.resolvedPdpUrl,
        resolvedSku: evt.resolvedSku,
      });
    }
  }
  if (evt.type === "monitor-feed") {
    if (state) {
      state.monitorFeed = {
        status: evt.status || state.monitorFeed?.status || "offline",
        recent: evt.recent || state.monitorFeed?.recent || [],
        eventsPerMin: evt.eventsPerMin ?? state.monitorFeed?.eventsPerMin ?? 0,
        feedUrl: evt.feedUrl || state.monitorFeed?.feedUrl,
      };
      if (evt.phase === "event" && evt.event) {
        const recent = state.monitorFeed.recent || [];
        if (!recent.find((x) => x.id === evt.event.id)) {
          state.monitorFeed.recent = [evt.event, ...recent].slice(0, 80);
        }
        appendLog(`FEED ${esc(evt.event.type)} ${esc(evt.event.title || evt.event.sku || "")}`, "ok");
      }
      renderMonitorFeed();
    }
  }
  if (evt.type === "job") {
    if (evt.phase === "start") {
      appendLog(`START ${esc(evt.runId)} — ${esc(evt.label || "")}`, "muted");
      patchTaskLive(evt.taskId, { lastStatus: "running", lastProgress: "Starting…", lastError: null });
    } else if (evt.phase === "log") {
      const cls = evt.level === "err" ? "err" : evt.level === "ok" ? "ok" : "muted";
      appendLog(`${esc(evt.runId)} ${esc(evt.message || "")}`, cls);
    } else if (evt.phase === "progress") {
      const line =
        evt.message ||
        (evt.progress
          ? `${evt.progress.label || evt.progress.stage}${evt.progress.step ? " [" + evt.progress.step + "]" : ""}${
              evt.progress.detail || evt.progress.hint ? " — " + (evt.progress.detail || evt.progress.hint) : ""
            }`
          : null);
      if (line) {
        appendLog(`${esc(evt.runId)} · ${esc(line)}`, "muted");
        patchTaskLive(evt.taskId, { lastStatus: "running", lastProgress: line });
      }
    } else if (evt.phase === "done") {
      appendLog(
        evt.cancelled
          ? `STOPPED ${esc(evt.runId)}`
          : evt.ok
            ? `OK ${esc(evt.runId)}${evt.orderNumber ? " order " + esc(evt.orderNumber) : ""}`
            : `FAIL ${esc(evt.runId)} — ${esc(evt.error || "checkout failed")}`,
        evt.cancelled ? "muted" : evt.ok ? "ok" : "err",
      );
      refresh();
    }
  }
});

async function boot() {
  try {
    probeStores = await window.desktop.listProxyProbeStores();
    fillProxyProbeStores();
  } catch {
    /* older preload */
  }
  const storeSel = $("proxyProbeStore");
  if (storeSel) storeSel.onchange = updateProxyProbeNotes;
  const custom = $("proxyProbeCustomUrl");
  if (custom) custom.addEventListener("input", () => { custom.dataset.touched = "1"; });
  await refresh();
}

boot();
