/* global desktop from preload */
const $ = (id) => document.getElementById(id);

let state = null;

function setTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${name}`);
  });
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => setTab(b.dataset.tab);
});

function engineUi() {
  const eng = state?.engine || {};
  const run = state?.runner || {};
  const dot = $("engineDot");
  const label = $("engineLabel");
  if (eng.running && run.inflight > 0) {
    dot.className = "dot busy";
    label.textContent = `Engine on · ${run.inflight} in flight · ${run.queued} queued`;
  } else if (eng.running) {
    dot.className = "dot on";
    label.textContent = `Engine on · port ${eng.port} · Hyper ${eng.hyperConfigured ? "ready" : "missing"}`;
  } else {
    dot.className = "dot";
    label.textContent = "Engine offline — app must stay open to run";
  }
}

function fillSelects() {
  const prof = $("taskProfile");
  const px = $("taskProxy");
  const curP = prof.value;
  const curX = px.value;
  prof.innerHTML = `<option value="">Select profile…</option>` +
    (state.profiles || []).map((p) => `<option value="${p.id}">${esc(p.name || p.email || p.id)}</option>`).join("");
  px.innerHTML = `<option value="">Direct (no proxy)</option>` +
    (state.proxyGroups || []).map((g) => `<option value="${g.id}">${esc(g.name)} (${g.entries?.length || 0})</option>`).join("");
  if (curP) prof.value = curP;
  if (curX) px.value = curX;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function renderTasks() {
  const el = $("taskList");
  const tasks = state.tasks || [];
  if (!tasks.length) {
    el.innerHTML = `<div class="item"><div><strong>No tasks yet</strong><div class="meta">Create a Kmart task on the right.</div></div></div>`;
    return;
  }
  el.innerHTML = tasks
    .map((t) => {
      const statusLabel = t.lastLabel || t.lastStatus || "idle";
      const badge =
        t.lastStatus === "confirmed" || t.lastStatus === "complete" || t.lastStatus === "ok"
          ? "ok"
          : t.lastStatus === "failed" ||
              t.lastStatus === "error" ||
              t.lastStatus === "akamai" ||
              t.lastStatus === "proxy" ||
              t.lastStatus === "declined" ||
              t.lastStatus === "oos"
            ? "err"
            : t.lastStatus === "queued"
              ? "run"
              : "";
      return `<div class="item">
        <div>
          <strong>${esc(t.label || "Task")}</strong>
          <span class="badge ${badge}">${esc(statusLabel)}</span>
          <div class="meta">${esc(t.pdpUrl)}</div>
          <div class="meta">qty ${t.qty} × ${t.quantity} jobs${t.lastOrderNumber ? ` · ${esc(t.lastOrderNumber)}` : ""}</div>
        </div>
        <div class="actions">
          <button type="button" class="secondary" data-edit-task="${t.id}">Edit</button>
          <button type="button" data-run-task="${t.id}">Run</button>
          <button type="button" class="danger" data-del-task="${t.id}">Del</button>
        </div>
      </div>`;
    })
    .join("");
}

function renderProfiles() {
  const el = $("profileList");
  const rows = state.profiles || [];
  if (!rows.length) {
    el.innerHTML = `<div class="item"><div><strong>No profiles</strong><div class="meta">Add shipping + card details locally.</div></div></div>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (p) => `<div class="item">
      <div>
        <strong>${esc(p.name || "Profile")}</strong>
        <div class="meta">${esc(p.email)} · ${esc(p.city)} ${esc(p.province)} ${esc(p.zip)}</div>
        <div class="meta">Card •••• ${esc(String(p.card_number || "").slice(-4) || "????")}</div>
      </div>
      <div class="actions">
        <button type="button" class="secondary" data-edit-prof="${p.id}">Edit</button>
        <button type="button" class="danger" data-del-prof="${p.id}">Del</button>
      </div>
    </div>`,
    )
    .join("");
}

