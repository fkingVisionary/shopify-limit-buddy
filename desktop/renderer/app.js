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
  const disney = store === "disney";
  const pc = store === "pokemoncentre";
  const opts = $("taskToymateOpts");
  if (opts) opts.hidden = !toy;
  const bOpts = $("taskBandaiOpts");
  if (bOpts) bOpts.hidden = !bandai;
  const dOpts = $("taskDisneyOpts");
  if (dOpts) dOpts.hidden = !disney;
  const pcOpts = $("taskPcOpts");
  if (pcOpts) pcOpts.hidden = !pc;
  const mode = toy
    ? $("taskToymateMode")?.value || "checkout"
    : bandai
      ? $("taskBandaiMode")?.value || "checkout"
      : disney
        ? $("taskDisneyMode")?.value || "pay"
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
    } else if (disney) {
      label.textContent =
        mode === "warm" ? "Store (auto)" : mode === "monitor" ? "PDP URL (optional)" : "Product URL (PDP)";
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
  if (bAssign) {
    const monCheckout = mode === "monitor" && $("taskBandaiCheckoutOnHit")?.checked !== false;
    bAssign.hidden = !bandai || (mode !== "checkout" && mode !== "chance" && !monCheckout);
  }
  const bChance = $("taskBandaiChanceWrap");
  if (bChance) bChance.hidden = !bandai || mode !== "chance";
  const bPayPath = $("taskBandaiCheckoutModeWrap");
  if (bPayPath) {
    const monCheckout = mode === "monitor" && $("taskBandaiCheckoutOnHit")?.checked !== false;
    bPayPath.hidden = !bandai || (mode !== "checkout" && !monCheckout);
  }
  const bMon = $("taskBandaiMonitorWrap");
  if (bMon) bMon.hidden = !bandai || mode !== "monitor";
  const bMonLocal = $("taskBandaiMonitorLocalOpts");
  if (bMonLocal) {
    const src = $("taskBandaiMonitorMode")?.value || "local";
    bMonLocal.hidden = !bandai || mode !== "monitor" || src !== "local";
  }
  const placeWrap = $("taskPlaceOrderWrap");
  if (placeWrap) {
    const bandaiMonCheckout =
      bandai && mode === "monitor" && $("taskBandaiCheckoutOnHit")?.checked !== false;
    placeWrap.hidden =
      (toy && mode !== "checkout") ||
      (bandai && mode !== "checkout" && !bandaiMonCheckout) ||
      (pc && mode !== "checkout");
  }
  if (toy && mode === "checkout") syncAccountAssignUi();
  if (bandai && (mode === "checkout" || mode === "chance" || mode === "monitor"))
    syncBandaiAccountAssignUi();
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function refreshTaskGroupList() {
  const dl = $("taskGroupList");
  if (!dl) return;
  const names = [
    ...new Set(
      (state.tasks || [])
        .map((t) => String(t.taskGroup || "").trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
  dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
}

function renderTasks() {
  renderHarvestBankStrip();
  renderDropPrep();
  refreshTaskGroupList();
  const el = $("taskList");
  const tasks = state.tasks || [];
  if (!tasks.length) {
    el.innerHTML = `<div class="item"><div><strong>No tasks yet</strong><div class="meta">Create a Kmart, Toymate, Bandai, Disney, or Pokémon Centre task on the right.</div></div></div>`;
    return;
  }
  el.innerHTML = tasks
    .map((t) => {
      const statusLabel = t.lastLabel || t.lastStatus || "idle";
      const badge =
        t.lastStatus === "confirmed" || t.lastStatus === "complete" || t.lastStatus === "ok" || t.lastStatus === "login_ok"
          ? "ok"
          : t.lastStatus === "held_pay_retry"
            ? "run"
          : t.lastStatus === "failed" ||
              t.lastStatus === "error" ||
              t.lastStatus === "akamai" ||
              t.lastStatus === "proxy" ||
              t.lastStatus === "declined" ||
              t.lastStatus === "held_cart_gone" ||
              t.lastStatus === "oos"
            ? "err"
            : t.lastStatus === "queued"
              ? "run"
              : "";
      const heldHint = (() => {
        if (t.store !== "bandai" || !t.heldCart?.cartSn) return "";
        const start = Number(t.heldCart.cartHoldAt) || 0;
        const win = Number(t.heldCart.payWindowMs) || 30 * 60_000;
        if (!start) return " · cart held — retry pay";
        const left = Math.max(0, start + win - Date.now());
        if (left <= 0) return " · cart held? (window may be up — verify on retry)";
        return ` · cart held · ~${Math.ceil(left / 60_000)}m left`;
      })();
      const storeLabel =
        t.store === "toymate"
          ? `Toymate · ${t.toymateMode || "checkout"}`
          : t.store === "bandai"
            ? `Bandai · ${t.bandaiMode || "checkout"}${
                String(t.bandaiMode || "checkout") === "checkout"
                  ? ` · ${t.bandaiCheckoutMode || "fast"}`
                  : ""
              }${t.bandaiAreaItemNo ? ` · ${t.bandaiAreaItemNo}` : ""}`
            : t.store === "disney"
              ? `Disney · ${t.disneyMode || "pay"}`
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
          const proven =
            acc?.loginProvenAt && Date.now() - Number(acc.loginProvenAt) < 36 * 3600_000
              ? " · proven"
              : "";
          accountMeta = acc ? `account: ${acc.email}${proven}` : "account: manual (missing)";
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
      const retryPayBtn =
        t.store === "bandai" && t.heldCart?.cartSn
          ? `<button type="button" class="secondary" data-retry-pay="${t.id}">Retry pay</button>`
          : "";
      const dropSummary =
        t.store === "bandai" && t.lastDropSummary
          ? `<div class="meta drop-summary">${esc(t.lastDropSummary)}</div>`
          : "";
      const groupMeta = t.taskGroup ? ` · group ${esc(t.taskGroup)}` : "";
      return `<div class="item">
        <div>
          <strong>${esc(t.label || "Task")}</strong>
          <span class="badge ${badge}">${esc(statusLabel)}</span>
          <div class="meta">${esc(storeLabel)} · ${esc(pdpMeta)}${groupMeta}</div>
          <div class="meta">qty ${t.qty} × ${t.quantity} jobs${t.lastOrderNumber ? ` · ${esc(t.lastOrderNumber)}` : ""}${accountMeta ? ` · ${esc(accountMeta)}` : ""}${esc(heldHint)}</div>
          ${dropSummary}
        </div>
        <div class="actions">
          <button type="button" class="secondary" data-edit-task="${t.id}">Edit</button>
          ${retryPayBtn}
          <button type="button" data-run-task="${t.id}">Run</button>
          <button type="button" class="danger" data-del-task="${t.id}">Del</button>
        </div>
      </div>`;
    })
    .join("");
}

function renderDropPrep() {
  const strip = $("dropReadyStrip");
  const badge = $("dropReadyBadge");
  const sched = $("dropScheduleLine");
  if (!strip) return;
  const ready = state.dropReady;
  if (ready?.text) {
    strip.textContent = ready.text;
    strip.classList.toggle("ok", Boolean(ready.ready));
    strip.classList.toggle("bad", !ready.ready);
  } else {
    strip.textContent = "Ready —";
    strip.classList.remove("ok", "bad");
  }
  if (badge) {
    badge.textContent = ready?.ready ? "READY" : ready?.lanes ? "NOT READY" : "—";
    badge.className = `badge ${ready?.ready ? "ok" : ready?.lanes ? "err" : ""}`;
  }
  const ds = state.dropSchedule;
  if (sched) {
    if (ds?.armed) {
      sched.textContent = `Armed → ${ds.label || ""} · fires in ${ds.countdown || "…"}`;
    } else {
      sched.textContent = "No schedule armed";
    }
  }
}

function accountStatusBadge(status) {
  const s = String(status || "unknown").toLowerCase();
  if (s === "ready" || s === "active") return "ok";
  if (s === "created" || s === "needs_sms" || s === "needs_terms") return "warn";
  if (s === "banned" || s === "burned" || s === "disabled" || s === "register_failed") return "err";
  return "";
}

function resetAccountForm() {
  if (!$("accountForm")) return;
  $("accId").value = "";
  $("accountForm").reset();
  if ($("accStore")) $("accStore").value = "bandai";
  if ($("accStatus")) $("accStatus").value = "ready";
  if ($("accountFormTitle")) $("accountFormTitle").textContent = "Add account";
}

function fillAccountForm(a) {
  if (!a || !$("accountForm")) return;
  $("accId").value = a.id || "";
  $("accStore").value = a.storeId || "bandai";
  $("accEmail").value = a.email || "";
  $("accPassword").value = a.password || "";
  $("accStatus").value = a.status || "ready";
  $("accPhone").value = a.phone || "";
  $("accNotes").value = a.notes || "";
  if ($("accountFormTitle")) $("accountFormTitle").textContent = "Edit account";
  setTab("accounts");
}

function downloadTextFile(filename, body, mime = "application/json") {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function renderAccounts() {
  const el = $("accountList");
  if (!el) return;
  const rows = state.accounts || [];
  if (!rows.length) {
    el.innerHTML = `<div class="item"><div><strong>No accounts yet</strong><div class="meta">Add one manually, Import, or run Account gen.</div></div></div>`;
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
      const src = a.source ? ` · ${a.source}` : "";
      return `<div class="item">
        <div>
          <strong>${esc(a.email)}</strong>
          <span class="badge ok">${esc(a.storeName || a.storeId || "store")}</span>
          <span class="badge ${badge}">${esc(st)}</span>
          <div class="meta"><code>${esc(a.password || "")}</code>${esc(src)}</div>
          <div class="meta">match ${esc(match)}${a.lastUsedAt ? ` · used ${new Date(a.lastUsedAt).toLocaleString()}` : ""}${
            a.loginProvenAt ? ` · login ok ${new Date(a.loginProvenAt).toLocaleString()}` : ""
          }</div>
          <div class="meta">${a.createdAt ? new Date(a.createdAt).toLocaleString() : ""}${
            a.notes ? ` · ${esc(a.notes)}` : ""
          }</div>
        </div>
        <div class="actions">
          <button type="button" class="secondary" data-edit-acc="${esc(a.id)}">Edit</button>
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
  if ($("setBandaiGlobalMon")) $("setBandaiGlobalMon").checked = s.bandaiGlobalMonitorEnabled !== false;
  if ($("setBandaiGlobalMonUrl")) {
    $("setBandaiGlobalMonUrl").value =
      s.bandaiGlobalMonitorUrl || "https://j1ms-bandai-monitor-production.up.railway.app";
  }
  if ($("setBandaiGlobalMonToken")) $("setBandaiGlobalMonToken").value = s.bandaiGlobalMonitorToken || "";
  if ($("setDiscordWebhook")) {
    $("setDiscordWebhook").value = s.discordCheckoutWebhook || s.discordMonitorWebhook || "";
  }
  fillQuickTaskPresetSelects();
  const qt = s.quickTaskPreset || {};
  if ($("qtPresetStore")) $("qtPresetStore").value = qt.store || "bandai";
  if ($("qtPresetMode")) $("qtPresetMode").value = qt.bandaiMode || "checkout";
  if ($("qtPresetProfile") && qt.profileId) $("qtPresetProfile").value = qt.profileId;
  if ($("qtPresetProxy")) $("qtPresetProxy").value = qt.proxyGroupId || "";
  if ($("qtPresetQty") && document.activeElement !== $("qtPresetQty")) {
    $("qtPresetQty").value = qt.qty ?? 1;
  }
  if ($("qtPresetQuantity") && document.activeElement !== $("qtPresetQuantity")) {
    $("qtPresetQuantity").value = qt.quantity ?? 1;
  }
  if ($("qtPresetPlaceOrder")) $("qtPresetPlaceOrder").checked = qt.placeOrder !== false;
  if ($("qtPresetStart")) $("qtPresetStart").checked = qt.startAfterCreate !== false;
  $("licenseMsg").textContent = s.licenseMessage
    ? `License: ${s.licenseStatus} — ${s.licenseMessage}`
    : `License: ${s.licenseStatus || "unknown"}`;
}

function fillQuickTaskPresetSelects() {
  const prof = $("qtPresetProfile");
  const px = $("qtPresetProxy");
  if (!prof || !px || !state) return;
  const curP = prof.value;
  const curX = px.value;
  prof.innerHTML =
    `<option value="">Select profile…</option>` +
    (state.profiles || [])
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.email || p.id)}</option>`)
      .join("");
  px.innerHTML =
    `<option value="">Direct (no proxy)</option>` +
    (state.proxyGroups || [])
      .map((g) => `<option value="${esc(g.id)}">${esc(g.name)} (${g.entries?.length || 0})</option>`)
      .join("");
  if (curP && [...prof.options].some((o) => o.value === curP)) prof.value = curP;
  if (curX && [...px.options].some((o) => o.value === curX)) px.value = curX;
}

function readQuickTaskPresetFromForm() {
  return {
    store: $("qtPresetStore")?.value || "bandai",
    bandaiMode: $("qtPresetMode")?.value || "checkout",
    bandaiCheckoutMode: "fast",
    profileId: $("qtPresetProfile")?.value || null,
    proxyGroupId: $("qtPresetProxy")?.value || null,
    qty: Number($("qtPresetQty")?.value) || 1,
    quantity: Number($("qtPresetQuantity")?.value) || 1,
    placeOrder: $("qtPresetPlaceOrder")?.checked !== false,
    accountAssign: "auto",
    startAfterCreate: $("qtPresetStart")?.checked !== false,
  };
}

let harvestState = null;

function fillHarvestProxySelect() {
  const sel = $("hvProxyGroup");
  if (!sel || !state) return;
  const cur = sel.value || harvestState?.config?.proxyGroupId || "";
  sel.innerHTML =
    `<option value="">Select sticky proxy group…</option>` +
    (state.proxyGroups || [])
      .map(
        (g) =>
          `<option value="${esc(g.id)}">${esc(g.name)} (${g.entries?.length || 0})</option>`,
      )
      .join("");
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function renderHarvest(snap) {
  if (snap) harvestState = snap;
  else if (state?.harvest) harvestState = state.harvest;
  if (!harvestState) return;

  fillHarvestProxySelect();

  const cfg = harvestState.config || {};
  if ($("hvDesired") && document.activeElement !== $("hvDesired")) {
    $("hvDesired").value = cfg.desired ?? 2;
  }
  if ($("hvSolveSpam") && document.activeElement !== $("hvSolveSpam")) {
    $("hvSolveSpam").checked = cfg.solveSpam !== false;
  }

  if ($("hvReady")) $("hvReady").textContent = String(harvestState.ready ?? 0);
  if ($("hvSpam")) $("hvSpam").textContent = String(harvestState.readyWithSpam ?? 0);
  if ($("hvSolved")) $("hvSolved").textContent = String(harvestState.solvedCount ?? 0);
  if ($("hvFailed")) $("hvFailed").textContent = String(harvestState.failedCount ?? 0);

  const status = $("harvestStatusLine");
  if (status) {
    if (harvestState.busy) status.textContent = "Harvesting… CapSolver in progress";
    else if (harvestState.running)
      status.textContent = `Harvest running — keeping ${cfg.desired ?? 0} CF session(s) ready`;
    else status.textContent = "Harvest stopped";
  }

  const err = $("harvestError");
  if (err) {
    if (harvestState.lastError) {
      err.hidden = false;
      err.textContent = harvestState.lastError;
    } else {
      err.hidden = true;
      err.textContent = "";
    }
  }

  const list = $("harvestSessionList");
  if (list) {
    const rows = harvestState.sessions || [];
    if (!rows.length) {
      list.innerHTML = `<div class="item"><div><strong>Bank empty</strong><div class="meta">Start harvest or click Harvest one now. Checkout falls back to on-demand CapSolver when empty.</div></div></div>`;
    } else {
      list.innerHTML = rows
        .map(
          (s) => `<div class="item">
          <div>
            <strong>${esc(s.proxyHost || "proxy")}</strong>
            <div class="meta">CF TTL ${s.cfTtlSec ?? "?"}s · age ${s.ageSec ?? "?"}s${
              s.hasSpam
                ? ` · spam TTL ${s.spamTtlSec ?? "?"}s`
                : " · CF only (spam on demand)"
            }</div>
            <div class="meta">${esc(s.cfNote || "")}${s.spamNote ? ` · ${esc(s.spamNote)}` : ""}</div>
          </div>
          <div class="actions">
            <span class="badge ${s.hasSpam ? "spam" : "hv"}">${s.hasSpam ? "CF+spam" : "CF"}</span>
          </div>
        </div>`,
        )
        .join("");
    }
  }

  const startBtn = $("hvStart");
  const stopBtn = $("hvStop");
  if (startBtn) startBtn.disabled = Boolean(harvestState.running);
  if (stopBtn) stopBtn.disabled = !harvestState.running;
}

function fillDisneyHarvestProxySelect() {
  const sel = $("dhProxyGroup");
  if (!sel || !state) return;
  const cur = sel.value || state?.disneyHarvest?.config?.proxyGroupId || "";
  sel.innerHTML =
    `<option value="">Select sticky proxy group…</option>` +
    (state.proxyGroups || [])
      .map(
        (g) =>
          `<option value="${esc(g.id)}">${esc(g.name)} (${g.entries?.length || 0})</option>`,
      )
      .join("");
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function renderDisneyHarvest() {
  const hv = state?.disneyHarvest || {};
  fillDisneyHarvestProxySelect();
  const cfg = hv.config || {};
  if ($("dhDesired") && document.activeElement !== $("dhDesired")) {
    $("dhDesired").value = cfg.desired ?? 2;
  }
  if ($("dhSolveCaptcha") && document.activeElement !== $("dhSolveCaptcha")) {
    $("dhSolveCaptcha").checked = cfg.solveCaptcha !== false;
  }
  if ($("dhReady")) $("dhReady").textContent = String(hv.ready ?? 0);
  if ($("dhCaptcha")) $("dhCaptcha").textContent = String(hv.readyWithCaptcha ?? 0);
  if ($("dhSolved")) $("dhSolved").textContent = String(hv.solvedCount ?? 0);
  if ($("dhFailed")) $("dhFailed").textContent = String(hv.failedCount ?? 0);

  const line = $("disneyHarvestStatusLine");
  if (line) {
    if (hv.running && hv.busy) line.textContent = "Harvesting… Hyper warm + CapSolver";
    else if (hv.running) line.textContent = `Harvest armed · ready ${hv.ready ?? 0}`;
    else line.textContent = "Harvest stopped";
  }
  const err = $("disneyHarvestError");
  if (err) {
    if (hv.lastError) {
      err.hidden = false;
      err.textContent = hv.lastError;
    } else {
      err.hidden = true;
      err.textContent = "";
    }
  }
  const list = $("disneyHarvestSessionList");
  if (list) {
    const rows = hv.sessions || [];
    if (!rows.length) {
      list.innerHTML = `<div class="item"><div><strong>Bank empty</strong><div class="meta">Start harvest or click Harvest one now. Disney checkout falls back to cold warm + CapSolver when empty.</div></div></div>`;
    } else {
      list.innerHTML = rows
        .map(
          (s) => `<div class="item">
          <div>
            <strong>${esc(s.proxyHost || "proxy")}</strong>
            <div class="meta">_abck TTL ${s.abckTtlSec ?? "?"}s · age ${s.ageSec ?? "?"}s${
              s.hasCaptcha
                ? ` · captcha TTL ${s.captchaTtlSec ?? "?"}s`
                : " · warm only (captcha on demand)"
            }</div>
            <div class="meta">${esc(s.warmNote || "")}${s.captchaNote ? ` · ${esc(s.captchaNote)}` : ""}</div>
          </div>
          <div class="actions">
            <span class="badge ${s.hasCaptcha ? "spam" : "hv"}">${s.hasCaptcha ? "warm+captcha" : "warm"}</span>
          </div>
        </div>`,
        )
        .join("");
    }
  }
  const startBtn = $("dhStart");
  const stopBtn = $("dhStop");
  if (startBtn) startBtn.disabled = Boolean(hv.running);
  if (stopBtn) stopBtn.disabled = !hv.running;
}

function disneyHarvestOptsFromForm() {
  return {
    proxyGroupId: $("dhProxyGroup")?.value || null,
    desired: Number($("dhDesired")?.value) || 0,
    solveCaptcha: $("dhSolveCaptcha")?.checked !== false,
  };
}

function harvestOptsFromForm() {
  return {
    proxyGroupId: $("hvProxyGroup")?.value || null,
    desired: Number($("hvDesired")?.value) || 0,
    solveSpam: $("hvSolveSpam")?.checked !== false,
  };
}

/** Harvest bank strip — kept in renderer (sandbox preload cannot require local modules). */
function harvestSessionAgeSec(snap) {
  const rows = Array.isArray(snap?.sessions) ? snap.sessions : [];
  if (!rows.length) return null;
  let min = Infinity;
  for (const s of rows) {
    const a = Number(s.ageSec);
    if (Number.isFinite(a) && a < min) min = a;
  }
  return Number.isFinite(min) ? min : null;
}

function formatHarvestBankChip(label, snap) {
  const ready = Number(snap?.ready) || 0;
  const desired = Number(snap?.config?.desired);
  const desiredLabel = Number.isFinite(desired) ? String(desired) : "–";
  const age = harvestSessionAgeSec(snap);
  const agePart = ready > 0 && age != null ? ` · ${age}s` : "";
  let chipState = "off";
  if (snap?.busy) chipState = "mint";
  else if (snap?.running) chipState = "armed";
  else if (ready > 0) chipState = "ready";
  const stateLabel =
    chipState === "mint"
      ? "minting"
      : chipState === "armed"
        ? "armed"
        : chipState === "ready"
          ? "banked"
          : "off";
  return {
    state: chipState,
    text: `${label} ${ready}/${desiredLabel}${agePart} ${stateLabel}`,
  };
}

function formatHarvestBankStrip(banks = {}) {
  const chips = [
    formatHarvestBankChip("Bandai F5", banks.bandai || banks.bandaiHarvest),
    formatHarvestBankChip("Toymate CF", banks.toymate || banks.harvest),
    formatHarvestBankChip("Disney", banks.disney || banks.disneyHarvest),
  ];
  return {
    chips,
    text: chips.map((c) => c.text).join("  ·  "),
  };
}

function renderHarvestBankStrip() {
  const el = $("harvestBankStrip");
  if (!el) return;
  const { chips, text } = formatHarvestBankStrip({
    bandai: state?.bandaiHarvest,
    toymate: state?.harvest,
    disney: state?.disneyHarvest,
  });
  el.innerHTML = (chips || [])
    .map((c) => `<span class="chip-${esc(c.state)}">${esc(c.text)}</span>`)
    .join(` <span class="chip-off">·</span> `);
  if (!chips?.length) el.textContent = text || "Harvest banks —";
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
  renderHarvest(next.harvest || null);
  renderBandaiHarvest();
  renderDisneyHarvest();
  renderHarvestBankStrip();
  renderMonitorFeed();
  renderSmartActions();
  engineUi();
}

function renderBandaiHarvest() {
  const hv = state?.bandaiHarvest || {};
  const cfg = hv.config || {};
  const sel = $("bhProxyGroup");
  if (sel) {
    const cur = sel.value || cfg.proxyGroupId || "";
    sel.innerHTML =
      `<option value="">Select proxy group…</option>` +
      (state.proxyGroups || [])
        .map((g) => `<option value="${esc(g.id)}">${esc(g.name)} (${g.entries?.length || 0})</option>`)
        .join("");
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    else if (cfg.proxyGroupId) sel.value = cfg.proxyGroupId;
  }
  if ($("bhDesired") && document.activeElement !== $("bhDesired")) {
    $("bhDesired").value = cfg.desired != null ? cfg.desired : 2;
  }
  if ($("bhArea") && document.activeElement !== $("bhArea") && cfg.area) {
    $("bhArea").value = cfg.area;
  }
  if ($("bhReady")) $("bhReady").textContent = String(hv.ready ?? 0);
  if ($("bhSolved")) $("bhSolved").textContent = String(hv.solvedCount ?? 0);
  if ($("bhFailed")) $("bhFailed").textContent = String(hv.failedCount ?? 0);
  if ($("bhDesiredLabel")) $("bhDesiredLabel").textContent = String(cfg.desired ?? 2);

  const line = $("bandaiHarvestStatusLine");
  if (line) {
    if (hv.running && hv.busy) line.textContent = "Harvesting… minting F5 bridge";
    else if (hv.running) line.textContent = `Harvest armed · ready ${hv.ready ?? 0}`;
    else line.textContent = "Harvest stopped";
  }
  const err = $("bandaiHarvestError");
  if (err) {
    if (hv.lastError) {
      err.hidden = false;
      err.textContent = hv.lastError;
    } else {
      err.hidden = true;
      err.textContent = "";
    }
  }

  const list = $("bandaiHarvestSessionList");
  if (!list) return;
  const rows = hv.sessions || [];
  if (!rows.length) {
    list.innerHTML = `<div class="empty muted">No warm bridges yet — start harvest before a drop.</div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (s) => `<div class="row">
      <div>
        <strong>${esc(s.proxyHost || s.id)}</strong>
        <div class="muted">${esc(s.area || "au")} · age ${esc(String(s.ageSec))}s · ttl ${esc(String(s.ttlSec))}s</div>
        <div class="muted">${esc(s.note || "")}</div>
      </div>
      <span class="badge ok">ready</span>
    </div>`,
    )
    .join("");
}

function bandaiHarvestOptsFromForm() {
  return {
    proxyGroupId: $("bhProxyGroup")?.value || null,
    desired: Number($("bhDesired")?.value || 2),
    area: $("bhArea")?.value || "au",
  };
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
    if ($("taskGroup")) $("taskGroup").value = task.taskGroup || "";
    $("taskStore").value = task.store || "kmart";
    if ($("taskToymateMode")) $("taskToymateMode").value = task.toymateMode || "checkout";
    if ($("taskToymatePay")) $("taskToymatePay").value = task.paymentMethod || "credit_card";
    if ($("taskAccountPassword")) $("taskAccountPassword").value = task.accountPassword || "";
    if ($("taskAccountAssign")) $("taskAccountAssign").value = task.accountAssign || "auto";
    if ($("taskBandaiMode")) $("taskBandaiMode").value = task.bandaiMode || "checkout";
    if ($("taskDisneyMode")) $("taskDisneyMode").value = task.disneyMode || "pay";
    if ($("taskBandaiCheckoutMode"))
      $("taskBandaiCheckoutMode").value = task.bandaiCheckoutMode || "fast";
    if ($("taskBandaiAreaItemNo")) $("taskBandaiAreaItemNo").value = task.bandaiAreaItemNo || "";
    if ($("taskBandaiMonitorMode"))
      $("taskBandaiMonitorMode").value = task.bandaiMonitorMode || "local";
    if ($("taskBandaiWatchSku")) $("taskBandaiWatchSku").value = task.bandaiWatchSku || "";
    if ($("taskBandaiWatchKeywords"))
      $("taskBandaiWatchKeywords").value = task.bandaiWatchKeywords || "";
    if ($("taskBandaiMonitorIntervalMs"))
      $("taskBandaiMonitorIntervalMs").value = task.bandaiMonitorIntervalMs || 10000;
    if ($("taskBandaiMonitorDelayMs"))
      $("taskBandaiMonitorDelayMs").value = task.bandaiMonitorDelayMs || 0;
    if ($("taskBandaiCheckoutOnHit"))
      $("taskBandaiCheckoutOnHit").checked = task.bandaiCheckoutOnHit !== false;
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
  if (t.dataset.editAcc) {
    const acc = (state.accounts || []).find((a) => a.id === t.dataset.editAcc);
    if (acc) fillAccountForm(acc);
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
  if (t.dataset.retryPay) {
    const res = await window.desktop.runTasks([t.dataset.retryPay], { payFromCart: true });
    if (!res.ok) appendLog(esc(res.error), "err");
    else appendLog(`Retry pay enqueued (${res.enqueued}) — live cart verify`, "ok");
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
    taskGroup: $("taskGroup")?.value?.trim() || "",
    store,
    pdpUrl: $("taskPdp").value,
    qty: Number($("taskQty").value),
    quantity: Number($("taskQuantity").value),
    profileId: $("taskProfile").value || null,
    proxyGroupId: $("taskProxy").value || null,
    placeOrder: $("taskPlaceOrder").checked,
    toymateMode: store === "toymate" ? $("taskToymateMode")?.value || "checkout" : undefined,
    bandaiMode: store === "bandai" ? $("taskBandaiMode")?.value || "checkout" : undefined,
    disneyMode: store === "disney" ? $("taskDisneyMode")?.value || "pay" : undefined,
    bandaiCheckoutMode:
      store === "bandai" ? $("taskBandaiCheckoutMode")?.value || "fast" : undefined,
    bandaiMonitorMode:
      store === "bandai" && $("taskBandaiMode")?.value === "monitor"
        ? $("taskBandaiMonitorMode")?.value || "local"
        : undefined,
    bandaiWatchSku:
      store === "bandai" ? $("taskBandaiWatchSku")?.value?.trim() || "" : undefined,
    bandaiWatchKeywords:
      store === "bandai" ? $("taskBandaiWatchKeywords")?.value?.trim() || "" : undefined,
    bandaiMonitorIntervalMs:
      store === "bandai"
        ? Number($("taskBandaiMonitorIntervalMs")?.value) || 10000
        : undefined,
    bandaiMonitorDelayMs:
      store === "bandai" ? Number($("taskBandaiMonitorDelayMs")?.value) || 0 : undefined,
    bandaiCheckoutOnHit:
      store === "bandai" && ($("taskBandaiMode")?.value || "") === "monitor"
        ? $("taskBandaiCheckoutOnHit")?.checked !== false
        : undefined,
    bandaiAreaItemNo:
      store === "bandai" ? $("taskBandaiAreaItemNo")?.value?.trim() || "" : undefined,
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
if ($("taskDisneyMode")) $("taskDisneyMode").onchange = () => syncTaskFormForStore();
if ($("taskBandaiMonitorMode"))
  $("taskBandaiMonitorMode").onchange = () => syncTaskFormForStore();
if ($("taskBandaiCheckoutOnHit"))
  $("taskBandaiCheckoutOnHit").onchange = () => syncTaskFormForStore();
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

if ($("accountForm")) {
  $("accountForm").onsubmit = async (e) => {
    e.preventDefault();
    const res = await window.desktop.upsertAccount({
      id: $("accId").value || undefined,
      storeId: $("accStore").value || "bandai",
      email: $("accEmail").value,
      password: $("accPassword").value,
      status: $("accStatus").value || "ready",
      phone: $("accPhone").value || null,
      notes: $("accNotes").value || null,
      source: $("accId").value ? undefined : "manual",
    });
    if (!res.ok) {
      appendLog(esc(res.error || "save account failed"), "err");
      return;
    }
    if (res.snapshot) applyState(res.snapshot);
    appendLog(`Saved account ${res.account?.email || ""}`, "ok");
    resetAccountForm();
  };
}
if ($("accReset")) {
  $("accReset").onclick = () => resetAccountForm();
}

if ($("btnExportAccounts")) {
  $("btnExportAccounts").onclick = async () => {
    const fmt = window.confirm("OK = JSON export\nCancel = CSV export") ? "json" : "csv";
    const res = await window.desktop.exportAccounts({ format: fmt });
    if (!res.ok) {
      appendLog(esc(res.error || "export failed"), "err");
      return;
    }
    downloadTextFile(
      res.filename || `accounts.${fmt === "csv" ? "csv" : "json"}`,
      res.body || "",
      fmt === "csv" ? "text/csv" : "application/json",
    );
    appendLog(`Exported ${res.count} account(s) (${fmt})`, "ok");
  };
}

if ($("btnImportAccounts") && $("accImportFile")) {
  $("btnImportAccounts").onclick = () => $("accImportFile").click();
  $("accImportFile").onchange = async () => {
    const file = $("accImportFile").files?.[0];
    $("accImportFile").value = "";
    if (!file) return;
    let text = "";
    try {
      text = await file.text();
    } catch (e) {
      appendLog(`Import read failed: ${esc(e?.message || e)}`, "err");
      return;
    }
    if (!window.confirm(`Import accounts from ${file.name}?`)) return;
    const replace =
      (state.accounts || []).length > 0 &&
      window.confirm("Wipe existing vault first?\n\nOK = replace all\nCancel = merge (update matching emails)");
    const res = await window.desktop.importAccounts(text, { replace });
    if (res.snapshot) applyState(res.snapshot);
    if (!res.ok) {
      appendLog(esc(res.error || "import failed"), "err");
      return;
    }
    appendLog(
      `Imported ${res.imported} account(s)${replace ? " (replaced vault)" : ""}${
        res.errors?.length ? ` · ${res.errors.length} row warning(s)` : ""
      }`,
      "ok",
    );
  };
}

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
      bandaiGlobalMonitorEnabled: $("setBandaiGlobalMon")?.checked !== false,
      bandaiGlobalMonitorUrl: $("setBandaiGlobalMonUrl")?.value?.trim().replace(/\/$/, "") || "",
      bandaiGlobalMonitorToken: $("setBandaiGlobalMonToken")?.value?.trim() || "",
      discordCheckoutWebhook: $("setDiscordWebhook")?.value?.trim() || "",
      quickTaskPreset: readQuickTaskPresetFromForm(),
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

if ($("btnDropModeArm")) {
  $("btnDropModeArm").onclick = async () => {
    const fireAt = $("dropFireAt")?.value?.trim() || "";
    const res = await window.desktop.dropModeArm(fireAt ? { fireAt } : {});
    if (res.snapshot) applyState(res.snapshot);
    else if (res.harvest && state) {
      state.bandaiHarvest = res.harvest;
      state.dropReady = res.dropReady;
      renderDropPrep();
      renderBandaiHarvest();
    }
    appendLog(
      res.ok
        ? `Drop Mode armed — ${res.lanes} lane(s), harvest desired ${res.desired}${
            res.schedule?.ok ? ` · schedule ${res.schedule.label}` : ""
          }`
        : esc(res.error || "Drop Mode failed"),
      res.ok ? "ok" : "err",
    );
  };
}

if ($("btnDropScheduleArm")) {
  $("btnDropScheduleArm").onclick = async () => {
    const fireAt = $("dropFireAt")?.value?.trim();
    if (!fireAt) {
      appendLog("Enter fire time (e.g. 13:00 AEST)", "err");
      return;
    }
    const res = await window.desktop.dropScheduleArm({ fireAt });
    if (res.snapshot) applyState(res.snapshot);
    appendLog(
      res.ok ? `Schedule armed → ${res.label} (in ${res.countdown})` : esc(res.error || "Schedule failed"),
      res.ok ? "ok" : "err",
    );
  };
}

if ($("btnDropScheduleCancel")) {
  $("btnDropScheduleCancel").onclick = async () => {
    const res = await window.desktop.dropScheduleCancel();
    if (res.snapshot) applyState(res.snapshot);
    appendLog("Drop schedule cancelled", "muted");
  };
}

if ($("btnVaultLoginCheck")) {
  $("btnVaultLoginCheck").onclick = async () => {
    const res = await window.desktop.bandaiVaultLoginCheck({});
    if (res.snapshot) applyState(res.snapshot);
    appendLog(
      res.ok ? `Vault login check enqueued (${res.enqueued})` : esc(res.error || "Login check failed"),
      res.ok ? "ok" : "err",
    );
  };
}

$("bhStart").onclick = async () => {
  const res = await window.desktop.bandaiHarvestStart(bandaiHarvestOptsFromForm());
  if (res.snapshot) applyState(res.snapshot);
  else if (res.harvest && state) {
    state.bandaiHarvest = res.harvest;
    renderBandaiHarvest();
  }
  appendLog(res.ok ? "Bandai harvest armed" : esc(res.error || "Harvest start failed"), res.ok ? "ok" : "err");
};

$("bhStop").onclick = async () => {
  const res = await window.desktop.bandaiHarvestStop();
  if (res.snapshot) applyState(res.snapshot);
  else if (res.harvest && state) {
    state.bandaiHarvest = res.harvest;
    renderBandaiHarvest();
  }
  appendLog("Bandai harvest stopped", "muted");
};

$("bhClear").onclick = async () => {
  const res = await window.desktop.bandaiHarvestClear();
  if (res.snapshot) applyState(res.snapshot);
  else if (res.harvest && state) {
    state.bandaiHarvest = res.harvest;
    renderBandaiHarvest();
  }
  appendLog("Bandai harvest bank cleared", "muted");
};

$("bhOnce").onclick = async () => {
  appendLog("Minting one Bandai F5 bridge…", "muted");
  const res = await window.desktop.bandaiHarvestOnce(bandaiHarvestOptsFromForm());
  if (res.snapshot) applyState(res.snapshot);
  else if (res.harvest && state) {
    state.bandaiHarvest = res.harvest;
    renderBandaiHarvest();
  }
  appendLog(
    res.ok ? `Harvested bridge (${Math.round((res.ms || 0) / 1000)}s)` : esc(res.error || "Harvest failed"),
    res.ok ? "ok" : "err",
  );
};

if ($("dhStart")) {
  $("dhStart").onclick = async () => {
    const opts = disneyHarvestOptsFromForm();
    if (!opts.proxyGroupId) {
      appendLog("Pick a proxy group on the Disney Harvest card", "err");
      return;
    }
    const res = await window.desktop.disneyHarvestStart(opts);
    if (res.snapshot) applyState(res.snapshot);
    else if (res.harvest && state) {
      state.disneyHarvest = res.harvest;
      renderDisneyHarvest();
    }
    appendLog(res.ok ? "Disney harvest armed" : esc(res.error || "Harvest start failed"), res.ok ? "ok" : "err");
  };
}

if ($("dhStop")) {
  $("dhStop").onclick = async () => {
    const res = await window.desktop.disneyHarvestStop();
    if (res.snapshot) applyState(res.snapshot);
    else if (res.harvest && state) {
      state.disneyHarvest = res.harvest;
      renderDisneyHarvest();
    }
    appendLog("Disney harvest stopped", "muted");
  };
}

if ($("dhClear")) {
  $("dhClear").onclick = async () => {
    const res = await window.desktop.disneyHarvestClear();
    if (res.snapshot) applyState(res.snapshot);
    else if (res.harvest && state) {
      state.disneyHarvest = res.harvest;
      renderDisneyHarvest();
    }
    appendLog("Disney harvest bank cleared", "muted");
  };
}

if ($("dhOnce")) {
  $("dhOnce").onclick = async () => {
    const opts = disneyHarvestOptsFromForm();
    if (!opts.proxyGroupId) {
      appendLog("Pick a proxy group on the Disney Harvest card", "err");
      return;
    }
    appendLog("Harvesting one Disney Akamai session…", "muted");
    const res = await window.desktop.disneyHarvestOnce(opts);
    if (res.snapshot) applyState(res.snapshot);
    else if (res.harvest && state) {
      state.disneyHarvest = res.harvest;
      renderDisneyHarvest();
    }
    appendLog(
      res.ok
        ? `Disney harvested${res.ms != null ? ` in ${Math.round(res.ms / 1000)}s` : ""}`
        : esc(res.error || "Harvest failed"),
      res.ok ? "ok" : "err",
    );
  };
}

if ($("dhProxyGroup")) {
  $("dhProxyGroup").onchange = async () => {
    const snap = await window.desktop.disneyHarvestConfigure({
      proxyGroupId: $("dhProxyGroup").value || null,
    });
    if (state) state.disneyHarvest = snap;
    renderDisneyHarvest();
  };
}
if ($("dhDesired")) {
  $("dhDesired").onchange = async () => {
    const snap = await window.desktop.disneyHarvestConfigure({
      desired: Number($("dhDesired").value) || 0,
    });
    if (state) state.disneyHarvest = snap;
    renderDisneyHarvest();
  };
}
if ($("dhSolveCaptcha")) {
  $("dhSolveCaptcha").onchange = async () => {
    const snap = await window.desktop.disneyHarvestConfigure({
      solveCaptcha: $("dhSolveCaptcha").checked,
    });
    if (state) state.disneyHarvest = snap;
    renderDisneyHarvest();
  };
}

$("hvStart").onclick = async () => {
  const opts = harvestOptsFromForm();
  if (!opts.proxyGroupId) {
    appendLog("Pick a proxy group on the Harvest tab", "err");
    return;
  }
  const res = await window.desktop.harvestStart(opts);
  if (res.snapshot) applyState(res.snapshot);
  else if (res.harvest) renderHarvest(res.harvest);
  appendLog(res.ok ? "Toymate harvest started" : esc(res.error || "Harvest start failed"), res.ok ? "ok" : "err");
};

$("hvStop").onclick = async () => {
  const res = await window.desktop.harvestStop();
  if (res.snapshot) applyState(res.snapshot);
  else if (res.harvest) renderHarvest(res.harvest);
  appendLog("Toymate harvest stopped", "muted");
};

$("hvClear").onclick = async () => {
  const res = await window.desktop.harvestClear();
  if (res.snapshot) applyState(res.snapshot);
  else if (res.harvest) renderHarvest(res.harvest);
  appendLog("Toymate harvest bank cleared", "muted");
};

$("hvOnce").onclick = async () => {
  const opts = harvestOptsFromForm();
  if (!opts.proxyGroupId) {
    appendLog("Pick a proxy group on the Harvest tab", "err");
    return;
  }
  appendLog("Harvesting one CF session…", "muted");
  const res = await window.desktop.harvestOnce(opts);
  if (res.snapshot) applyState(res.snapshot);
  else if (res.harvest) renderHarvest(res.harvest);
  appendLog(
    res.ok
      ? `Harvested session${res.ms != null ? ` in ${Math.round(res.ms / 1000)}s` : ""}`
      : esc(res.error || "Harvest one failed"),
    res.ok ? "ok" : "err",
  );
};

if ($("hvProxyGroup")) {
  $("hvProxyGroup").onchange = async () => {
    const snap = await window.desktop.harvestConfigure({
      proxyGroupId: $("hvProxyGroup").value || null,
    });
    renderHarvest(snap);
  };
}
if ($("hvDesired")) {
  $("hvDesired").onchange = async () => {
    const snap = await window.desktop.harvestConfigure({
      desired: Number($("hvDesired").value) || 0,
    });
    renderHarvest(snap);
  };
}
if ($("hvSolveSpam")) {
  $("hvSolveSpam").onchange = async () => {
    const snap = await window.desktop.harvestConfigure({
      solveSpam: $("hvSolveSpam").checked,
    });
    renderHarvest(snap);
  };
}

if ($("bhProxyGroup")) {
  $("bhProxyGroup").onchange = async () => {
    const snap = await window.desktop.bandaiHarvestConfigure({
      proxyGroupId: $("bhProxyGroup").value || null,
    });
    if (state) state.bandaiHarvest = snap;
    renderBandaiHarvest();
  };
}
if ($("bhDesired")) {
  $("bhDesired").onchange = async () => {
    const snap = await window.desktop.bandaiHarvestConfigure({
      desired: Number($("bhDesired").value) || 0,
    });
    if (state) state.bandaiHarvest = snap;
    renderBandaiHarvest();
  };
}
if ($("bhArea")) {
  $("bhArea").onchange = async () => {
    const snap = await window.desktop.bandaiHarvestConfigure({
      area: $("bhArea").value || "au",
    });
    if (state) state.bandaiHarvest = snap;
    renderBandaiHarvest();
  };
}

// ── Monitor Feed ───────────────────────────────────────────────────────────

function renderMonitorFeed() {
  const mon = state?.bandaiGlobalMonitor || {};
  const line = $("feedStatusLine");
  if (line) {
    const bits = [];
    if (mon.connected) bits.push("SSE connected");
    else if (mon.running) bits.push("SSE reconnecting…");
    else bits.push(state?.engine?.running ? "not subscribed" : "engine offline");
    if (mon.url) bits.push(mon.url.replace(/^https?:\/\//, ""));
    bits.push(`${mon.hits ?? 0} hits`);
    bits.push(`${mon.watchTasks ?? 0} watch task(s)`);
    const bridge = state?.quickTaskBridge;
    if (bridge?.running) bits.push(`QT bridge :${bridge.port}`);
    if (mon.lastError) bits.push(`err: ${mon.lastError}`);
    line.textContent = `Global monitor — ${bits.join(" · ")}`;
  }

  const list = $("feedList");
  if (!list) return;
  const rows = state?.monitorFeed || mon.feed || [];
  if (!rows.length) {
    list.innerHTML = `<div class="empty muted">No events yet — start the engine with Bandai global monitor enabled.</div>`;
    return;
  }
  list.innerHTML = rows
    .map((h, idx) => {
      const title = h.title || h.productName || h.productId || "—";
      const reason = (h.reason || "restock").replace(/_/g, " ");
      const when = h.receivedAt
        ? new Date(h.receivedAt).toLocaleTimeString()
        : h.at
          ? String(h.at).slice(11, 19)
          : "";
      return `<div class="item" data-feed-idx="${idx}">
        <div>
          <span class="badge hv">${esc(reason)}</span>
          <strong>${esc(title)}</strong>
          <div class="meta">${esc(h.productId || "")}${h.areaItemNo ? ` · ${esc(h.areaItemNo)}` : ""}${when ? ` · ${esc(when)}` : ""}</div>
          <div class="feed-row-actions">
            <button type="button" data-feed-qt="${idx}">Quick Task</button>
            <button type="button" class="secondary" data-feed-sa="${idx}">Use in Smart Action</button>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

async function runQuickTask(payload) {
  if (!window.desktop?.quickTask) {
    appendLog("Quick Task unavailable", "err");
    return;
  }
  const res = await window.desktop.quickTask(payload);
  if (res.snapshot) applyState(res.snapshot);
  if (!res.ok) appendLog(esc(res.error || "Quick Task failed"), "err");
  else
    appendLog(
      `Quick Task ${res.started ? "started" : "created"} — ${esc(res.task?.label || res.task?.id || "")}`,
      "ok",
    );
  return res;
}

if ($("btnQuickTask")) {
  $("btnQuickTask").onclick = async () => {
    const input = $("qtInput")?.value?.trim() || "";
    if (!input) {
      appendLog("Paste a Bandai SKU or PDP URL first", "err");
      return;
    }
    await runQuickTask({ input });
  };
}
if ($("qtInput")) {
  $("qtInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btnQuickTask")?.click();
    }
  });
}
if ($("btnFeedClear")) {
  $("btnFeedClear").onclick = async () => {
    const res = await window.desktop.monitorFeedClear();
    if (res.snapshot) applyState(res.snapshot);
    else if (state) {
      state.monitorFeed = [];
      renderMonitorFeed();
    }
  };
}

// ── Smart Actions UI ───────────────────────────────────────────────────────

let saDraftFilters = [];
let saDraftActions = [];

function saOutcomeBadge(result) {
  if (!result) return `<span class="badge">—</span>`;
  const r = String(result);
  if (r === "Filtered") return `<span class="badge filtered">Filtered</span>`;
  if (r === "Failed") return `<span class="badge failed">Failed</span>`;
  if (r === "Completed") return `<span class="badge completed">Completed</span>`;
  return `<span class="badge">${esc(r)}</span>`;
}

function saTriggerLabel(a) {
  const t = a?.trigger?.type;
  if (t === "quicktask") return "Quicktask";
  if (t === "schedule") {
    const at = a.trigger?.at || "??:??";
    const rep = a.trigger?.repeat === "once" ? "once" : "daily";
    return `Schedule ${at} (${rep})`;
  }
  return "Product Monitor";
}

function saCatalogState() {
  return state?.smartActionCatalog || { rows: [], templates: [], enabledTemplateIds: null };
}

function renderSaCatalog() {
  const cat = saCatalogState();
  const templates = cat.templates || [];
  const enabled = Array.isArray(cat.enabledTemplateIds) ? cat.enabledTemplateIds : null;
  const tmplEl = $("saCatalogTemplates");
  if (tmplEl) {
    if (!templates.length) {
      tmplEl.innerHTML = `<p class="field-hint">Templates load with app state.</p>`;
    } else {
      tmplEl.innerHTML = templates
        .map((t) => {
          const on = !enabled || !enabled.length || enabled.includes(t.id);
          return `<label class="check sa-catalog-tmpl">
            <input type="checkbox" data-sa-tmpl="${esc(t.id)}" ${on ? "checked" : ""} />
            <span><strong>${esc(String(t.name).replace(/\{\{.*?\}\}/g, "…"))}</strong>
            <span class="meta">${esc(t.blurb || t.id)}</span></span>
          </label>`;
        })
        .join("");
    }
  }
  const rowsEl = $("saCatalogRows");
  if (rowsEl) {
    const rows = cat.rows || [];
    if (!rows.length) {
      rowsEl.innerHTML = `<div class="empty muted">No catalog SKUs yet — paste above and Add SKUs.</div>`;
    } else {
      rowsEl.innerHTML = rows
        .map(
          (r) => `<div class="item">
          <div>
            <strong>${esc(r.title || r.sku)}</strong>
            ${r.enabled === false ? `<span class="badge">off</span>` : ""}
            <div class="meta">${esc(r.store)} · <code>${esc(r.sku)}</code> · group ${esc(
              r.taskGroup || "—",
            )}</div>
          </div>
          <div class="actions">
            <button type="button" class="secondary" data-sa-cat-del="${esc(r.id)}">Remove</button>
          </div>
        </div>`,
        )
        .join("");
    }
  }
  const meta = $("saCatalogMeta");
  if (meta) {
    const nT =
      enabled && enabled.length
        ? enabled.length
        : templates.length || 5;
    const nR = (cat.rows || []).filter((r) => r.enabled !== false).length;
    meta.textContent =
      nR > 0
        ? `${nR} SKU(s) × ${nT} template(s) ≈ ${nR * nT} Smart Actions on Apply`
        : "Add SKUs, pick templates, then Apply catalog.";
  }
}

function readSaCatalogEnabledTemplates() {
  const boxes = document.querySelectorAll("[data-sa-tmpl]");
  if (!boxes.length) return null;
  const ids = [];
  boxes.forEach((el) => {
    if (el.checked) ids.push(el.getAttribute("data-sa-tmpl"));
  });
  return ids;
}

function renderSmartActions() {
  renderSaCatalog();
  const list = $("saList");
  if (!list) return;
  const rows = state?.smartActions?.actions || [];
  if (!rows.length) {
    list.innerHTML = `<div class="empty muted">No Smart Actions yet — use Preset catalog or New Action.</div>`;
    return;
  }
  list.innerHTML = rows
    .map((a) => {
      const trig = saTriggerLabel(a);
      const filt = (a.filters || []).length;
      const acts = (a.actions || []).map((x) => x.type).join(" → ") || "—";
      const catBadge = a.catalogTemplateId
        ? `<span class="badge">catalog</span>`
        : "";
      return `<div class="item">
        <div>
          ${saOutcomeBadge(a.lastResult)}
          ${catBadge}
          <strong>${esc(a.name)}</strong>
          ${a.enabled === false ? `<span class="badge">off</span>` : ""}
          <div class="meta">${esc(trig)} · ${filt} filter(s) · ${esc(acts)}${
            a.runIntervalMs ? ` · interval ${a.runIntervalMs}ms` : ""
          }</div>
          <div class="feed-row-actions">
            <button type="button" data-sa-toggle="${esc(a.id)}" class="secondary">${
              a.enabled === false ? "Enable" : "Disable"
            }</button>
            <button type="button" data-sa-edit="${esc(a.id)}">Edit</button>
            <button type="button" class="secondary" data-sa-logs="${esc(a.id)}">Logs</button>
            <button type="button" class="secondary" data-sa-del="${esc(a.id)}">Delete</button>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

function saTargetEditorHtml(i, cfg, { allowCreated = true } = {}) {
  const t = cfg.target || {};
  const scope = t.scope || "created";
  return `<label>Target</label>
    <select data-sa-ac="${i}" data-k="target.scope">
      ${allowCreated ? `<option value="created" ${scope === "created" ? "selected" : ""}>Tasks created above</option>` : ""}
      <option value="group" ${scope === "group" ? "selected" : ""}>Task group</option>
      <option value="all" ${scope === "all" ? "selected" : ""}>All enabled tasks</option>
    </select>
    <label>Task group name</label>
    <input data-sa-ac="${i}" data-k="target.taskGroup" list="taskGroupList" value="${esc(
      t.taskGroup || "",
    )}" placeholder="Drop A" />
    <p class="field-hint">Group matching is case-insensitive. Set Task group on each task.</p>`;
}

function syncSaScheduleVisibility() {
  const opts = $("saScheduleOpts");
  if (!opts) return;
  opts.hidden = ($("saTrigger")?.value || "") !== "schedule";
}

function renderSaFiltersEditor() {
  const el = $("saFilters");
  if (!el) return;
  if (!saDraftFilters.length) {
    el.innerHTML = `<p class="field-hint">No filters — action runs on every matching trigger.</p>`;
    return;
  }
  el.innerHTML = saDraftFilters
    .map(
      (f, i) => `<div class="sa-filter-row">
      <div>
        <label>Field</label>
        <select data-sa-ff="${i}">
          ${["store", "title", "sku", "url", "reason"]
            .map(
              (v) =>
                `<option value="${v}" ${f.field === v ? "selected" : ""}>${v}</option>`,
            )
            .join("")}
        </select>
      </div>
      <div>
        <label>Op</label>
        <select data-sa-fo="${i}">
          ${["matches", "contains", "equals"]
            .map(
              (v) =>
                `<option value="${v}" ${(f.op || "matches") === v ? "selected" : ""}>${v}</option>`,
            )
            .join("")}
        </select>
      </div>
      <div>
        <label>Value</label>
        <input data-sa-fv="${i}" value="${esc(f.value || "")}" placeholder="gundam, -rg" />
      </div>
      <button type="button" class="secondary" data-sa-fdel="${i}">✕</button>
    </div>`,
    )
    .join("");
}

function renderSaActionsEditor() {
  const el = $("saActions");
  if (!el) return;
  if (!saDraftActions.length) {
    el.innerHTML = `<p class="field-hint">Add actions in order — e.g. Start Harvester → Wait → Start Tasks (group).</p>`;
    return;
  }
  el.innerHTML = saDraftActions
    .map((a, i) => {
      const cfg = a.config || {};
      if (a.type === "create_tasks") {
        return `<div class="sa-action-row">
          <div class="sa-action-head"><strong>Create Tasks</strong>
            <button type="button" class="secondary" data-sa-adel="${i}">Remove</button></div>
          <label class="check"><input type="checkbox" data-sa-ac="${i}" data-k="usePreset" ${
            cfg.usePreset !== false ? "checked" : ""
          } /> Use Quick Task preset</label>
          <label>Mode</label>
          <select data-sa-ac="${i}" data-k="bandaiMode">
            <option value="checkout" ${cfg.bandaiMode !== "monitor" ? "selected" : ""}>Autocheckout</option>
            <option value="monitor" ${cfg.bandaiMode === "monitor" ? "selected" : ""}>Monitor</option>
          </select>
          <label>Task group</label>
          <input data-sa-ac="${i}" data-k="taskGroup" list="taskGroupList" value="${esc(
            cfg.taskGroup || "",
          )}" placeholder="optional — tag created tasks" />
          <label>Label template</label>
          <input data-sa-ac="${i}" data-k="labelTemplate" value="${esc(
            cfg.labelTemplate || "{{title}}",
          )}" />
          <div class="grid2">
            <div>
              <label>Count</label>
              <input type="number" min="1" max="20" data-sa-ac="${i}" data-k="count" value="${
                cfg.count ?? 1
              }" />
            </div>
            <div>
              <label>Qty</label>
              <input type="number" min="1" max="20" data-sa-ac="${i}" data-k="qty" value="${
                cfg.qty ?? 1
              }" />
            </div>
          </div>
        </div>`;
      }
      if (a.type === "update_tasks") {
        return `<div class="sa-action-row">
          <div class="sa-action-head"><strong>Update Tasks</strong>
            <button type="button" class="secondary" data-sa-adel="${i}">Remove</button></div>
          ${saTargetEditorHtml(i, cfg)}
          <label>Product SKU / URL <span class="optional">templates ok</span></label>
          <input data-sa-ac="${i}" data-k="product" value="${esc(
            cfg.product || "{{sku}}",
          )}" placeholder="{{sku}} or PDP URL" />
          <label>PDP URL override</label>
          <input data-sa-ac="${i}" data-k="pdpUrl" value="${esc(cfg.pdpUrl || "")}" placeholder="optional {{url}}" />
          <label>Qty <span class="optional">blank = keep</span></label>
          <input type="number" min="1" max="20" data-sa-ac="${i}" data-k="qty" value="${
            cfg.qty != null && cfg.qty !== "" ? cfg.qty : ""
          }" />
          <label>Label template <span class="optional">blank = keep</span></label>
          <input data-sa-ac="${i}" data-k="labelTemplate" value="${esc(cfg.labelTemplate || "")}" />
        </div>`;
      }
      if (a.type === "start_tasks") {
        return `<div class="sa-action-row">
          <div class="sa-action-head"><strong>Start Tasks</strong>
            <button type="button" class="secondary" data-sa-adel="${i}">Remove</button></div>
          ${saTargetEditorHtml(i, cfg)}
        </div>`;
      }
      if (a.type === "stop_tasks") {
        return `<div class="sa-action-row">
          <div class="sa-action-head"><strong>Stop Tasks</strong>
            <button type="button" class="secondary" data-sa-adel="${i}">Remove</button></div>
          ${saTargetEditorHtml(i, cfg)}
        </div>`;
      }
      if (a.type === "wait") {
        return `<div class="sa-action-row">
          <div class="sa-action-head"><strong>Wait</strong>
            <button type="button" class="secondary" data-sa-adel="${i}">Remove</button></div>
          <label>Delay (seconds)</label>
          <input type="number" min="0" max="1800" data-sa-ac="${i}" data-k="delaySec" value="${
            cfg.delaySec ?? 60
          }" />
          <p class="field-hint">Max 30 minutes. Use between Start Harvester and Start Tasks.</p>
        </div>`;
      }
      if (a.type === "start_harvester") {
        return `<div class="sa-action-row">
          <div class="sa-action-head"><strong>Start Harvester</strong>
            <button type="button" class="secondary" data-sa-adel="${i}">Remove</button></div>
          <p class="field-hint">Starts Bandai harvest pool (engine must be on; proxy group set on Harvest tab).</p>
        </div>`;
      }
      if (a.type === "stop_harvester") {
        return `<div class="sa-action-row">
          <div class="sa-action-head"><strong>Stop Harvester</strong>
            <button type="button" class="secondary" data-sa-adel="${i}">Remove</button></div>
        </div>`;
      }
      if (a.type === "notify_discord") {
        return `<div class="sa-action-row">
          <div class="sa-action-head"><strong>Notify Discord</strong>
            <button type="button" class="secondary" data-sa-adel="${i}">Remove</button></div>
          <label>Message</label>
          <input data-sa-ac="${i}" data-k="message" value="${esc(
            cfg.message || "Smart Action: {{title}} ({{sku}})",
          )}" />
          <p class="field-hint">Uses your checkout webhook — not the Railway restock channel.</p>
        </div>`;
      }
      return `<div class="sa-action-row">
        <div class="sa-action-head"><strong>${esc(a.type)}</strong>
          <button type="button" class="secondary" data-sa-adel="${i}">Remove</button></div>
      </div>`;
    })
    .join("");
}

function setSaConfigPath(cfg, path, value) {
  const parts = String(path).split(".");
  let cur = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function syncSaDraftFromForm() {
  saDraftFilters = saDraftFilters.map((f, i) => ({
    field: document.querySelector(`[data-sa-ff="${i}"]`)?.value || f.field || "title",
    op: document.querySelector(`[data-sa-fo="${i}"]`)?.value || f.op || "matches",
    value: document.querySelector(`[data-sa-fv="${i}"]`)?.value ?? f.value ?? "",
  }));
  saDraftActions = saDraftActions.map((a, i) => {
    const cfg = { ...(a.config || {}) };
    if (cfg.target) cfg.target = { ...cfg.target };
    document.querySelectorAll(`[data-sa-ac="${i}"]`).forEach((node) => {
      const k = node.getAttribute("data-k");
      if (!k) return;
      let val;
      if (node.type === "checkbox") val = node.checked;
      else if (node.type === "number") {
        val = node.value === "" ? "" : Number(node.value);
      } else val = node.value;
      if (k.includes(".")) setSaConfigPath(cfg, k, val);
      else cfg[k] = val;
    });
    return { type: a.type, config: cfg };
  });
}

function openSaEditor(action) {
  const form = $("saForm");
  if (!form) return;
  form.hidden = false;
  $("saFormTitle").textContent = action?.id ? "Edit Smart Action" : "New Smart Action";
  $("saId").value = action?.id || "";
  $("saName").value = action?.name || "";
  $("saEnabled").checked = action?.enabled !== false;
  $("saRunOnce").checked = action?.runOnce === true;
  $("saNotifications").checked = action?.notifications !== false;
  $("saRunInterval").value = action?.runIntervalMs ?? 30000;
  const trigType = action?.trigger?.type || "product_monitor";
  $("saTrigger").value = ["quicktask", "schedule", "product_monitor"].includes(trigType)
    ? trigType
    : "product_monitor";
  if ($("saScheduleAt")) $("saScheduleAt").value = action?.trigger?.at || "07:00";
  if ($("saScheduleRepeat"))
    $("saScheduleRepeat").value = action?.trigger?.repeat === "once" ? "once" : "daily";
  if ($("saScheduleTz"))
    $("saScheduleTz").value = action?.trigger?.tz || "Australia/Sydney";
  syncSaScheduleVisibility();
  saDraftFilters = Array.isArray(action?.filters)
    ? action.filters.map((f) => ({ ...f }))
    : [];
  saDraftActions = Array.isArray(action?.actions)
    ? action.actions.map((a) => ({ type: a.type, config: { ...(a.config || {}) } }))
    : [
        {
          type: "create_tasks",
          config: {
            usePreset: true,
            bandaiMode: "checkout",
            labelTemplate: "{{title}}",
            count: 1,
            qty: 1,
            taskGroup: "",
          },
        },
        { type: "start_tasks", config: { target: { scope: "created", taskGroup: "" } } },
      ];
  renderSaFiltersEditor();
  renderSaActionsEditor();
}

function closeSaEditor() {
  if ($("saForm")) $("saForm").hidden = true;
  saDraftFilters = [];
  saDraftActions = [];
}

if ($("btnSaNew")) {
  $("btnSaNew").onclick = () => openSaEditor(null);
}
if ($("btnSaCatalogAdd")) {
  $("btnSaCatalogAdd").onclick = async () => {
    const text = $("saCatalogBulk")?.value || "";
    if (!text.trim()) {
      appendLog("Paste SKUs first", "err");
      return;
    }
    const res = await window.desktop.smartActionCatalogAddBulk(text, {
      defaultStore: "bandai",
    });
    if (res.snapshot) applyState(res.snapshot);
    if ($("saCatalogBulk")) $("saCatalogBulk").value = "";
    appendLog(`Catalog: added ${res.added ?? 0} SKU(s) (${res.total ?? 0} total)`, "ok");
  };
}
if ($("btnSaCatalogApply")) {
  $("btnSaCatalogApply").onclick = async () => {
    const enabledTemplateIds = readSaCatalogEnabledTemplates();
    await window.desktop.smartActionCatalogSave({ enabledTemplateIds });
    const res = await window.desktop.smartActionCatalogApply({
      enabledTemplateIds,
      pruneMissing: false,
    });
    if (res.snapshot) applyState(res.snapshot);
    appendLog(
      `Catalog applied — ${res.createdOrUpdated ?? 0} action(s) (${res.rowCount ?? 0}×${res.templateCount ?? 0})`,
      "ok",
    );
  };
}
if ($("btnSaCatalogRemove")) {
  $("btnSaCatalogRemove").onclick = async () => {
    const res = await window.desktop.smartActionCatalogRemoveActions({});
    if (res.snapshot) applyState(res.snapshot);
    appendLog(`Removed ${res.removed ?? 0} catalog Smart Action(s)`, "ok");
  };
}
if ($("btnSaCancel")) {
  $("btnSaCancel").onclick = () => closeSaEditor();
}
if ($("btnSaAddFilter")) {
  $("btnSaAddFilter").onclick = () => {
    syncSaDraftFromForm();
    saDraftFilters.push({ field: "sku", op: "matches", value: "" });
    renderSaFiltersEditor();
  };
}
if ($("btnSaAddCreate")) {
  $("btnSaAddCreate").onclick = () => {
    syncSaDraftFromForm();
    saDraftActions.push({
      type: "create_tasks",
      config: {
        usePreset: true,
        bandaiMode: "checkout",
        labelTemplate: "{{title}}",
        count: 1,
        qty: 1,
        taskGroup: "",
      },
    });
    renderSaActionsEditor();
  };
}
if ($("btnSaAddStart")) {
  $("btnSaAddStart").onclick = () => {
    syncSaDraftFromForm();
    saDraftActions.push({
      type: "start_tasks",
      config: { target: { scope: "created", taskGroup: "" } },
    });
    renderSaActionsEditor();
  };
}
if ($("btnSaAddStop")) {
  $("btnSaAddStop").onclick = () => {
    syncSaDraftFromForm();
    saDraftActions.push({
      type: "stop_tasks",
      config: { target: { scope: "group", taskGroup: "" } },
    });
    renderSaActionsEditor();
  };
}
if ($("btnSaAddUpdate")) {
  $("btnSaAddUpdate").onclick = () => {
    syncSaDraftFromForm();
    saDraftActions.push({
      type: "update_tasks",
      config: {
        target: { scope: "group", taskGroup: "" },
        product: "{{sku}}",
        pdpUrl: "",
        qty: "",
        labelTemplate: "",
      },
    });
    renderSaActionsEditor();
  };
}
if ($("btnSaAddWait")) {
  $("btnSaAddWait").onclick = () => {
    syncSaDraftFromForm();
    saDraftActions.push({ type: "wait", config: { delaySec: 60 } });
    renderSaActionsEditor();
  };
}
if ($("btnSaAddHarvestStart")) {
  $("btnSaAddHarvestStart").onclick = () => {
    syncSaDraftFromForm();
    saDraftActions.push({ type: "start_harvester", config: {} });
    renderSaActionsEditor();
  };
}
if ($("btnSaAddHarvestStop")) {
  $("btnSaAddHarvestStop").onclick = () => {
    syncSaDraftFromForm();
    saDraftActions.push({ type: "stop_harvester", config: {} });
    renderSaActionsEditor();
  };
}
if ($("btnSaAddNotify")) {
  $("btnSaAddNotify").onclick = () => {
    syncSaDraftFromForm();
    saDraftActions.push({
      type: "notify_discord",
      config: { message: "Smart Action: {{title}} ({{sku}})" },
    });
    renderSaActionsEditor();
  };
}
if ($("saTrigger")) {
  $("saTrigger").onchange = () => syncSaScheduleVisibility();
}
if ($("saForm")) {
  $("saForm").onsubmit = async (e) => {
    e.preventDefault();
    syncSaDraftFromForm();
    const trigType = $("saTrigger").value || "product_monitor";
    const trigger =
      trigType === "schedule"
        ? {
            type: "schedule",
            at: $("saScheduleAt")?.value || "07:00",
            repeat: $("saScheduleRepeat")?.value || "daily",
            tz: $("saScheduleTz")?.value || "Australia/Sydney",
          }
        : { type: trigType };
    const payload = {
      id: $("saId").value || undefined,
      name: $("saName").value.trim() || "Untitled action",
      enabled: $("saEnabled").checked,
      runOnce: $("saRunOnce").checked,
      notifications: $("saNotifications").checked,
      runIntervalMs: Number($("saRunInterval").value) || 0,
      trigger,
      filters: saDraftFilters.filter((f) => String(f.value || "").trim()),
      actions: saDraftActions,
    };
    const res = await window.desktop.smartActionUpsert(payload);
    if (res.snapshot) applyState(res.snapshot);
    closeSaEditor();
    appendLog(`Smart Action saved — ${esc(payload.name)}`, "ok");
  };
}
if ($("btnSaLogClose")) {
  $("btnSaLogClose").onclick = () => {
    if ($("saLogPanel")) $("saLogPanel").hidden = true;
  };
}

// Delegate feed + SA list clicks (extend existing body click handler via capture)
document.body.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.dataset.feedQt != null) {
    const idx = Number(t.dataset.feedQt);
    const hit = (state?.monitorFeed || [])[idx];
    if (!hit) return;
    await runQuickTask({ hit });
    return;
  }
  if (t.dataset.feedSa != null) {
    const idx = Number(t.dataset.feedSa);
    const hit = (state?.monitorFeed || [])[idx];
    if (!hit) return;
    const res = await window.desktop.smartActionFromHit(hit);
    if (res.ok && res.draft) {
      setTab("smart");
      openSaEditor(res.draft);
      appendLog("Smart Action draft from feed hit — review & save", "muted");
    }
    return;
  }
  if (t.dataset.saToggle) {
    const id = t.dataset.saToggle;
    const row = (state?.smartActions?.actions || []).find((a) => a.id === id);
    const res = await window.desktop.smartActionSetEnabled(id, row?.enabled === false);
    if (res.snapshot) applyState(res.snapshot);
    return;
  }
  if (t.dataset.saEdit) {
    const row = (state?.smartActions?.actions || []).find((a) => a.id === t.dataset.saEdit);
    if (row) openSaEditor(row);
    return;
  }
  if (t.dataset.saLogs) {
    const id = t.dataset.saLogs;
    const row = (state?.smartActions?.actions || []).find((a) => a.id === id);
    const res = await window.desktop.smartActionLogs(id);
    const panel = $("saLogPanel");
    const logEl = $("saLogList");
    if (panel && logEl) {
      panel.hidden = false;
      $("saLogTitle").textContent = `Logs — ${row?.name || id}`;
      const logs = res.logs || [];
      logEl.innerHTML = logs.length
        ? logs
            .map((l) => {
              const cls =
                l.level === "err" ? "err" : l.level === "ok" ? "ok" : l.level === "warn" ? "warn" : "muted";
              const ts = l.at ? new Date(l.at).toLocaleTimeString() : "";
              return `<div class="${cls}">${esc(ts)} · ${esc(l.step)} · ${esc(l.message)}</div>`;
            })
            .join("")
        : `<div class="muted">No runs yet</div>`;
    }
    return;
  }
  if (t.dataset.saCatDel) {
    const res = await window.desktop.smartActionCatalogDeleteRow(t.dataset.saCatDel);
    if (res.snapshot) applyState(res.snapshot);
    appendLog(`Catalog SKU removed (${res.removedActions || 0} action(s) cleared)`, "ok");
    return;
  }
  if (t.dataset.saDel) {
    if (!confirm("Delete this Smart Action?")) return;
    const res = await window.desktop.smartActionDelete(t.dataset.saDel);
    if (res.snapshot) applyState(res.snapshot);
    return;
  }
  if (t.dataset.saFdel != null) {
    syncSaDraftFromForm();
    saDraftFilters.splice(Number(t.dataset.saFdel), 1);
    renderSaFiltersEditor();
    return;
  }
  if (t.dataset.saAdel != null) {
    syncSaDraftFromForm();
    saDraftActions.splice(Number(t.dataset.saAdel), 1);
    renderSaActionsEditor();
    return;
  }
});

if (!window.desktop) {
  console.error("desktop preload failed — UI bridge unavailable");
} else {
window.desktop.onEvent((evt) => {
  if (evt.type === "snapshot" && evt.data) applyState(evt.data);
  if (evt.type === "navigate" && evt.tab) {
    setTab(evt.tab);
    if (evt.focus === "quickTaskPreset") {
      const el = $("qtPresetProfile") || $("qtPresetStore");
      try {
        el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
        el?.focus?.();
      } catch {
        /* ignore */
      }
    }
  }
  if (evt.type === "monitorFeed") {
    if (evt.cleared && state) {
      state.monitorFeed = [];
    } else if (evt.hit && state) {
      state.monitorFeed = [evt.hit, ...(state.monitorFeed || [])].slice(0, 80);
      if (state.bandaiGlobalMonitor) {
        state.bandaiGlobalMonitor = {
          ...state.bandaiGlobalMonitor,
          hits: (state.bandaiGlobalMonitor.hits || 0) + 1,
          feed: state.monitorFeed,
        };
      }
    } else if (evt.feed && state) {
      state.monitorFeed = evt.feed;
    }
    renderMonitorFeed();
  }
  if (evt.type === "smartActions" && evt.data && state) {
    state.smartActions = evt.data;
    renderSmartActions();
  }
  if (evt.type === "smartAction" && evt.phase === "done") {
    if (evt.outcome === "Filtered") {
      // Keep overview lastResult; skip live-log spam on busy feeds.
    } else {
      appendLog(
        `SA ${esc(evt.outcome || "")} — ${esc(evt.message || evt.actionId || "")}`,
        evt.outcome === "Failed" ? "err" : "ok",
      );
    }
  }
  if (evt.type === "harvest" && evt.data) {
    if (state) state.harvest = evt.data;
    renderHarvest(evt.data);
    renderHarvestBankStrip();
  }
  if (evt.type === "bandaiHarvest" && evt.data) {
    if (state) state.bandaiHarvest = evt.data;
    renderBandaiHarvest();
    renderHarvestBankStrip();
  }
  if (evt.type === "disneyHarvest" && evt.data) {
    if (state) state.disneyHarvest = evt.data;
    renderDisneyHarvest();
    renderHarvestBankStrip();
  }
  if (evt.type === "dropSchedule") {
    if (state) state.dropSchedule = evt.data || { armed: false };
    renderDropPrep();
  }
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
}
