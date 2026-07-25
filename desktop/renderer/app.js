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

function emailBaseClient(email) {
  const raw = String(email || "")
    .trim()
    .toLowerCase();
  const m = raw.match(/^([^@]+)@(.+)$/);
  if (!m) return "";
  let local = m[1].replace(/\+.*$/, "");
  const domain = m[2];
  if (/^(gmail|googlemail)\.com$/i.test(domain)) local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

function fillVaultAccountSelect(storeId = "toymate", selectId = "taskAccountId") {
  const sel = $(selectId);
  if (!sel || !state) return;
  const cur = sel.value;
  const sid = storeId || "toymate";
  const rows = (state.accounts || []).filter((a) => (a.storeId || "toymate") === sid);
  sel.innerHTML =
    `<option value="">Select account…</option>` +
    rows
      .map((a) => `<option value="${esc(a.id)}">${esc(a.email)}${a.status && a.status !== "ready" && a.status !== "active" ? ` (${esc(a.status)})` : ""}</option>`)
      .join("");
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function syncAccountAssignUi() {
  const assign = $("taskAccountAssign")?.value || "auto";
  const manual = $("taskAccountManualWrap");
  const hint = $("taskAccountAutoHint");
  if (manual) manual.hidden = assign !== "manual";
  if (hint) hint.hidden = assign !== "auto";
  if (assign === "manual") fillVaultAccountSelect("toymate", "taskAccountId");
}

function syncBandaiAccountAssignUi() {
  const assign = $("taskBandaiAccountAssign")?.value || "auto";
  const manual = $("taskBandaiAccountManualWrap");
  if (manual) manual.hidden = assign !== "manual";
  if (assign === "manual") fillVaultAccountSelect("bandai", "taskBandaiAccountId");
}

function syncTaskFormForStore() {
  const store = $("taskStore")?.value || "kmart";
  const toy = store === "toymate";
  const bandai = store === "bandai";
  const pc = store === "pokemoncentre";
  const opts = $("taskToymateOpts");
  if (opts) opts.hidden = !toy;
  const bOpts = $("taskBandaiOpts");
  if (bOpts) bOpts.hidden = !bandai;
  const pcOpts = $("taskPcOpts");
  if (pcOpts) pcOpts.hidden = !pc;
  const mode = toy
    ? $("taskToymateMode")?.value || "checkout"
    : bandai
      ? $("taskBandaiMode")?.value || "checkout"
      : pc
        ? $("taskPcMode")?.value || "monitor"
        : "checkout";
  const label = $("taskPdpLabel");
  const input = $("taskPdp");
  if (label) {
    if (bandai) {
      label.textContent =
        mode === "account_gen"
          ? "Store (auto)"
          : mode === "monitor"
            ? "Keywords or product code"
            : mode === "chance"
              ? "Optional product URL"
              : "Product URL / code";
    } else if (toy) {
      label.textContent =
        mode === "account_gen" ? "Store (auto)" : mode === "monitor" ? "Keywords" : "Product URL";
    } else if (pc) {
      label.textContent =
        mode === "edge"
          ? "Storefront (auto en-au)"
          : mode === "monitor" || mode === "har_probe"
            ? "PDP URL or SKU (optional for edge-only feel)"
            : "Product URL / SKU";
    } else {
      label.textContent = "Product URL (PDP)";
    }
  }
  if (input) {
    input.disabled = (toy || bandai) && mode === "account_gen";
    if (bandai) {
      input.placeholder =
        mode === "account_gen"
          ? "Uses IMAP mailbox + profile address"
          : mode === "monitor"
            ? "one piece  OR  N2903432003"
            : mode === "chance"
              ? "optional"
              : "https://p-bandai.com/au|us|nz|sg|hk|tw|fr/item/…";
    } else if (toy) {
      input.placeholder =
        mode === "account_gen"
          ? "Uses profile email/address"
          : mode === "monitor"
            ? "+pokemon -tin"
            : "https://www.toymate.com.au/…";
    } else if (pc) {
      input.placeholder =
        mode === "edge"
          ? "https://www.pokemoncenter.com/en-au/"
          : "https://www.pokemoncenter.com/en-au/product/{sku}/…";
    } else {
      input.placeholder = "https://www.kmart.com.au/...";
    }
  }
  const payWrap = $("taskToymatePayWrap");
  if (payWrap) payWrap.hidden = !toy || mode !== "checkout";
  const passWrap = $("taskAccountPassWrap");
  if (passWrap) passWrap.hidden = !toy || mode !== "account_gen";
  const assignWrap = $("taskAccountAssignWrap");
  if (assignWrap) assignWrap.hidden = !toy || mode !== "checkout";
  const bPass = $("taskBandaiAccountPassWrap");
  if (bPass) bPass.hidden = !bandai || mode !== "account_gen";
  const bAssign = $("taskBandaiAssignWrap");
  if (bAssign) bAssign.hidden = !bandai || (mode !== "checkout" && mode !== "chance");
  const bChance = $("taskBandaiChanceWrap");
  if (bChance) bChance.hidden = !bandai || mode !== "chance";
  const bPayPath = $("taskBandaiCheckoutModeWrap");
  if (bPayPath) bPayPath.hidden = !bandai || mode !== "checkout";
  const placeWrap = $("taskPlaceOrderWrap");
  if (placeWrap) {
    placeWrap.hidden =
      (toy && mode !== "checkout") ||
      (bandai && mode !== "checkout") ||
      (pc && mode !== "checkout");
  }
  if (toy && mode === "checkout") syncAccountAssignUi();
  if (bandai && (mode === "checkout" || mode === "chance")) syncBandaiAccountAssignUi();
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
    el.innerHTML = `<div class="item"><div><strong>No tasks yet</strong><div class="meta">Create a Kmart, Toymate, Bandai, or Pokémon Centre task on the right.</div></div></div>`;
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
      const storeLabel =
        t.store === "toymate"
          ? `Toymate · ${t.toymateMode || "checkout"}`
          : t.store === "bandai"
            ? `Bandai · ${t.bandaiMode || "checkout"}${
                String(t.bandaiMode || "checkout") === "checkout"
                  ? ` · ${t.bandaiCheckoutMode || "fast"}`
                  : ""
              }`
            : t.store === "pokemoncentre"
              ? `Pokémon Centre · ${t.pcMode || "monitor"}`
            : "Kmart";
      let accountMeta = "";
      if (t.store === "toymate" && (t.toymateMode || "checkout") === "checkout") {
        const assign = t.accountAssign || "auto";
        if (assign === "guest") accountMeta = "account: guest";
        else if (assign === "manual") {
          const acc = (state.accounts || []).find((a) => a.id === t.accountId);
          accountMeta = acc ? `account: ${acc.email}` : "account: manual (missing)";
        } else {
          const prof = (state.profiles || []).find((p) => p.id === t.profileId);
          const base = emailBaseClient(prof?.email);
          const n = (state.accounts || []).filter(
            (a) => (a.storeId || "toymate") === "toymate" && emailBaseClient(a.email) === base,
          ).length;
          accountMeta = base ? `account: auto (${n} match ${base})` : "account: auto (no profile email)";
        }
      }
      if (
        t.store === "bandai" &&
        ["checkout", "chance"].includes(String(t.bandaiMode || "checkout"))
      ) {
        const assign = t.accountAssign || "auto";
        if (assign === "manual") {
          const acc = (state.accounts || []).find((a) => a.id === t.accountId);
          accountMeta = acc ? `account: ${acc.email}` : "account: manual (missing)";
        } else {
          const prof = (state.profiles || []).find((p) => p.id === t.profileId);
          const base = emailBaseClient(prof?.email);
          const n = (state.accounts || []).filter(
            (a) => (a.storeId || "") === "bandai" && emailBaseClient(a.email) === base,
          ).length;
          accountMeta = base ? `account: auto (${n} match ${base})` : "account: auto (no profile email)";
        }
      }
      const pdpMeta =
        t.pdpUrl ||
        (t.toymateMode === "account_gen" || t.bandaiMode === "account_gen" ? "account gen" : "");
      return `<div class="item">
        <div>
          <strong>${esc(t.label || "Task")}</strong>
          <span class="badge ${badge}">${esc(statusLabel)}</span>
          <div class="meta">${esc(storeLabel)} · ${esc(pdpMeta)}</div>
          <div class="meta">qty ${t.qty} × ${t.quantity} jobs${t.lastOrderNumber ? ` · ${esc(t.lastOrderNumber)}` : ""}${accountMeta ? ` · ${esc(accountMeta)}` : ""}</div>
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

function accountStatusBadge(status) {
  const s = String(status || "unknown").toLowerCase();
  if (s === "ready" || s === "active") return "ok";
  if (s === "created" || s === "needs_sms" || s === "needs_terms") return "warn";
  if (s === "banned" || s === "burned" || s === "disabled" || s === "register_failed") return "err";
  return "";
}

function renderAccounts() {
  const el = $("accountList");
  if (!el) return;
  const rows = state.accounts || [];
  if (!rows.length) {
    el.innerHTML = `<div class="item"><div><strong>No accounts yet</strong><div class="meta">Run a Toymate or Bandai Account gen task.</div></div></div>`;
    return;
  }
  el.innerHTML = rows
    .map((a) => {
      const prof = (state.profiles || []).find((p) => p.id === a.profileId);
      const match =
        prof?.email && emailBaseClient(prof.email) === emailBaseClient(a.email)
          ? `profile ${prof.name || prof.email}`
          : a.emailBase || emailBaseClient(a.email);
      const st = a.status || "unknown";
      const badge = accountStatusBadge(st);
      return `<div class="item">
        <div>
          <strong>${esc(a.email)}</strong>
          <span class="badge ok">${esc(a.storeName || a.storeId || "store")}</span>
          <span class="badge ${badge}">${esc(st)}</span>
          <div class="meta"><code>${esc(a.password || "")}</code></div>
          <div class="meta">match ${esc(match)}${a.lastUsedAt ? ` · used ${new Date(a.lastUsedAt).toLocaleString()}` : ""}</div>
          <div class="meta">${a.createdAt ? new Date(a.createdAt).toLocaleString() : ""}</div>
        </div>
        <div class="actions">
          <button type="button" class="secondary" data-copy-acc-email="${esc(a.id)}">Email</button>
          <button type="button" class="secondary" data-copy-acc-pass="${esc(a.id)}">Pass</button>
          <button type="button" class="danger" data-del-acc="${esc(a.id)}">Del</button>
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
  if ($("setCapsolver")) $("setCapsolver").value = s.capsolverApiKey || "";
  if ($("setSmspool")) $("setSmspool").value = s.smspoolApiKey || "";
  if ($("setSmsProvider")) $("setSmsProvider").value = s.smsProvider || "auto";
  if ($("setSmspoolCountry")) $("setSmspoolCountry").value = s.smspoolCountry || "GB";
  if ($("setOnlinesim")) $("setOnlinesim").value = s.onlinesimApiKey || "";
  if ($("setOnlinesimMode")) $("setOnlinesimMode").value = s.onlinesimMode || "rent";
  if ($("setOnlinesimSlug")) $("setOnlinesimSlug").value = s.onlinesimServiceSlug || "other";
  if ($("setImapHost")) $("setImapHost").value = s.imapHost || "";
  if ($("setImapPort")) $("setImapPort").value = s.imapPort ?? 993;
  if ($("setImapMailbox")) $("setImapMailbox").value = s.imapMailbox || "INBOX";
  if ($("setImapUser")) $("setImapUser").value = s.imapUser || "";
  if ($("setImapAppPassword")) $("setImapAppPassword").value = s.imapAppPassword || "";
  $("setMax").value = s.maxConcurrent ?? 5;
  $("setPlaceOrder").checked = s.placeOrderDefault !== false;
  $("licenseMsg").textContent = s.licenseMessage
    ? `License: ${s.licenseStatus} — ${s.licenseMessage}`
    : `License: ${s.licenseStatus || "unknown"}`;
}

function applyState(next) {
  state = next;
  fillSelects();
  syncTaskFormForStore();
  renderTasks();
  renderProfiles();
  renderAccounts();
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
    if ($("taskToymateMode")) $("taskToymateMode").value = task.toymateMode || "checkout";
    if ($("taskToymatePay")) $("taskToymatePay").value = task.paymentMethod || "credit_card";
    if ($("taskAccountPassword")) $("taskAccountPassword").value = task.accountPassword || "";
    if ($("taskAccountAssign")) $("taskAccountAssign").value = task.accountAssign || "auto";
    if ($("taskBandaiMode")) $("taskBandaiMode").value = task.bandaiMode || "checkout";
    if ($("taskBandaiCheckoutMode"))
      $("taskBandaiCheckoutMode").value = task.bandaiCheckoutMode || "fast";
    if ($("taskPcMode")) $("taskPcMode").value = task.pcMode || "monitor";
    if ($("taskBandaiAccountPassword"))
      $("taskBandaiAccountPassword").value = task.accountPassword || "";
    if ($("taskBandaiAccountAssign"))
      $("taskBandaiAccountAssign").value = task.accountAssign || "auto";
    if ($("taskBandaiCampaignSn")) $("taskBandaiCampaignSn").value = task.campaignSn || "";
    $("taskPdp").value = task.pdpUrl || "";
    $("taskQty").value = task.qty || 1;
    $("taskQuantity").value = task.quantity || 1;
    $("taskProfile").value = task.profileId || "";
    $("taskProxy").value = task.proxyGroupId || "";
    $("taskPlaceOrder").checked = task.placeOrder !== false;
    syncTaskFormForStore();
    if ($("taskAccountId") && task.accountId && task.store === "toymate") {
      fillVaultAccountSelect("toymate", "taskAccountId");
      $("taskAccountId").value = task.accountId;
    }
    if ($("taskBandaiAccountId") && task.accountId && task.store === "bandai") {
      fillVaultAccountSelect("bandai", "taskBandaiAccountId");
      $("taskBandaiAccountId").value = task.accountId;
    }
    setTab("tasks");
  }
  if (t.dataset.delAcc) {
    applyState(await window.desktop.deleteAccount(t.dataset.delAcc));
  }
  if (t.dataset.copyAccEmail || t.dataset.copyAccPass) {
    const id = t.dataset.copyAccEmail || t.dataset.copyAccPass;
    const acc = (state.accounts || []).find((a) => a.id === id);
    if (acc) {
      const text = t.dataset.copyAccEmail ? acc.email : acc.password;
      try {
        await navigator.clipboard.writeText(text || "");
        appendLog(`Copied ${t.dataset.copyAccEmail ? "email" : "password"}`, "ok");
      } catch {
        appendLog("Clipboard unavailable", "err");
      }
    }
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

function readTaskForm() {
  const store = $("taskStore").value;
  const accountAssign =
    store === "toymate"
      ? $("taskAccountAssign")?.value || "auto"
      : store === "bandai"
        ? $("taskBandaiAccountAssign")?.value || "auto"
        : undefined;
  return {
    id: $("taskId").value || undefined,
    label: $("taskLabel").value,
    store,
    pdpUrl: $("taskPdp").value,
    qty: Number($("taskQty").value),
    quantity: Number($("taskQuantity").value),
    profileId: $("taskProfile").value || null,
    proxyGroupId: $("taskProxy").value || null,
    placeOrder: $("taskPlaceOrder").checked,
    toymateMode: store === "toymate" ? $("taskToymateMode")?.value || "checkout" : undefined,
    bandaiMode: store === "bandai" ? $("taskBandaiMode")?.value || "checkout" : undefined,
    bandaiCheckoutMode:
      store === "bandai" ? $("taskBandaiCheckoutMode")?.value || "fast" : undefined,
    pcMode: store === "pokemoncentre" ? $("taskPcMode")?.value || "monitor" : undefined,
    pcLocale: store === "pokemoncentre" ? "en-au" : undefined,
    paymentMethod: store === "toymate" ? $("taskToymatePay")?.value || "credit_card" : undefined,
    accountPassword:
      store === "toymate"
        ? $("taskAccountPassword")?.value || ""
        : store === "bandai"
          ? $("taskBandaiAccountPassword")?.value || ""
          : undefined,
    accountAssign,
    accountId:
      store === "toymate" && accountAssign === "manual"
        ? $("taskAccountId")?.value || null
        : store === "bandai" && accountAssign === "manual"
          ? $("taskBandaiAccountId")?.value || null
          : null,
    campaignSn: store === "bandai" ? $("taskBandaiCampaignSn")?.value || "" : undefined,
  };
}

$("taskStore").onchange = () => syncTaskFormForStore();
$("taskToymateMode").onchange = () => syncTaskFormForStore();
if ($("taskBandaiMode")) $("taskBandaiMode").onchange = () => syncTaskFormForStore();
if ($("taskPcMode")) $("taskPcMode").onchange = () => syncTaskFormForStore();
if ($("taskAccountAssign")) $("taskAccountAssign").onchange = () => syncAccountAssignUi();
if ($("taskBandaiAccountAssign"))
  $("taskBandaiAccountAssign").onchange = () => syncBandaiAccountAssignUi();

$("taskForm").onsubmit = async (e) => {
  e.preventDefault();
  applyState(await window.desktop.upsertTask(readTaskForm()));
  $("taskReset").click();
};

$("taskReset").onclick = () => {
  $("taskId").value = "";
  $("taskFormTitle").textContent = "New task";
  $("taskForm").reset();
  $("taskPlaceOrder").checked = true;
  syncTaskFormForStore();
};

$("taskRunOne").onclick = async () => {
  const saved = await window.desktop.upsertTask(readTaskForm());
  applyState(saved);
  const store = $("taskStore").value;
  const pdp = $("taskPdp").value.trim();
  const match =
    state.tasks.find(
      (t) =>
        t.store === store &&
        (t.pdpUrl === pdp ||
          (store === "toymate" && t.toymateMode === "account_gen") ||
          (store === "bandai" && t.bandaiMode === "account_gen")),
    ) || state.tasks[state.tasks.length - 1];
  if (!match) return;
  const res = await window.desktop.runTasks([match.id]);
  if (!res.ok) appendLog(esc(res.error), "err");
  else appendLog(`Enqueued ${res.enqueued} job(s)`, "ok");
  if (res.snapshot) applyState(res.snapshot);
};

$("btnClearAccounts").onclick = async () => {
  const n = (state.accounts || []).length;
  if (!n) return;
  if (!window.confirm(`Delete all ${n} account(s)?`)) return;
  applyState(await window.desktop.clearAccounts(null));
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
      capsolverApiKey: $("setCapsolver")?.value?.trim() || "",
      smspoolApiKey: $("setSmspool")?.value?.trim() || "",
      smsProvider: $("setSmsProvider")?.value || "auto",
      smspoolCountry: $("setSmspoolCountry")?.value || "GB",
      onlinesimApiKey: $("setOnlinesim")?.value?.trim() || "",
      onlinesimMode: $("setOnlinesimMode")?.value || "rent",
      onlinesimServiceSlug: $("setOnlinesimSlug")?.value?.trim() || "other",
      imapHost: $("setImapHost")?.value?.trim() || "",
      imapPort: Number($("setImapPort")?.value) || 993,
      imapUser: $("setImapUser")?.value?.trim() || "",
      imapAppPassword: $("setImapAppPassword")?.value?.trim() || "",
      imapMailbox: $("setImapMailbox")?.value?.trim() || "INBOX",
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