function renderProxies() {
  const el = $("proxyList");
  const rows = state.proxyGroups || [];
  if (!rows.length) {
    el.innerHTML = `<div class="item"><div><strong>No proxy groups</strong><div class="meta">Add 127.0.0.1:PORT for local managers.</div></div></div>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (g) => `<div class="item">
      <div>
        <strong>${esc(g.name)}</strong>
        <div class="meta">${g.entries?.length || 0} entries</div>
        <div class="meta">${esc((g.entries || []).slice(0, 3).join(" · "))}${(g.entries || []).length > 3 ? "…" : ""}</div>
      </div>
      <div class="actions">
        <button type="button" class="secondary" data-edit-px="${g.id}">Edit</button>
        <button type="button" class="danger" data-del-px="${g.id}">Del</button>
      </div>
    </div>`,
    )
    .join("");
}

function renderResults() {
  const el = $("resultList");
  const rows = state.results || [];
  if (!rows.length) {
    el.innerHTML = `<div class="item"><div class="meta">No results yet.</div></div>`;
    return;
  }
  el.innerHTML = rows
    .map((r) => {
      const cls = r.ok ? "ok" : "err";
      const label =
        r.consumerLabel ||
        (r.ok ? (r.orderNumber ? "Order confirmed" : "Complete") : r.error || "Something went wrong");
      return `<div class="item">
        <div>
          <span class="badge ${cls}">${esc(label)}</span>
          <strong>${esc(r.runId || r.taskId)}</strong>
          <div class="meta">${r.orderNumber ? esc(r.orderNumber) : ""}${r.elapsedMs != null ? `${r.orderNumber ? " · " : ""}${r.elapsedMs}ms` : ""}</div>
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
  $("setPaydockPk").value = s.paydockPublicKey || "";
  $("setMax").value = s.maxConcurrent ?? 5;
  $("setPlaceOrder").checked = s.placeOrderDefault !== false;
  $("licenseMsg").textContent = s.licenseMessage
    ? `License: ${s.licenseStatus} — ${s.licenseMessage}`
    : `License: ${s.licenseStatus || "unknown"}`;
}

function applyState(next) {
  state = next;
  fillSelects();
  renderTasks();
  renderProfiles();
  renderProxies();
  renderResults();
  renderSettings();
  engineUi();
}

function appendLog(html, cls) {
  const log = $("liveLog");
  // Chronological: oldest at top, newest at bottom (was reverse with prepend).
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.innerHTML = html;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

async function refresh() {
  applyState(await window.desktop.getState());
}

// Tabs list delegation
document.body.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.dataset.editTask) {
    const task = state.tasks.find((x) => x.id === t.dataset.editTask);
    if (!task) return;
    $("taskId").value = task.id;
    $("taskFormTitle").textContent = "Edit task";
    $("taskLabel").value = task.label || "";
    $("taskStore").value = task.store || "kmart";
    $("taskPdp").value = task.pdpUrl || "";
    $("taskQty").value = task.qty || 1;
    $("taskQuantity").value = task.quantity || 1;
    $("taskProfile").value = task.profileId || "";
    $("taskProxy").value = task.proxyGroupId || "";
    $("taskPlaceOrder").checked = task.placeOrder !== false;
    setTab("tasks");
  }
  if (t.dataset.delTask) {
    applyState(await window.desktop.deleteTask(t.dataset.delTask));
  }
  if (t.dataset.runTask) {
    const res = await window.desktop.runTasks([t.dataset.runTask]);
    if (!res.ok) appendLog(esc(res.error), "err");
    else appendLog(`Enqueued ${res.enqueued} job(s)`, "ok");
    if (res.snapshot) applyState(res.snapshot);
  }
  if (t.dataset.editProf) {
    const p = state.profiles.find((x) => x.id === t.dataset.editProf);
    if (!p) return;
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
    setTab("profiles");
  }
  if (t.dataset.delProf) {
    applyState(await window.desktop.deleteProfile(t.dataset.delProf));
  }
  if (t.dataset.editPx) {
    const g = state.proxyGroups.find((x) => x.id === t.dataset.editPx);
    if (!g) return;
    $("pxId").value = g.id;
    $("pxName").value = g.name || "";
    $("pxEntries").value = (g.entries || []).join("\n");
    setTab("proxies");
  }
  if (t.dataset.delPx) {
    applyState(await window.desktop.deleteProxyGroup(t.dataset.delPx));
  }
});

$("taskForm").onsubmit = async (e) => {
  e.preventDefault();
  applyState(
    await window.desktop.upsertTask({
      id: $("taskId").value || undefined,
      label: $("taskLabel").value,
      store: $("taskStore").value,
      pdpUrl: $("taskPdp").value,
      qty: Number($("taskQty").value),
      quantity: Number($("taskQuantity").value),
      profileId: $("taskProfile").value || null,
      proxyGroupId: $("taskProxy").value || null,
      placeOrder: $("taskPlaceOrder").checked,
    }),
  );
  $("taskReset").click();
};

$("taskReset").onclick = () => {
  $("taskId").value = "";
  $("taskFormTitle").textContent = "New task";
  $("taskForm").reset();
  $("taskPlaceOrder").checked = true;
};

$("taskRunOne").onclick = async () => {
  const saved = await window.desktop.upsertTask({
    id: $("taskId").value || undefined,
    label: $("taskLabel").value,
    store: $("taskStore").value,
    pdpUrl: $("taskPdp").value,
    qty: Number($("taskQty").value),
    quantity: Number($("taskQuantity").value),
    profileId: $("taskProfile").value || null,
    proxyGroupId: $("taskProxy").value || null,
    placeOrder: $("taskPlaceOrder").checked,
  });
  applyState(saved);
  const pdp = $("taskPdp").value.trim();
  const match = state.tasks.find((t) => t.pdpUrl === pdp) || state.tasks[state.tasks.length - 1];
  if (!match) return;
  const res = await window.desktop.runTasks([match.id]);
  if (!res.ok) appendLog(esc(res.error), "err");
  else appendLog(`Enqueued ${res.enqueued} job(s)`, "ok");
  if (res.snapshot) applyState(res.snapshot);
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
  $("profReset").click();
};
$("profReset").onclick = () => {
  $("profId").value = "";
  $("profileForm").reset();
};

$("proxyForm").onsubmit = async (e) => {
  e.preventDefault();
  applyState(
    await window.desktop.upsertProxyGroup({
      id: $("pxId").value || undefined,
      name: $("pxName").value,
      entriesText: $("pxEntries").value,
    }),
  );
  $("pxReset").click();
};
$("pxReset").onclick = () => {
  $("pxId").value = "";
  $("proxyForm").reset();
};

$("btnSaveSettings").onclick = async () => {
  applyState(
    await window.desktop.saveSettings({
      apiKey: $("setApiKey").value.trim(),
      controlPlaneUrl: $("setControlPlane").value.trim().replace(/\/$/, ""),
      hyperApiKey: $("setHyper").value.trim(),
      paydockPublicKey: $("setPaydockPk").value.trim(),
      maxConcurrent: Number($("setMax").value) || 5,
      placeOrderDefault: $("setPlaceOrder").checked,
    }),
  );
  appendLog("Settings saved", "muted");
};

$("btnValidate").onclick = async () => {
  await $("btnSaveSettings").onclick();
  const res = await window.desktop.validateLicense();
  if (res.snapshot) applyState(res.snapshot);
  appendLog(esc(res.message || (res.ok ? "OK" : "Invalid")), res.ok ? "ok" : "err");
};

$("btnStartEngine").onclick = async () => {
  await $("btnSaveSettings").onclick();
  const res = await window.desktop.startEngine();
  if (res.snapshot) applyState(res.snapshot);
  appendLog(res.ok ? "Engine started" : esc(res.error || "Failed"), res.ok ? "ok" : "err");
};

$("btnStopEngine").onclick = async () => {
  const res = await window.desktop.stopEngine();
  if (res.snapshot) applyState(res.snapshot);
  appendLog("Engine stopped", "muted");
};

$("btnRunAll").onclick = async () => {
  const res = await window.desktop.runTasks([]);
  if (!res.ok) appendLog(esc(res.error), "err");
  else appendLog(`Enqueued ${res.enqueued} job(s)`, "ok");
  if (res.snapshot) applyState(res.snapshot);
};

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
      engineUi();
    }
  }
  if (evt.type === "job") {
    if (evt.phase === "start") {
      appendLog(`${esc(evt.label || evt.runId)} — Starting`, "muted");
    } else if (evt.phase === "log") {
      const cls = evt.level === "err" ? "err" : evt.level === "ok" ? "ok" : "muted";
      appendLog(esc(evt.message || ""), cls);
    } else if (evt.phase === "progress") {
      const line = evt.consumerLabel || evt.message || evt.progress?.label || "Starting";
      appendLog(esc(line), "muted");
    } else if (evt.phase === "done") {
      const label =
        evt.consumerLabel ||
        (evt.ok ? (evt.orderNumber ? "Order confirmed" : "Complete") : evt.error || "Something went wrong");
      appendLog(esc(label), evt.ok ? "ok" : "err");
      refresh();
    }
  }
});

refresh();
