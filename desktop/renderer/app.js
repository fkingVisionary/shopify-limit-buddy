/* global desktop from preload */
const $ = (id) => document.getElementById(id);

let state = null;
/** @type {Record<string, object>} last proxy test results by group id */
const proxyTestResults = {};
/** @type {"all"|"ungrouped"|string} */
let taskGroupFilter = "all";
/** @type {"all"|"ungrouped"|string} */
let profileGroupFilter = "all";
/** @type {"all"|"ungrouped"|string} */
let accountGroupFilter = "all";
/** @type {string|null} */
let selectedProxyGroupId = null;
/** @type {"today"|"week"|"month"|"year"} */
let homePeriod = "today";
/** @type {"checkouts"|"spend"} */
let homeMetric = "checkouts";
/** @type {"speed"|"failed"|null} */
let proxySortMode = null;
const homeActivityLines = [];
const HOME_DISMISS_KEY = "vanta.home.dismiss.v1";

function homeDismissState() {
  try {
    const raw = JSON.parse(localStorage.getItem(HOME_DISMISS_KEY) || "{}");
    return {
      suggested: Boolean(raw.suggested),
      setup: Boolean(raw.setup),
    };
  } catch {
    return { suggested: false, setup: false };
  }
}

function setHomeDismiss(key, value = true) {
  const next = { ...homeDismissState(), [key]: Boolean(value) };
  try {
    localStorage.setItem(HOME_DISMISS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

const GROUP_PALETTE = [
  "#c8c8cc",
  "#9a9aa0",
  "#d4af77",
  "#b8b0a0",
  "#8a9a8a",
  "#a8a0b0",
  "#8a9aaa",
  "#c4b08a",
  "#b09080",
  "#9098a8",
];

function groupKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function colorForGroup(name, colorMap) {
  const key = groupKey(name);
  if (!key) return GROUP_PALETTE[0];
  const overrides = colorMap || state?.taskGroupColors || {};
  const raw = overrides[name] ?? overrides[key];
  if (raw && /^#[0-9a-fA-F]{3,8}$/.test(String(raw))) return String(raw);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return GROUP_PALETTE[h % GROUP_PALETTE.length];
}

function confirmDelete(label) {
  return window.confirm(`Delete ${label}?`);
}

function searchQuery(id) {
  return String($(id)?.value || "")
    .trim()
    .toLowerCase();
}

function toast(message, cls = "") {
  const host = $("toastHost");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${cls}`.trim();
  el.textContent = String(message || "");
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 200);
  }, 2800);
}

function notify(message, cls = "") {
  toast(message, cls);
}

function openDialog(id) {
  const dlg = $(id);
  if (!dlg || typeof dlg.showModal !== "function") return;
  if (!dlg.open) dlg.showModal();
}

function closeDialog(id) {
  const dlg = $(id);
  if (!dlg) return;
  if (typeof dlg.close === "function" && dlg.open) dlg.close();
}

function tickClock() {
  const el = $("clock");
  if (!el) return;
  const d = new Date();
  el.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function wireWindowControls() {
  if (!window.desktop) return;
  $("btnWinMin")?.addEventListener("click", () => window.desktop.windowMinimize());
  $("btnWinMax")?.addEventListener("click", async () => {
    const max = await window.desktop.windowMaximize();
    document.body.classList.toggle("is-maximized", Boolean(max));
  });
  $("btnWinClose")?.addEventListener("click", () => window.desktop.windowClose());
  window.desktop.windowIsMaximized?.().then((m) => {
    document.body.classList.toggle("is-maximized", Boolean(m));
  });
}

function setSettingsPane(name) {
  let pane = String(name || "general");
  if (!document.querySelector(`.settings-pane[data-pane="${pane}"]`)) pane = "general";
  document.querySelectorAll(".settings-nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.settingsPane === pane);
  });
  document.querySelectorAll(".settings-pane").forEach((p) => {
    p.classList.toggle("active", p.dataset.pane === pane);
  });
}

/** Short win chirp via Web Audio (no asset file). */
function playWinSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02 + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28 + i * 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.08);
      osc.stop(now + 0.35 + i * 0.08);
    });
    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch {
    /* ignore */
  }
}

function setTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${name}`);
  });
  if (name === "home") renderHome();
  if (name === "settings") setSettingsPane(document.querySelector(".settings-nav-item.active")?.dataset.settingsPane || "general");
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => setTab(b.dataset.tab);
});

document.querySelectorAll(".settings-nav-item").forEach((b) => {
  b.onclick = () => setSettingsPane(b.dataset.settingsPane);
});

document.body.addEventListener("click", (e) => {
  const periodBtn = e.target instanceof HTMLElement ? e.target.closest("[data-home-period]") : null;
  if (periodBtn) {
    homePeriod = periodBtn.dataset.homePeriod || "today";
    document.querySelectorAll("[data-home-period]").forEach((x) => {
      x.classList.toggle("active", x.dataset.homePeriod === homePeriod);
    });
    renderHome();
    return;
  }
  const metricBtn = e.target instanceof HTMLElement ? e.target.closest("[data-home-metric]") : null;
  if (metricBtn) {
    homeMetric = metricBtn.dataset.homeMetric === "spend" ? "spend" : "checkouts";
    document.querySelectorAll("[data-home-metric]").forEach((x) => {
      x.classList.toggle("active", x.dataset.homeMetric === homeMetric);
    });
    renderHome();
    return;
  }
  const dismissBtn = e.target instanceof HTMLElement ? e.target.closest("[data-home-dismiss]") : null;
  if (dismissBtn) {
    const key = dismissBtn.getAttribute("data-home-dismiss");
    if (key === "suggested" || key === "setup") {
      setHomeDismiss(key, true);
      renderHome();
    }
  }
});

function engineUi() {
  const eng = state?.engine || {};
  const run = state?.runner || {};
  const dot = $("engineDot");
  const label = $("engineLabel");
  const retry = $("btnRetryEngine");
  if (eng.running && run.inflight > 0) {
    dot.className = "dot busy";
    label.textContent = `Engine on · ${run.inflight} in flight · ${run.queued} queued`;
    if (retry) retry.hidden = true;
  } else if (eng.running) {
    dot.className = "dot on";
    label.textContent = eng.hyperConfigured ? "Engine on · keys ready" : "Engine on";
    if (retry) retry.hidden = true;
  } else {
    dot.className = "dot";
    const why = state?.settings?.licenseMessage || "add API key in Settings if needed";
    label.textContent = `Engine starting… (${why})`;
    if (retry) retry.hidden = false;
  }
  const engineLine = $("homeEngineLine");
  if (engineLine) {
    if (eng.running) {
      engineLine.textContent = eng.hyperConfigured
        ? "Engine ready · checkout keys ready"
        : "Engine ready";
    } else {
      engineLine.textContent = "Engine starting… save Settings or hit Retry if it stalls.";
    }
  }
}

function profilesInGroup(groupName) {
  const key = groupKey(groupName);
  if (!key) return [];
  return (state?.profiles || []).filter((p) => groupKey(p.profileGroup) === key);
}

function fillTaskProfileGroupSelect(selected) {
  const sel = $("taskProfileGroup");
  if (!sel) return;
  const want = selected != null ? String(selected || "") : String(sel.value || "");
  const names = profileGroupNames([want, profileGroupFilter]);
  fillNamedGroupSelect(sel, names, {
    selected: want,
    emptyLabel: "Select group…",
  });
  refreshTaskProfileGroupHint();
}

function refreshTaskProfileGroupHint() {
  const hint = $("taskProfileGroupHint");
  if (!hint) return;
  const group = $("taskProfileGroup")?.value || "";
  const per = Math.max(1, Math.min(20, Number($("taskPerProfile")?.value) || 1));
  const n = profilesInGroup(group).length;
  if (!group) {
    hint.textContent = "Creates that many tasks for every profile in the group.";
    return;
  }
  if (!n) {
    hint.textContent = `No profiles in “${group}” yet — add profiles to that group first.`;
    return;
  }
  const total = n * per;
  hint.textContent = `${n} profile${n === 1 ? "" : "s"} × ${per} = ${total} task${total === 1 ? "" : "s"}`;
}

function syncTaskProfileSourceUi() {
  const editing = Boolean($("taskId")?.value);
  const source = editing ? "single" : $("taskProfileSource")?.value || "single";
  if ($("taskProfileSource")) {
    $("taskProfileSource").disabled = editing;
    if (editing) $("taskProfileSource").value = "single";
  }
  const single = $("taskProfileSingleWrap");
  const group = $("taskProfileGroupWrap");
  if (single) single.hidden = source === "group";
  if (group) group.hidden = source !== "group";
  if (source === "group") {
    fillTaskProfileGroupSelect();
    refreshTaskProfileGroupHint();
  }
}

function fillSelects() {
  const prof = $("taskProfile");
  const px = $("taskProxy");
  const curP = prof?.value || "";
  const curX = px?.value || "";
  if (prof) {
    prof.innerHTML =
      `<option value="">Select profile…</option>` +
      (state.profiles || [])
        .map((p) => {
          const g = String(p.profileGroup || "").trim();
          const label = g
            ? `${p.name || p.email || p.id} · ${g}`
            : p.name || p.email || p.id;
          return `<option value="${p.id}">${esc(label)}</option>`;
        })
        .join("");
    if (curP) prof.value = curP;
  }
  if (px) {
    px.innerHTML =
      `<option value="">Direct (no proxy)</option>` +
      (state.proxyGroups || [])
        .map((g) => `<option value="${g.id}">${esc(g.name)} (${g.entries?.length || 0})</option>`)
        .join("");
    if (curX) px.value = curX;
  }
  fillTaskProfileGroupSelect();
  syncTaskProfileSourceUi();
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

const BANDAI_REGIONS = ["au", "us", "nz", "sg", "hk", "tw", "fr"];

function isBandaiStore(store) {
  const s = String(store || "").toLowerCase();
  return s === "bandai" || /^bandai-[a-z]{2}$/.test(s);
}

function parseBandaiStoreSelection(storeValue, areaHint) {
  const raw = String(storeValue || "").trim();
  const m = raw.match(/^bandai-([a-z]{2})$/i);
  if (m || raw.toLowerCase() === "bandai") {
    const hint = String(areaHint || "")
      .trim()
      .toLowerCase();
    const area = BANDAI_REGIONS.includes((m?.[1] || "").toLowerCase())
      ? m[1].toLowerCase()
      : BANDAI_REGIONS.includes(hint)
        ? hint
        : "au";
    return { store: "bandai", bandaiArea: area };
  }
  return { store: raw || "bandai", bandaiArea: undefined };
}

function bandaiStoreSelectValue(task) {
  if (!isBandaiStore(task?.store)) return task?.store || "bandai-au";
  const fromUrl = (String(task?.pdpUrl || "").match(/p-bandai\.com\/([a-z]{2})(?:\/|$)/i) ||
    [])[1];
  const area = BANDAI_REGIONS.includes(String(task?.bandaiArea || "").toLowerCase())
    ? String(task.bandaiArea).toLowerCase()
    : BANDAI_REGIONS.includes(String(fromUrl || "").toLowerCase())
      ? String(fromUrl).toLowerCase()
      : "au";
  return `bandai-${area}`;
}

function rewriteBandaiPdpArea(url, area) {
  const a = BANDAI_REGIONS.includes(String(area || "").toLowerCase())
    ? String(area).toLowerCase()
    : "au";
  const s = String(url || "").trim();
  if (!s) return s;
  if (/p-bandai\.com\/[a-z]{2}\//i.test(s)) {
    return s.replace(/p-bandai\.com\/[a-z]{2}\//i, `p-bandai.com/${a}/`);
  }
  return s;
}

function syncTaskFormForStore() {
  const storeRaw = $("taskStore")?.value || "bandai-au";
  const parsedStore = parseBandaiStoreSelection(storeRaw);
  const store = parsedStore.store;
  const bandaiArea = parsedStore.bandaiArea || "au";
  const toy = store === "toymate";
  const bandai = isBandaiStore(storeRaw) || store === "bandai";
  const disney = store === "disney";
  const pc = store === "pokemoncentre";
  // Keep PDP URL region in sync with selected Bandai module.
  if (bandai && $("taskPdp") && !$("taskPdp").disabled) {
    const next = rewriteBandaiPdpArea($("taskPdp").value, bandaiArea);
    if (next !== $("taskPdp").value) $("taskPdp").value = next;
  }
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
            : `https://p-bandai.com/${bandaiArea}/item/…`;
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
      input.placeholder = "https://…";
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
    bAssign.hidden =
      !bandai || (mode !== "checkout" && mode !== "atc" && !monCheckout);
  }
  const bAtcHint = $("taskBandaiAtcHint");
  if (bAtcHint) bAtcHint.hidden = !bandai || mode !== "atc";
  const bPayPath = $("taskBandaiCheckoutModeWrap");
  if (bPayPath) {
    const monCheckout = mode === "monitor" && $("taskBandaiCheckoutOnHit")?.checked !== false;
    // Checkout + ATC both need watchdog / watch SKU; monitor-on-hit too.
    bPayPath.hidden = !bandai || (mode !== "checkout" && mode !== "atc" && !monCheckout);
  }
  const bPayWrap = $("taskBandaiPayWrap");
  if (bPayWrap) {
    const monCheckout = mode === "monitor" && $("taskBandaiCheckoutOnHit")?.checked !== false;
    bPayWrap.hidden = !bandai || (mode !== "checkout" && !monCheckout);
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
  if (bandai && (mode === "checkout" || mode === "atc" || mode === "monitor"))
    syncBandaiAccountAssignUi();
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function collectNamedGroups(rowNames, colorMap, extras = []) {
  const set = new Set();
  for (const n of rowNames || []) {
    const s = String(n || "").trim();
    if (s) set.add(s);
  }
  for (const k of Object.keys(colorMap || {})) {
    const s = String(k || "").trim();
    if (s) set.add(s);
  }
  for (const e of extras || []) {
    const s = String(e || "").trim();
    if (s && s !== "all" && s !== "ungrouped") set.add(s);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function fillNamedGroupSelect(sel, names, { selected, emptyLabel = "No group" } = {}) {
  if (!sel) return;
  const want = selected != null ? String(selected) : String(sel.value || "");
  const list = [...names];
  if (want && !list.includes(want)) list.push(want);
  sel.innerHTML =
    `<option value="">${esc(emptyLabel)}</option>` +
    list.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  sel.value = want && [...sel.options].some((o) => o.value === want) ? want : "";
}

function fillNamedGroupDatalist(dl, names) {
  if (!dl) return;
  dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
}

function taskGroupNames(extra) {
  return collectNamedGroups(
    (state?.tasks || []).map((t) => t.taskGroup),
    state?.taskGroupColors,
    extra,
  );
}

function profileGroupNames(extra) {
  return collectNamedGroups(
    (state?.profiles || []).map((p) => p.profileGroup),
    state?.profileGroupColors,
    extra,
  );
}

function accountGroupNames(extra) {
  return collectNamedGroups(
    (state?.accounts || []).map((a) => a.accountGroup),
    state?.accountGroupColors,
    extra,
  );
}

function refreshTaskGroupList() {
  const names = taskGroupNames([
    taskGroupFilter,
    $("taskGroup")?.value,
    $("massTaskGroup")?.value,
  ]);
  fillNamedGroupDatalist($("taskGroupList"), names);
  fillNamedGroupSelect($("taskGroup"), names, {
    selected: $("taskGroup")?.value || "",
    emptyLabel: "No group",
  });
  fillNamedGroupSelect($("massTaskGroup"), names, {
    selected: $("massTaskGroup")?.value || "",
    emptyLabel: "Select group…",
  });
}

function taskStoreLabel(t) {
  if (t.store === "toymate") {
    const mode = String(t.toymateMode || "checkout");
    const modeLabel =
      mode === "account_gen" ? "Account gen" : mode === "monitor" ? "Monitor" : "Autocheckout";
    return `Toymate · ${modeLabel}`;
  }
  if (t.store === "bandai" || isBandaiStore(t.store)) {
    const mode = String(t.bandaiMode || "checkout");
    const modeLabel =
      mode === "atc"
        ? "ATC only"
        : mode === "monitor"
          ? "Monitor"
          : mode === "account_gen"
            ? "Account gen"
            : mode === "login_check"
              ? "Login check"
              : "Autocheckout";
    const region = String(t.bandaiArea || "au").toUpperCase();
    const speed =
      mode === "checkout" || mode === "atc" ? ` · ${t.bandaiCheckoutMode || "fast"}` : "";
    const pay = /^paypal/i.test(String(t.paymentMethod || "")) ? " · PayPal" : "";
    const wd =
      (mode === "checkout" || mode === "atc") &&
      t.bandaiWatchdog !== false &&
      (t.bandaiWatchSku || t.pdpUrl || t.bandaiWatchKeywords)
        ? " · watchdog"
        : "";
    return `Bandai ${region} · ${modeLabel}${speed}${pay}${wd}`;
  }
  if (t.store === "pokemoncentre") {
    const mode = String(t.pcMode || "monitor");
    const modeLabel = mode === "checkout" ? "Autocheckout" : mode.charAt(0).toUpperCase() + mode.slice(1);
    return `Pokémon Centre · ${modeLabel}`;
  }
  return t.store || "Store";
}

function taskProductSubline(t) {
  const sku = String(t.bandaiWatchSku || t.productId || t.sku || "").trim();
  if (sku && !/^https?:\/\//i.test(sku)) return sku;
  const url = String(t.pdpUrl || "").trim();
  if (!url) return t.lastDropSummary || "";
  const m = url.match(/\/item\/([A-Za-z0-9_-]+)/i);
  if (m?.[1]) return m[1];
  return url.length > 64 ? `${url.slice(0, 64)}…` : url;
}

function formatCartHoldCountdown(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${String(sec).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function taskHasHeldCart(t) {
  return t?.store === "bandai" && Boolean(t.heldCart?.cartSn);
}

function heldCartsInGroup(groupName) {
  const key = groupKey(groupName);
  if (!key) return [];
  return (state?.tasks || []).filter(
    (t) => taskHasHeldCart(t) && groupKey(t.taskGroup) === key,
  );
}

function heldCartCountdownHtml(t) {
  if (!taskHasHeldCart(t)) return "";
  const start = Number(t.heldCart.cartHoldAt) || 0;
  const win = Number(t.heldCart.payWindowMs) || 30 * 60_000;
  if (!start) {
    return `<div class="task-sub cart-countdown">cart held — checkout now</div>`;
  }
  const left = Math.max(0, start + win - Date.now());
  if (left <= 0) {
    return `<div class="task-sub cart-countdown expired" data-hold-at="${start}" data-hold-win="${win}">hold may be up — verify &amp; pay</div>`;
  }
  return `<div class="task-sub cart-countdown" data-hold-at="${start}" data-hold-win="${win}">cart held · ${formatCartHoldCountdown(left)}</div>`;
}

function tickHeldCartCountdowns() {
  document.querySelectorAll(".cart-countdown[data-hold-at]").forEach((el) => {
    const start = Number(el.dataset.holdAt) || 0;
    const win = Number(el.dataset.holdWin) || 30 * 60_000;
    if (!start) return;
    const left = Math.max(0, start + win - Date.now());
    if (left <= 0) {
      el.textContent = "cart held? (window may be up)";
      el.classList.add("expired");
    } else {
      el.textContent = `cart held · ${formatCartHoldCountdown(left)}`;
      el.classList.remove("expired");
    }
  });
}

function taskStatusBadge(t) {
  const s = t.lastStatus;
  if (s === "confirmed" || s === "complete" || s === "ok" || s === "login_ok") return "ok";
  if (
    s === "held_pay_retry" ||
    s === "cart_held" ||
    s === "queued" ||
    s === "running" ||
    s === "rotating" ||
    s === "retry_pay" ||
    s === "retry_atc" ||
    s === "retry" ||
    s === "waiting_restock"
  ) {
    return "run";
  }
  if (s === "limit_reached") return "warn";
  if (
    s === "failed" ||
    s === "error" ||
    s === "akamai" ||
    s === "proxy" ||
    s === "declined" ||
    s === "held_cart_gone" ||
    s === "oos"
  ) {
    return "err";
  }
  return "";
}

function filteredTasks() {
  let tasks = state?.tasks || [];
  if (taskGroupFilter === "ungrouped") {
    tasks = tasks.filter((t) => !String(t.taskGroup || "").trim());
  } else if (taskGroupFilter !== "all") {
    const key = groupKey(taskGroupFilter);
    tasks = tasks.filter((t) => groupKey(t.taskGroup) === key);
  }
  const q = searchQuery("taskSearch");
  if (!q) return tasks;
  return tasks.filter((t) => {
    const prof = (state.profiles || []).find((p) => p.id === t.profileId);
    const px = (state.proxyGroups || []).find((g) => g.id === t.proxyGroupId);
    const hay = [
      t.label,
      t.taskGroup,
      t.store,
      taskStoreLabel(t),
      taskProductSubline(t),
      t.pdpUrl,
      t.bandaiWatchSku,
      t.sku,
      t.lastLabel,
      t.lastStatus,
      t.lastOrderNumber,
      t.lastDropSummary,
      prof?.name,
      prof?.email,
      px?.name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

function renderTaskGroupRail() {
  const rail = $("taskGroupRail");
  if (!rail) return;
  const tasks = state?.tasks || [];
  const counts = new Map();
  let ungrouped = 0;
  for (const t of tasks) {
    const g = String(t.taskGroup || "").trim();
    if (!g) {
      ungrouped += 1;
      continue;
    }
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const items = [
    { id: "all", name: "All", count: tasks.length },
    ...names.map((n) => ({ id: n, name: n, count: counts.get(n) || 0, color: colorForGroup(n) })),
    { id: "ungrouped", name: "Ungrouped", count: ungrouped },
  ];
  rail.innerHTML = items
    .map(
      (g) => `<button type="button" class="group-item ${taskGroupFilter === g.id || (g.id !== "all" && g.id !== "ungrouped" && groupKey(taskGroupFilter) === groupKey(g.id)) ? "active" : ""}" data-task-group-filter="${esc(g.id)}">
      <span class="name">${g.color ? `<span class="group-dot" style="background:${esc(g.color)}"></span>` : ""}${esc(g.name)}</span>
      <span class="count">${g.count}</span>
    </button>`,
    )
    .join("");
}

function renderTasks() {
  renderHarvestBankStrip();
  renderDropPrep();
  refreshTaskGroupList();
  renderTaskGroupRail();
  const titleEl = $("tasksGroupTitle");
  if (titleEl) {
    titleEl.textContent =
      taskGroupFilter === "all"
        ? "Tasks"
        : taskGroupFilter === "ungrouped"
          ? "Ungrouped"
          : taskGroupFilter;
  }
  if (
    $("massTaskGroup") &&
    taskGroupFilter !== "all" &&
    taskGroupFilter !== "ungrouped" &&
    document.activeElement !== $("massTaskGroup")
  ) {
    $("massTaskGroup").value = taskGroupFilter;
  }
  syncTaskGroupOpsBar();
  const el = $("taskList");
  if (!el) return;
  const tasks = filteredTasks();
  if (!tasks.length) {
    const searching = Boolean(searchQuery("taskSearch"));
    el.innerHTML = `<tr><td colspan="8" class="empty-cell">${
      searching ? "No tasks match this search." : "Press <kbd>N</kbd> for a new task."
    }</td></tr>`;
    return;
  }
  el.innerHTML = tasks
    .map((t) => {
      const statusLabel = t.lastLabel || t.lastStatus || "idle";
      const badge = taskStatusBadge(t);
      const prof = (state.profiles || []).find((p) => p.id === t.profileId);
      const px = (state.proxyGroups || []).find((g) => g.id === t.proxyGroupId);
      const groupName = String(t.taskGroup || "").trim();
      const groupChip = groupName
        ? `<span class="group-chip" style="--g:${esc(colorForGroup(groupName))}">${esc(groupName)}</span>`
        : "";
      const checkoutHeldBtn = taskHasHeldCart(t)
        ? `<button type="button" class="secondary" data-checkout-held="${t.id}" title="Pay from held cart (live verify)">Checkout now</button>`
        : "";
      const running = t.lastStatus === "queued" || t.lastStatus === "running";
      return `<tr class="${t.enabled === false ? "is-disabled" : ""} ${running ? "is-running" : ""}" data-task-row="${t.id}">
        <td class="col-check"><input type="checkbox" class="toggle" data-toggle-task="${t.id}" ${t.enabled !== false ? "checked" : ""} title="Enabled" /></td>
        <td>
          <div class="task-name">${esc(t.label || "Task")} ${groupChip}</div>
          <div class="task-sub">${esc(taskProductSubline(t))}${t.lastDropSummary && !String(taskProductSubline(t)).includes(String(t.lastDropSummary)) ? ` · ${esc(t.lastDropSummary)}` : ""}</div>
        </td>
        <td>${esc(taskStoreLabel(t))}</td>
        <td>${esc(prof?.name || prof?.email || "—")}</td>
        <td>${esc(px?.name || "Direct")}</td>
        <td>${esc(String(t.qty || 1))}×${esc(String(t.quantity || 1))}</td>
        <td><span class="badge ${badge}">${esc(statusLabel)}</span>${heldCartCountdownHtml(t)}${t.lastOrderNumber ? `<div class="task-sub">${esc(t.lastOrderNumber)}</div>` : ""}</td>
        <td class="col-actions"><div class="row-actions">
          <button type="button" class="secondary" data-edit-task="${t.id}">Edit</button>
          <button type="button" class="secondary" data-dup-task="${t.id}">Dup</button>
          ${checkoutHeldBtn}
          <button type="button" data-run-task="${t.id}">Run</button>
          <button type="button" class="danger" data-del-task="${t.id}">Del</button>
        </div></td>
      </tr>`;
    })
    .join("");
}

function periodStartMs(period) {
  const now = new Date();
  const start = new Date(now);
  if (period === "year") {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  } else if (period === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  } else if (period === "week") {
    const day = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);
  } else {
    start.setHours(0, 0, 0, 0);
  }
  return start.getTime();
}

function resultSpend(r) {
  const n = Number(r?.price ?? r?.amount ?? r?.total ?? r?.spend ?? NaN);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function resultTitle(r) {
  return (
    r?.title ||
    r?.productName ||
    r?.label ||
    r?.consumerLabel ||
    r?.orderNumber ||
    r?.taskId ||
    "Checkout"
  );
}

function homeChartBuckets(period, wins) {
  const now = new Date();
  /** @type {{ key: string, label: string, start: number, end: number }[]} */
  const buckets = [];
  if (period === "today") {
    for (let h = 0; h < 24; h++) {
      const start = new Date(now);
      start.setHours(h, 0, 0, 0);
      const end = new Date(start);
      end.setHours(h + 1, 0, 0, 0);
      buckets.push({
        key: String(h),
        label: h % 3 === 0 ? `${String(h).padStart(2, "0")}:00` : "",
        start: start.getTime(),
        end: end.getTime(),
      });
    }
  } else if (period === "week") {
    const day = (now.getDay() + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - day);
    monday.setHours(0, 0, 0, 0);
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    for (let i = 0; i < 7; i++) {
      const start = new Date(monday);
      start.setDate(monday.getDate() + i);
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      buckets.push({
        key: names[i],
        label: names[i],
        start: start.getTime(),
        end: end.getTime(),
      });
    }
  } else if (period === "month") {
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const start = new Date(now.getFullYear(), now.getMonth(), d);
      const end = new Date(now.getFullYear(), now.getMonth(), d + 1);
      buckets.push({
        key: String(d),
        label: d === 1 || d % 5 === 0 || d === days ? String(d) : "",
        start: start.getTime(),
        end: end.getTime(),
      });
    }
  } else {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (let m = 0; m < 12; m++) {
      const start = new Date(now.getFullYear(), m, 1);
      const end = new Date(now.getFullYear(), m + 1, 1);
      buckets.push({
        key: months[m],
        label: months[m],
        start: start.getTime(),
        end: end.getTime(),
      });
    }
  }
  return buckets.map((b) => {
    const rows = wins.filter((r) => {
      const ts = Number(r.at || r.createdAt || r.ts || 0);
      return ts >= b.start && ts < b.end;
    });
    const checkouts = rows.length;
    const spend = rows.reduce((sum, r) => sum + resultSpend(r), 0);
    return { ...b, checkouts, spend };
  });
}

function renderHomeChart(buckets, metric) {
  const chartEl = $("homeChart");
  const emptyEl = $("homeChartEmpty");
  if (!chartEl) return;
  const values = buckets.map((b) => (metric === "spend" ? b.spend : b.checkouts));
  const total = values.reduce((a, b) => a + b, 0);
  if (emptyEl) {
    emptyEl.hidden = total > 0;
    const p = emptyEl.querySelector("p");
    if (p) {
      p.textContent =
        metric === "spend"
          ? "No spend recorded for this period yet."
          : "You haven’t made any checkouts for this period.";
    }
  }
  if (total <= 0) {
    chartEl.innerHTML = "";
    chartEl.hidden = true;
    return;
  }
  chartEl.hidden = false;
  const w = 640;
  const h = 220;
  const padL = 36;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const maxY = Math.max(...values, 1);
  const niceMax = Math.ceil(maxY / 4) * 4 || 4;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const pts = values.map((v, i) => {
    const x = padL + (values.length <= 1 ? innerW / 2 : (i / (values.length - 1)) * innerW);
    const y = padT + innerH - (v / niceMax) * innerH;
    return { x, y, v, label: buckets[i].label };
  });
  const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const y = padT + innerH - t * innerH;
      const val = Math.round(niceMax * t);
      return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" class="home-chart-grid" />
        <text x="${padL - 8}" y="${y + 3}" text-anchor="end" class="home-chart-axis">${val}</text>`;
    })
    .join("");
  const labels = pts
    .filter((p) => p.label)
    .map(
      (p) =>
        `<text x="${p.x}" y="${h - 8}" text-anchor="middle" class="home-chart-axis">${esc(p.label)}</text>`,
    )
    .join("");
  chartEl.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="home-chart-svg" role="img" aria-label="${esc(
    metric,
  )} chart">
    ${grid}
    <polyline points="${poly}" class="home-chart-line" fill="none" />
    ${pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2.5" class="home-chart-dot" />`).join("")}
    ${labels}
  </svg>`;
}

function renderHome() {
  if (!$("homeChecklist") && !$("homeAnalytics")) return;
  const tasks = state?.tasks || [];
  const results = state?.results || [];
  const since = periodStartMs(homePeriod);
  const periodResults = results.filter((r) => {
    const ts = Number(r.at || r.createdAt || r.ts || 0);
    return !ts || ts >= since;
  });
  const winRows = periodResults.filter((r) => r.ok);
  const eng = state?.engine || {};
  const settings = state?.settings || {};
  const dismiss = homeDismissState();

  const engineLine = $("homeEngineLine");
  if (engineLine) {
    if (eng.running) {
      engineLine.textContent = eng.hyperConfigured
        ? "Engine ready · checkout keys ready"
        : "Engine ready";
    } else {
      engineLine.textContent = "Engine starting… save Settings or hit Retry if it stalls.";
    }
  }

  const hasProfile = (state?.profiles || []).length > 0;
  const proxyGroups = state?.proxyGroups || [];
  const hasProxy = proxyGroups.some((g) => (g.entries || []).length > 0);
  const hasHyper = Boolean(String(settings.hyperApiKey || "").trim()) || Boolean(eng.hyperConfigured);
  const hasCapsolver =
    Boolean(String(settings.capsolverApiKey || "").trim()) || Boolean(eng.capsolverConfigured);
  const hasKeys = hasHyper || hasCapsolver;
  const hasTask = tasks.length > 0;
  const checklistDone = [hasProfile, hasProxy, hasKeys, hasTask].filter(Boolean).length;
  const setupComplete = checklistDone >= 4 && hasTask;
  const showSetup = !dismiss.setup && !setupComplete;
  const showSuggested = !dismiss.suggested && !setupComplete;
  const showAnalytics = setupComplete || dismiss.setup;

  const suggested = $("homeSuggested");
  if (suggested) suggested.hidden = !showSuggested;
  const setupCard = $("homeSetupCard");
  if (setupCard) setupCard.hidden = !showSetup;
  const analytics = $("homeAnalytics");
  if (analytics) analytics.hidden = !showAnalytics;
  const activityWrap = $("homeActivityWrap");
  if (activityWrap) activityWrap.hidden = showAnalytics;
  if ($("homeTitle")) $("homeTitle").textContent = showAnalytics ? "Overview" : "Start here";

  const checklist = $("homeChecklist");
  if (checklist && showSetup) {
    const rows = [
      {
        id: "profile",
        done: hasProfile,
        label: "Profile saved",
        meta: hasProfile ? `${state.profiles.length}` : "Add shipping + card",
        action: "profile",
      },
      {
        id: "proxy",
        done: hasProxy,
        label: "Proxy group with entries",
        meta: hasProxy ? "ready" : "Optional for direct · needed for drops",
        action: "proxy",
      },
      {
        id: "keys",
        done: hasKeys,
        label: "Checkout keys",
        meta: hasHyper && hasCapsolver
          ? "Keys ready"
          : hasHyper
            ? "Hyper set · add captcha key for Toymate"
            : hasCapsolver
              ? "Captcha key set"
              : "Add keys in Settings",
        action: "settings",
      },
      {
        id: "task",
        done: hasTask,
        label: "At least one task",
        meta: hasTask ? `${tasks.length}` : "Create from Home or Tasks",
        action: "task",
      },
    ];
    checklist.innerHTML = rows
      .map(
        (r) => `<button type="button" class="checklist-row ${r.done ? "is-done" : ""}" data-home-check="${r.action}">
          <span class="check-mark" aria-hidden="true">${r.done ? "✓" : ""}</span>
          <span class="check-label">${esc(r.label)}</span>
          <span class="check-meta">${esc(r.meta)}</span>
        </button>`,
      )
      .join("");
  }

  const ready = $("homeReadyStrip");
  if (ready) {
    if (checklistDone >= 3 && hasTask) {
      ready.hidden = false;
      ready.textContent = "You’re set — Run enabled in the top bar, or open Tasks.";
    } else if (checklistDone >= 3) {
      ready.hidden = false;
      ready.textContent = "Almost — create a task (Quick checkout → New task).";
    } else {
      ready.hidden = true;
      ready.textContent = "";
    }
  }

  if (showAnalytics) {
    const spendTotal = winRows.reduce((sum, r) => sum + resultSpend(r), 0);
    const metricValue = homeMetric === "spend" ? spendTotal : winRows.length;
    if ($("homeMetricValue")) {
      $("homeMetricValue").textContent =
        homeMetric === "spend"
          ? `$${metricValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
          : String(metricValue);
    }
    if ($("homeMetricLabel")) {
      $("homeMetricLabel").textContent = homeMetric === "spend" ? "Spend" : "Checkouts";
    }
    document.querySelectorAll("[data-home-metric]").forEach((x) => {
      x.classList.toggle("active", x.dataset.homeMetric === homeMetric);
    });
    document.querySelectorAll("[data-home-period]").forEach((x) => {
      x.classList.toggle("active", x.dataset.homePeriod === homePeriod);
    });
    renderHomeChart(homeChartBuckets(homePeriod, winRows), homeMetric);
  }

  const act = $("homeActivity");
  if (act && !showAnalytics) {
    act.innerHTML = homeActivityLines.length
      ? homeActivityLines
          .slice(-40)
          .map((l) => `<div class="${l.cls || "muted"}">${l.html}</div>`)
          .join("")
      : `<div class="muted">Live log will appear here.</div>`;
    act.scrollTop = act.scrollHeight;
  }

  const feed = $("checkoutFeed");
  if (feed) {
    const cops = winRows.slice(0, 24);
    feed.innerHTML = cops.length
      ? cops
          .map((r) => {
            const title = resultTitle(r);
            const task = (state?.tasks || []).find((t) => t.id === r.taskId);
            const store =
              r.storeName ||
              (task ? taskStoreLabel(task).split(" · ")[0] : "") ||
              r.store ||
              "Store";
            const price = resultSpend(r);
            const when = r.at
              ? new Date(r.at).toLocaleString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  day: "2-digit",
                  month: "2-digit",
                  year: "2-digit",
                })
              : "";
            const img =
              r.imageUrl ||
              (typeof saResolveImageUrl === "function"
                ? saResolveImageUrl({
                    sku: r.sku || task?.bandaiWatchSku || task?.pdpUrl || "",
                    imageUrl: "",
                  })
                : "") ||
              "";
            return `<div class="feed-item feed-item-rich">
              <div class="feed-thumb" data-store="${esc(String(store))}">
                ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : `<span>${esc(String(store).slice(0, 2).toUpperCase())}</span>`}
              </div>
              <div class="feed-body">
                <strong>${esc(title)}</strong>
                <div class="feed-meta">
                  <span class="feed-pill">${esc(store)}</span>
                  ${price ? `<span class="feed-pill">$${esc(String(price))}</span>` : ""}
                </div>
              </div>
              <div class="feed-when">${esc(when)}</div>
            </div>`;
          })
          .join("")
      : `<div class="feed-empty">No checkouts for this period.</div>`;
  }
}

function focusDropPrep() {
  // Legacy home CTA — go-live panel removed; Smart Actions is the drop path.
  setTab("smart");
}

const PROXY_TEST_PRESET_URLS = {
  ip: "",
  bandai: "https://p-bandai.com/au/",
  toymate: "https://www.toymate.com.au/",
  pokemoncentre: "https://www.pokemoncenter.com/en-au",
};

function syncProxyTestTargetUi() {
  const preset = $("pxTestPreset")?.value || "ip";
  const custom = $("pxTestCustomUrl");
  if (custom) custom.hidden = preset !== "custom";
}

function resolveProxyTestTargetUrl() {
  const preset = $("pxTestPreset")?.value || "ip";
  if (preset === "custom") {
    return String($("pxTestCustomUrl")?.value || "").trim();
  }
  return PROXY_TEST_PRESET_URLS[preset] || "";
}

function runHomeCheckAction(action) {
  if (action === "profile") {
    setTab("profiles");
    if (!(state?.profiles || []).length) {
      $("profReset")?.click();
      if ($("profileFormTitle")) $("profileFormTitle").textContent = "New profile";
      openDialog("profileDialog");
    }
    return;
  }
  if (action === "proxy") {
    setTab("proxies");
    if (!(state?.proxyGroups || []).some((g) => (g.entries || []).length > 0)) {
      selectedProxyGroupId = null;
      $("pxReset")?.click();
    }
    return;
  }
  if (action === "settings") {
    setTab("settings");
    setSettingsPane("checkout");
    return;
  }
  if (action === "task") {
    openNewTaskModal();
  }
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
  const group =
    accountGroupFilter !== "all" && accountGroupFilter !== "ungrouped" ? accountGroupFilter : "";
  if ($("accGroup")) {
    fillNamedGroupSelect($("accGroup"), accountGroupNames([group]), {
      selected: group,
      emptyLabel: "No group",
    });
  }
  if ($("accountFormTitle")) $("accountFormTitle").textContent = "Add account";
}

function fillAccountForm(a) {
  if (!a || !$("accountForm")) return;
  $("accId").value = a.id || "";
  $("accStore").value = a.storeId || "bandai";
  if ($("accGroup")) {
    fillNamedGroupSelect($("accGroup"), accountGroupNames([a.accountGroup]), {
      selected: a.accountGroup || "",
      emptyLabel: "No group",
    });
  }
  $("accEmail").value = a.email || "";
  $("accPassword").value = a.password || "";
  $("accStatus").value = a.status || "ready";
  $("accPhone").value = a.phone || "";
  $("accNotes").value = a.notes || "";
  if ($("accountFormTitle")) $("accountFormTitle").textContent = "Edit account";
  setTab("accounts");
  openDialog("accountDialog");
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

function fillProfileProxyGroupSelect(selected) {
  const sel = $("profProxyGroup");
  if (!sel) return;
  const want = selected != null ? String(selected || "") : String(sel.value || "");
  sel.innerHTML =
    `<option value="">None</option>` +
    (state?.proxyGroups || [])
      .map(
        (g) =>
          `<option value="${esc(g.id)}">${esc(g.name)} (${g.entries?.length || 0})</option>`,
      )
      .join("");
  sel.value = want && [...sel.options].some((o) => o.value === want) ? want : "";
}

function refreshProfileGroupList() {
  const names = profileGroupNames([profileGroupFilter, $("profGroup")?.value]);
  fillNamedGroupDatalist($("profileGroupList"), names);
  fillNamedGroupSelect($("profGroup"), names, {
    selected: $("profGroup")?.value || "",
    emptyLabel: "No group",
  });
  fillProfileProxyGroupSelect();
  fillNamedGroupSelect($("profAccountGroup"), accountGroupNames([$("profAccountGroup")?.value]), {
    selected: $("profAccountGroup")?.value || "",
    emptyLabel: "None",
  });
}

function refreshAccountGroupList() {
  const names = accountGroupNames([accountGroupFilter, $("accGroup")?.value]);
  fillNamedGroupDatalist($("accountGroupList"), names);
  fillNamedGroupSelect($("accGroup"), names, {
    selected: $("accGroup")?.value || "",
    emptyLabel: "No group",
  });
}

function renderProfileGroupRail() {
  const rail = $("profileGroupRail");
  if (!rail) return;
  const profiles = state?.profiles || [];
  const counts = new Map();
  let ungrouped = 0;
  for (const p of profiles) {
    const g = String(p.profileGroup || "").trim();
    if (!g) {
      ungrouped += 1;
      continue;
    }
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const items = [
    { id: "all", name: "All", count: profiles.length },
    ...names.map((n) => ({
      id: n,
      name: n,
      count: counts.get(n) || 0,
      color: colorForGroup(n, state?.profileGroupColors),
    })),
    { id: "ungrouped", name: "Ungrouped", count: ungrouped },
  ];
  rail.innerHTML = items
    .map(
      (g) => `<button type="button" class="group-item ${
        profileGroupFilter === g.id ||
        (g.id !== "all" &&
          g.id !== "ungrouped" &&
          groupKey(profileGroupFilter) === groupKey(g.id))
          ? "active"
          : ""
      }" data-profile-group-filter="${esc(g.id)}">
      <span class="name">${g.color ? `<span class="group-dot" style="background:${esc(g.color)}"></span>` : ""}${esc(g.name)}</span>
      <span class="count">${g.count}</span>
    </button>`,
    )
    .join("");
}

function renderAccountGroupRail() {
  const rail = $("accountGroupRail");
  if (!rail) return;
  const accounts = state?.accounts || [];
  const counts = new Map();
  let ungrouped = 0;
  for (const a of accounts) {
    const g = String(a.accountGroup || "").trim();
    if (!g) {
      ungrouped += 1;
      continue;
    }
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const items = [
    { id: "all", name: "All", count: accounts.length },
    ...names.map((n) => ({
      id: n,
      name: n,
      count: counts.get(n) || 0,
      color: colorForGroup(n, state?.accountGroupColors),
    })),
    { id: "ungrouped", name: "Ungrouped", count: ungrouped },
  ];
  rail.innerHTML = items
    .map(
      (g) => `<button type="button" class="group-item ${
        accountGroupFilter === g.id ||
        (g.id !== "all" &&
          g.id !== "ungrouped" &&
          groupKey(accountGroupFilter) === groupKey(g.id))
          ? "active"
          : ""
      }" data-account-group-filter="${esc(g.id)}">
      <span class="name">${g.color ? `<span class="group-dot" style="background:${esc(g.color)}"></span>` : ""}${esc(g.name)}</span>
      <span class="count">${g.count}</span>
    </button>`,
    )
    .join("");
}

function filteredProfiles() {
  let profiles = state?.profiles || [];
  if (profileGroupFilter === "ungrouped") {
    profiles = profiles.filter((p) => !String(p.profileGroup || "").trim());
  } else if (profileGroupFilter !== "all") {
    const key = groupKey(profileGroupFilter);
    profiles = profiles.filter((p) => groupKey(p.profileGroup) === key);
  }
  const q = searchQuery("profileSearch");
  if (!q) return profiles;
  return profiles.filter((p) => {
    const hay = [
      p.name,
      p.profileGroup,
      p.email,
      p.first_name,
      p.last_name,
      p.phone,
      p.city,
      p.province,
      p.zip,
      p.address1,
      String(p.card_number || "").slice(-4),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

function filteredAccounts() {
  const filter = $("accStoreFilter")?.value || "";
  let rows = state.accounts || [];
  if (filter) rows = rows.filter((a) => (a.storeId || "") === filter);
  if (accountGroupFilter === "ungrouped") {
    rows = rows.filter((a) => !String(a.accountGroup || "").trim());
  } else if (accountGroupFilter !== "all") {
    const key = groupKey(accountGroupFilter);
    rows = rows.filter((a) => groupKey(a.accountGroup) === key);
  }
  const q = searchQuery("accountSearch");
  if (!q) return rows;
  return rows.filter((a) => {
    const hay = [a.email, a.accountGroup, a.storeId, a.storeName, a.status, a.notes, a.phone]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

function renderAccounts() {
  refreshAccountGroupList();
  renderAccountGroupRail();
  const el = $("accountList");
  if (!el) return;
  const rows = filteredAccounts();
  if (!rows.length) {
    const searching = Boolean(searchQuery("accountSearch"));
    el.innerHTML = `<tr><td colspan="6" class="empty-cell">${
      searching
        ? "No accounts match this search."
        : "No accounts yet — Add, Import, or run Account gen."
    }</td></tr>`;
    return;
  }
  el.innerHTML = rows
    .map((a) => {
      const st = a.status || "unknown";
      const badge = accountStatusBadge(st);
      const groupName = String(a.accountGroup || "").trim();
      const groupChip = groupName
        ? `<span class="group-chip" style="--g:${esc(colorForGroup(groupName, state?.accountGroupColors))}">${esc(groupName)}</span>`
        : "—";
      return `<tr>
        <td><span class="badge ok">${esc(a.storeName || a.storeId || "store")}</span></td>
        <td>${groupChip}</td>
        <td>
          <div class="task-name">${esc(a.email)}</div>
          <div class="task-sub">••••••••</div>
        </td>
        <td><span class="badge ${badge}">${esc(st)}</span></td>
        <td class="task-sub">${esc(a.notes || "—")}</td>
        <td class="col-actions"><div class="row-actions">
          <button type="button" class="secondary" data-edit-acc="${esc(a.id)}">Edit</button>
          <button type="button" class="secondary" data-copy-acc-email="${esc(a.id)}">Email</button>
          <button type="button" class="secondary" data-copy-acc-pass="${esc(a.id)}">Pass</button>
          <button type="button" class="danger" data-del-acc="${esc(a.id)}">Del</button>
        </div></td>
      </tr>`;
    })
    .join("");
}

function renderProfiles() {
  refreshProfileGroupList();
  renderProfileGroupRail();
  const el = $("profileList");
  if (!el) return;
  const rows = filteredProfiles();
  if (!rows.length) {
    const searching = Boolean(searchQuery("profileSearch"));
    el.innerHTML = `<tr><td colspan="6" class="empty-cell">${
      searching
        ? "No profiles match this search."
        : "No profiles yet — add one from Home checklist or New profile."
    }</td></tr>`;
    return;
  }
  el.innerHTML = rows
    .map((p) => {
      const groupName = String(p.profileGroup || "").trim();
      const groupChip = groupName
        ? `<span class="group-chip" style="--g:${esc(colorForGroup(groupName, state?.profileGroupColors))}">${esc(groupName)}</span>`
        : "—";
      const loc = [p.city, p.province, p.zip].filter(Boolean).join(" ") || "—";
      return `<tr>
      <td><div class="task-name">${esc(p.name || "Profile")}</div></td>
      <td>${groupChip}</td>
      <td title="${esc(p.email || "")}">${esc(p.email || "—")}</td>
      <td title="${esc(loc)}">${esc(loc)}</td>
      <td>•••• ${esc(String(p.card_number || "").slice(-4) || "????")}</td>
      <td class="col-actions"><div class="row-actions">
        <button type="button" class="secondary" data-edit-prof="${p.id}">Edit</button>
        <button type="button" class="secondary" data-dup-prof="${p.id}">Dup</button>
        <button type="button" class="danger" data-del-prof="${p.id}">Del</button>
      </div></td>
    </tr>`;
    })
    .join("");
}

function pingChipClass(ms) {
  if (ms == null) return "";
  if (ms < 200) return "fast";
  if (ms < 500) return "ok";
  if (ms < 1200) return "mid";
  return "slow";
}

/** Split a proxy line into host / port / user for the table. */
function parseProxyParts(raw) {
  const s = String(raw || "").trim();
  if (!s) return { host: "—", port: "—", user: "—" };
  try {
    if (s.includes("@")) {
      const u = new URL(s.includes("://") ? s : `http://${s}`);
      return {
        host: u.hostname || "—",
        port: u.port || "—",
        user: u.username ? decodeURIComponent(u.username) : "—",
      };
    }
  } catch {
    /* fall through */
  }
  const parts = s.split(":");
  if (parts.length >= 4) {
    return { host: parts[0] || "—", port: parts[1] || "—", user: parts[2] || "—" };
  }
  if (parts.length >= 2) {
    return { host: parts[0] || "—", port: parts[1] || "—", user: "—" };
  }
  return { host: s, port: "—", user: "—" };
}

function closePxMoreMenu() {
  const menu = $("pxMoreMenu");
  const btn = $("pxMoreBtn");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function renderProxyGroupRail() {
  const rail = $("proxyGroupRail");
  if (!rail) return;
  const rows = state?.proxyGroups || [];
  if (!selectedProxyGroupId && rows[0]) selectedProxyGroupId = rows[0].id;
  if (selectedProxyGroupId && !rows.some((g) => g.id === selectedProxyGroupId)) {
    selectedProxyGroupId = rows[0]?.id || null;
  }
  rail.innerHTML = rows.length
    ? rows
        .map((g) => {
          const test = proxyTestResults[g.id];
          const meta = test?.alive != null ? `${test.alive}/${test.total}` : `${g.entries?.length || 0}`;
          return `<button type="button" class="group-item ${selectedProxyGroupId === g.id ? "active" : ""}" data-proxy-select="${g.id}">
            <span class="name">${esc(g.name)}</span>
            <span class="count">${esc(meta)}</span>
          </button>`;
        })
        .join("")
    : `<div class="feed-empty" style="padding:8px">No groups</div>`;
}

function fillProxyEditor(g) {
  if (!$("pxId")) return;
  if (!g) {
    $("pxId").value = "";
    if ($("pxName")) $("pxName").value = "";
    if ($("pxEntries")) $("pxEntries").value = "";
    if ($("proxyEditorTitle")) $("proxyEditorTitle").textContent = "Proxy group";
    if ($("proxyGroupMeta")) $("proxyGroupMeta").textContent = "Select or create a group";
    renderProxyEntryList(null);
    return;
  }
  $("pxId").value = g.id;
  if ($("pxName")) $("pxName").value = g.name || "";
  if ($("pxEntries")) $("pxEntries").value = (g.entries || []).join("\n");
  if ($("proxyEditorTitle")) $("proxyEditorTitle").textContent = g.name || "Proxy group";
  renderProxyEntryList(g);
}

function renderProxyEntryList(g) {
  const el = $("proxyEntryList");
  if (!el) return;
  if (!g) {
    el.innerHTML = `<tr><td colspan="5" class="empty-cell">Select a group on the left, or New group.</td></tr>`;
    if ($("proxyGroupMeta")) $("proxyGroupMeta").textContent = "Select or create a group";
    return;
  }
  const test = proxyTestResults[g.id];
  let entries = [...(g.entries || [])];
  const byEntry = new Map((test?.results || []).map((r) => [r.entry, r]));
  if (proxySortMode === "speed") {
    entries.sort((a, b) => {
      const ra = byEntry.get(a);
      const rb = byEntry.get(b);
      const ma = ra?.ok ? ra.ms : 1e9;
      const mb = rb?.ok ? rb.ms : 1e9;
      return ma - mb;
    });
  } else if (proxySortMode === "failed") {
    entries.sort((a, b) => {
      const ra = byEntry.get(a);
      const rb = byEntry.get(b);
      return Number(!!ra?.ok) - Number(!!rb?.ok);
    });
  }
  const totalN = entries.length;
  const q = searchQuery("proxySearch");
  if (q) {
    entries = entries.filter((entry) => {
      const parts = parseProxyParts(entry);
      const r = byEntry.get(entry);
      const hay = [entry, parts.host, parts.port, parts.user, r?.ip, r?.error]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }
  const n = totalN;
  if ($("proxyGroupMeta")) {
    if (test?.alive != null) {
      $("proxyGroupMeta").textContent = `${n} prox${n === 1 ? "y" : "ies"} · ${test.alive}/${test.total} alive`;
    } else {
      $("proxyGroupMeta").textContent = `${n} prox${n === 1 ? "y" : "ies"} loaded`;
    }
  }
  if ($("pxTestHint")) {
    const targetBit = test?.target ? ` · ${test.target.replace(/^https?:\/\//, "").slice(0, 36)}` : "";
    if (test?.error && !test.results) $("pxTestHint").textContent = test.error;
    else if (test)
      $("pxTestHint").textContent = `${test.alive}/${test.total} alive · dead ${test.dead}${targetBit}`;
    else $("pxTestHint").textContent = n ? "Ready to test" : "Add proxies first";
  }
  if (!entries.length) {
    el.innerHTML = `<tr><td colspan="5" class="empty-cell">${
      q ? "No proxies match this search." : "No proxies in this group — Add proxies."
    }</td></tr>`;
    return;
  }
  el.innerHTML = entries
        .map((entry) => {
          const parts = parseProxyParts(entry);
          const r = byEntry.get(entry);
          let status = `<span class="proxy-status-pill">None</span>`;
          if (r?.ok) {
            const detail = r.ip || (r.status != null ? `HTTP ${r.status}` : "ok");
            status = `<span class="proxy-status-pill is-ok">${esc(String(detail))} · <span class="ping-chip ${pingChipClass(r.ms)}">${r.ms}ms</span></span>`;
          } else if (r) {
            status = `<span class="proxy-status-pill is-dead" title="${esc(r.error || "dead")}">${esc(
              (r.error || "dead").slice(0, 28),
            )}</span>`;
          }
          return `<tr data-proxy-entry="${esc(entry)}" title="${esc(entry)}">
            <td class="proxy-host">${esc(parts.host)}</td>
            <td class="proxy-port">${esc(parts.port)}</td>
            <td class="proxy-user">${esc(parts.user)}</td>
            <td>${status}</td>
            <td class="col-actions"><div class="row-actions">
              <button type="button" class="secondary" data-test-proxy-entry="${esc(entry)}" title="Test this proxy">Test</button>
              <button type="button" class="danger" data-del-proxy-entry="${esc(entry)}" title="Remove">Del</button>
            </div></td>
          </tr>`;
        })
        .join("");
}

function renderProxies() {
  renderProxyGroupRail();
  const g = (state?.proxyGroups || []).find((x) => x.id === selectedProxyGroupId) || null;
  const formActive = $("proxyForm")?.contains(document.activeElement);
  if (formActive && ($("pxId")?.value || "") === (g?.id || "")) {
    renderProxyEntryList({
      id: g?.id,
      entries: String($("pxEntries")?.value || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    });
  } else if (g) {
    fillProxyEditor(g);
  } else if (!selectedProxyGroupId) {
    fillProxyEditor(null);
  }
  const el = $("proxyList");
  if (el) el.innerHTML = "";
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

function syncDiscordEmbedFieldToggles(fields) {
  const root = $("discordFieldToggles");
  if (!root) return;
  const f = fields && typeof fields === "object" ? fields : {};
  for (const input of root.querySelectorAll("input[data-embed-field]")) {
    const key = input.getAttribute("data-embed-field");
    input.checked = f[key] !== false;
  }
}

function readDiscordEmbedFieldsFromForm() {
  const root = $("discordFieldToggles");
  const out = {};
  if (!root) return out;
  for (const input of root.querySelectorAll("input[data-embed-field]")) {
    const key = input.getAttribute("data-embed-field");
    if (key) out[key] = Boolean(input.checked);
  }
  return out;
}

function renderSettings() {
  const s = state.settings || {};
  $("setApiKey").value = s.apiKey || "";
  // controlPlane / Paydock / monitor URL+token stay baked-in — never fill into the DOM.
  $("setHyper").value = s.hyperApiKey || "";
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
  const successHook =
    s.discordSuccessWebhook || s.discordCheckoutWebhook || s.discordWebhookUrl || "";
  if ($("setDiscordSuccess")) $("setDiscordSuccess").value = successHook;
  if ($("setDiscordFail")) $("setDiscordFail").value = s.discordFailWebhook || "";
  if ($("setDiscord3ds")) $("setDiscord3ds").value = s.discord3dsWebhook || "";
  if ($("setDiscordMonitor")) $("setDiscordMonitor").value = s.discordMonitorWebhook || "";
  syncDiscordEmbedFieldToggles(s.discordEmbedFields);
  if ($("setSuccessAlert")) $("setSuccessAlert").checked = s.successAlertEnabled !== false;
  if ($("setDetailedLogs")) $("setDetailedLogs").checked = s.detailedLogs !== false;
  // Legacy single field if still present in DOM
  if ($("setDiscordWebhook")) $("setDiscordWebhook").value = successHook;
  fillQuickTaskPresetSelects();
  const qt = s.quickTaskPreset || {};
  if ($("qtPresetStore")) {
    $("qtPresetStore").value = bandaiStoreSelectValue({
      store: qt.store || "bandai",
      bandaiArea: qt.bandaiArea,
    });
  }
  if ($("qtPresetMode")) $("qtPresetMode").value = qt.bandaiMode || "checkout";
  if ($("qtPresetPay")) {
    const pm = String(qt.paymentMethod || "credit_card").toLowerCase();
    $("qtPresetPay").value = /^paypal_manual|paypal_guest/i.test(pm)
      ? "paypal_manual"
      : /^paypal/i.test(pm)
        ? "paypal_auto"
        : "credit_card";
  }
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
  const parsed = parseBandaiStoreSelection($("qtPresetStore")?.value || "bandai-au");
  return {
    store: parsed.store || "bandai",
    bandaiArea: parsed.bandaiArea || "au",
    bandaiMode: $("qtPresetMode")?.value || "checkout",
    bandaiCheckoutMode: "fast",
    paymentMethod: $("qtPresetPay")?.value || "credit_card",
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
    if (harvestState.busy) status.textContent = "Working… solving captcha";
    else if (harvestState.running)
      status.textContent = `Running · keeping ${cfg.desired ?? 0} ready`;
    else status.textContent = "Stopped";
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
      list.innerHTML = `<div class="item"><div><strong>Nothing ready</strong><div class="meta">Hit Start, or One now.</div></div></div>`;
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
    if (hv.running && hv.busy) line.textContent = "Harvesting… preparing session";
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
      list.innerHTML = `<div class="item"><div><strong>Bank empty</strong><div class="meta">Start harvest or click Harvest one now.</div></div></div>`;
    } else {
      list.innerHTML = rows
        .map(
          (s) => `<div class="item">
          <div>
            <strong>${esc(s.proxyHost || "proxy")}</strong>
            <div class="meta">TTL ${s.abckTtlSec ?? "?"}s · age ${s.ageSec ?? "?"}s${
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
    formatHarvestBankChip("Bandai", banks.bandai || banks.bandaiHarvest),
    formatHarvestBankChip("Toymate", banks.toymate || banks.harvest),
  ];
  return {
    chips,
    text: chips.map((c) => c.text).join("  ·  "),
  };
}

function tasksNeedHarvestStrip() {
  const tasks = state?.tasks || [];
  const hasStoreTask = tasks.some(
    (t) => t && (t.store === "bandai" || t.store === "toymate") && t.enabled !== false,
  );
  const bh = state?.bandaiHarvest || {};
  const th = state?.harvest || {};
  const bankActive =
    Boolean(bh.running) ||
    Boolean(th.running) ||
    Number(bh.ready || 0) > 0 ||
    Number(th.ready || 0) > 0;
  return hasStoreTask || bankActive;
}

function renderHarvestBankStrip() {
  const el = $("harvestBankStrip");
  if (!el) return;
  if (!tasksNeedHarvestStrip()) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  const { chips, text } = formatHarvestBankStrip({
    bandai: state?.bandaiHarvest,
    toymate: state?.harvest,
  });
  el.innerHTML = (chips || [])
    .map((c) => `<span class="chip-${esc(c.state)}">${esc(c.text)}</span>`)
    .join(` <span class="chip-off">·</span> `);
  if (!chips?.length) el.textContent = text || "";
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
  renderHome();
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
    if (hv.running && hv.busy) line.textContent = "Warming a session…";
    else if (hv.running) line.textContent = `Armed · ${hv.ready ?? 0} ready`;
    else line.textContent = "Stopped";
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
    list.innerHTML = `<div class="empty muted">Nothing ready yet — hit Start a few minutes before the drop.</div>`;
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
  if (log) {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.innerHTML = html;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }
  homeActivityLines.push({ html, cls: cls || "muted" });
  if (homeActivityLines.length > 80) homeActivityLines.splice(0, homeActivityLines.length - 80);
  const act = $("homeActivity");
  if (act && document.getElementById("tab-home")?.classList.contains("active")) {
    renderHome();
  }
}

async function refresh() {
  applyState(await window.desktop.getState());
}

function fillTaskForm(task) {
  if (!task || !$("taskForm")) return;
  $("taskId").value = task.id || "";
  $("taskFormTitle").textContent = task.id ? "Edit task" : "New task";
  $("taskLabel").value = task.label || "";
  if ($("taskGroup")) {
    fillNamedGroupSelect($("taskGroup"), taskGroupNames([task.taskGroup]), {
      selected: task.taskGroup || "",
      emptyLabel: "No group",
    });
  }
  $("taskStore").value = bandaiStoreSelectValue(task);
  if ($("taskToymateMode")) $("taskToymateMode").value = task.toymateMode || "checkout";
  if ($("taskToymatePay")) $("taskToymatePay").value = task.paymentMethod || "credit_card";
  if ($("taskBandaiPay")) {
    const pm = String(task.paymentMethod || "credit_card").toLowerCase();
    $("taskBandaiPay").value = /^paypal_manual|paypal_guest/i.test(pm)
      ? "paypal_manual"
      : /^paypal/i.test(pm)
        ? "paypal_auto"
        : "credit_card";
  }
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
  if ($("taskBandaiCheckoutWatchSku"))
    $("taskBandaiCheckoutWatchSku").value = task.bandaiWatchSku || "";
  if ($("taskBandaiCheckoutWatchKeywords"))
    $("taskBandaiCheckoutWatchKeywords").value = task.bandaiWatchKeywords || "";
  if ($("taskBandaiWatchdog")) $("taskBandaiWatchdog").checked = task.bandaiWatchdog !== false;
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
  // Legacy chance/campaignSn ignored — raffle mode removed.
  $("taskPdp").value = task.pdpUrl || "";
  $("taskQty").value = task.qty || 1;
  $("taskQuantity").value = task.quantity || 1;
  if ($("taskProfileSource")) $("taskProfileSource").value = "single";
  $("taskProfile").value = task.profileId || "";
  $("taskProxy").value = task.proxyGroupId || "";
  $("taskPlaceOrder").checked = task.placeOrder !== false;
  syncTaskFormForStore();
  syncTaskProfileSourceUi();
  if ($("taskAccountId") && task.accountId && task.store === "toymate") {
    fillVaultAccountSelect("toymate", "taskAccountId");
    $("taskAccountId").value = task.accountId;
  }
  if ($("taskBandaiAccountId") && task.accountId && task.store === "bandai") {
    fillVaultAccountSelect("bandai", "taskBandaiAccountId");
    $("taskBandaiAccountId").value = task.accountId;
  }
}

function openNewTaskModal(prefillGroup) {
  $("taskReset")?.click();
  const group =
    prefillGroup ||
    (taskGroupFilter !== "all" && taskGroupFilter !== "ungrouped" ? taskGroupFilter : "");
  refreshTaskGroupList();
  if ($("taskGroup")) {
    fillNamedGroupSelect($("taskGroup"), taskGroupNames([group]), {
      selected: group || "",
      emptyLabel: "No group",
    });
  }
  $("taskFormTitle").textContent = "New task";
  setTab("tasks");
  openDialog("taskDialog");
}

function hideTaskContextMenu() {
  const menu = $("taskContextMenu");
  if (menu) menu.hidden = true;
}

function showTaskContextMenu(taskId, x, y) {
  const menu = $("taskContextMenu");
  const task = (state?.tasks || []).find((t) => t.id === taskId);
  if (!menu || !task) return;
  hideStoreGroupContextMenu();
  const groups = [
    ...new Set(
      (state.tasks || [])
        .map((t) => String(t.taskGroup || "").trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
  menu.innerHTML = `
    <button type="button" class="ctx-item" data-ctx="edit">Edit</button>
    <button type="button" class="ctx-item" data-ctx="dup">Duplicate</button>
    <button type="button" class="ctx-item" data-ctx="run">Start</button>
    <button type="button" class="ctx-item" data-ctx="stop">Stop</button>
    <div class="ctx-sep"></div>
    <div class="ctx-label">Move to group</div>
    <div class="ctx-submenu">
      <button type="button" class="ctx-item" data-ctx-group="">Ungrouped</button>
      ${groups.map((g) => `<button type="button" class="ctx-item" data-ctx-group="${esc(g)}">${esc(g)}</button>`).join("")}
    </div>
    <div class="ctx-sep"></div>
    <button type="button" class="ctx-item danger" data-ctx="del">Delete</button>
  `;
  menu.hidden = false;
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 240)}px`;
  menu.dataset.taskId = taskId;
}

// Tabs list delegation
document.body.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.dataset.taskGroupFilter != null) {
    taskGroupFilter = t.dataset.taskGroupFilter || "all";
    if (taskGroupFilter !== "all" && taskGroupFilter !== "ungrouped") {
      if ($("massTaskGroup")) $("massTaskGroup").value = taskGroupFilter;
    }
    renderTasks();
    return;
  }
  if (t.dataset.profileGroupFilter != null) {
    profileGroupFilter = t.dataset.profileGroupFilter || "all";
    renderProfiles();
    return;
  }
  if (t.dataset.accountGroupFilter != null) {
    accountGroupFilter = t.dataset.accountGroupFilter || "all";
    renderAccounts();
    return;
  }
  if (t.dataset.proxySelect) {
    selectedProxyGroupId = t.dataset.proxySelect;
    proxySortMode = null;
    renderProxies();
    return;
  }
  if (t.dataset.toggleTask) {
    const task = state.tasks.find((x) => x.id === t.dataset.toggleTask);
    if (!task) return;
    const on = t instanceof HTMLInputElement ? t.checked : task.enabled === false;
    applyState(await window.desktop.upsertTask({ ...task, enabled: on }));
    toast(on ? "Task enabled" : "Task disabled", "muted");
    return;
  }
  const delProxyBtn =
    t.closest?.("[data-del-proxy-entry]") || (t.dataset.delProxyEntry ? t : null);
  if (delProxyBtn) {
    const entry = delProxyBtn.getAttribute("data-del-proxy-entry");
    const parts = parseProxyParts(entry);
    if (!confirmDelete(`proxy ${parts.host}:${parts.port}`)) return;
    const lines = String($("pxEntries")?.value || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l !== entry);
    await rewriteProxyEntries(lines);
    return;
  }
  const testProxyBtn =
    t.closest?.("[data-test-proxy-entry]") || (t.dataset.testProxyEntry ? t : null);
  if (testProxyBtn) {
    const entry = testProxyBtn.getAttribute("data-test-proxy-entry");
    const targetUrl = resolveProxyTestTargetUrl();
    appendLog(`Testing 1 proxy…`, "muted");
    const res = await window.desktop.testProxyEntries(entry, {
      concurrency: 1,
      targetUrl: targetUrl || undefined,
    });
    const id = $("pxId")?.value || selectedProxyGroupId;
    if (id) {
      const prev = proxyTestResults[id] || { results: [], alive: 0, dead: 0, total: 0 };
      const by = new Map((prev.results || []).map((r) => [r.entry, r]));
      for (const r of res.results || []) by.set(r.entry, r);
      const results = [...by.values()];
      proxyTestResults[id] = {
        ...prev,
        ok: true,
        results,
        alive: results.filter((r) => r.ok).length,
        dead: results.filter((r) => !r.ok).length,
        total: results.length,
        target: res.target || prev.target,
      };
    }
    toast(res.results?.[0]?.ok ? `Alive · ${res.results[0].ms}ms` : "Dead", res.results?.[0]?.ok ? "ok" : "err");
    renderProxies();
    return;
  }
  if (t.dataset.settingsSave != null) {
    await $("btnSaveSettings")?.onclick?.();
    return;
  }
  if (t.dataset.exportMirror) {
    $(t.dataset.exportMirror)?.click();
    return;
  }
  if (t.dataset.importMirror) {
    $(t.dataset.importMirror)?.click();
    return;
  }
  if (t.dataset.editTask) {
    const task = state.tasks.find((x) => x.id === t.dataset.editTask);
    if (!task) return;
    fillTaskForm(task);
    setTab("tasks");
    openDialog("taskDialog");
    return;
  }
  if (t.dataset.editAcc) {
    const acc = (state.accounts || []).find((a) => a.id === t.dataset.editAcc);
    if (acc) fillAccountForm(acc);
  }
  if (t.dataset.delAcc) {
    const acc = (state.accounts || []).find((a) => a.id === t.dataset.delAcc);
    if (!confirmDelete(`account “${acc?.email || "account"}”`)) return;
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
    const task = (state.tasks || []).find((x) => x.id === t.dataset.delTask);
    if (!confirmDelete(`task “${task?.label || "Task"}”`)) return;
    applyState(await window.desktop.deleteTask(t.dataset.delTask));
  }
  if (t.dataset.dupTask) {
    const res = await window.desktop.duplicateTask(t.dataset.dupTask);
    if (!res.ok) appendLog(esc(res.error || "dup failed"), "err");
    else {
      appendLog(`Duplicated task → ${esc(res.task?.label || "")}`, "ok");
      if (res.snapshot) applyState(res.snapshot);
    }
  }
  if (t.dataset.runTask) {
    const res = await window.desktop.runTasks([t.dataset.runTask]);
    if (!res.ok) appendLog(esc(res.error), "err");
    else appendLog(`Enqueued ${res.enqueued} job(s)`, "ok");
    if (res.snapshot) applyState(res.snapshot);
  }
  if (t.dataset.checkoutHeld || t.dataset.retryPay) {
    const id = t.dataset.checkoutHeld || t.dataset.retryPay;
    const res = await window.desktop.runTasks([id], { payFromCart: true });
    if (!res.ok) appendLog(esc(res.error), "err");
    else appendLog(`Checkout now enqueued (${res.enqueued}) — live cart verify`, "ok");
    if (res.snapshot) applyState(res.snapshot);
  }
  if (t.dataset.editProf) {
    const p = state.profiles.find((x) => x.id === t.dataset.editProf);
    if (!p) return;
    $("profId").value = p.id;
    $("profName").value = p.name || "";
    if ($("profGroup")) {
      fillNamedGroupSelect($("profGroup"), profileGroupNames([p.profileGroup]), {
        selected: p.profileGroup || "",
        emptyLabel: "No group",
      });
    }
    fillProfileProxyGroupSelect(p.proxyGroupId || "");
    if ($("profAccountGroup")) {
      fillNamedGroupSelect($("profAccountGroup"), accountGroupNames([p.accountGroup]), {
        selected: p.accountGroup || "",
        emptyLabel: "None",
      });
    }
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
    if ($("profPaypalEmail")) $("profPaypalEmail").value = p.paypal_email || p.paypalEmail || "";
    if ($("profPaypalPassword"))
      $("profPaypalPassword").value = p.paypal_password || p.paypalPassword || "";
    if ($("profileFormTitle")) $("profileFormTitle").textContent = "Edit profile";
    setTab("profiles");
    openDialog("profileDialog");
  }
  if (t.dataset.delProf) {
    const p = (state.profiles || []).find((x) => x.id === t.dataset.delProf);
    if (!confirmDelete(`profile “${p?.name || "Profile"}”`)) return;
    applyState(await window.desktop.deleteProfile(t.dataset.delProf));
  }
  if (t.dataset.dupProf) {
    const res = await window.desktop.duplicateProfile(t.dataset.dupProf);
    if (!res.ok) appendLog(esc(res.error || "dup failed"), "err");
    else {
      appendLog(`Duplicated profile → ${esc(res.profile?.name || "")}`, "ok");
      if (res.snapshot) applyState(res.snapshot);
    }
  }
  if (t.dataset.testPx) {
    const id = t.dataset.testPx;
    const targetUrl = resolveProxyTestTargetUrl();
    if (($("pxTestPreset")?.value || "") === "custom" && !targetUrl) {
      toast("Enter a custom test URL", "err");
      return;
    }
    appendLog(`Testing proxy group…`, "muted");
    const res = await window.desktop.testProxyGroup(id, {
      removeDead: Boolean($("pxRemoveDead")?.checked),
      concurrency: 20,
      targetUrl: targetUrl || undefined,
    });
    if (!res.ok && res.error && !res.results) {
      proxyTestResults[id] = { error: res.error };
      appendLog(esc(res.error), "err");
    } else {
      proxyTestResults[id] = res;
      appendLog(
        `Proxy test · ${res.alive}/${res.total} alive${res.removed ? ` · removed ${res.removed} dead` : ""}`,
        res.dead ? "err" : "ok",
      );
      if (res.snapshot) applyState(res.snapshot);
    }
    renderProxies();
  }
  if (t.dataset.editPx) {
    const g = state.proxyGroups.find((x) => x.id === t.dataset.editPx);
    if (!g) return;
    selectedProxyGroupId = g.id;
    setTab("proxies");
    renderProxies();
  }
  if (t.dataset.ctx) {
    const id = $("taskContextMenu")?.dataset.taskId;
    const task = (state.tasks || []).find((x) => x.id === id);
    hideTaskContextMenu();
    if (!task) return;
    if (t.dataset.ctx === "edit") {
      fillTaskForm(task);
      setTab("tasks");
      openDialog("taskDialog");
    } else if (t.dataset.ctx === "dup") {
      const res = await window.desktop.duplicateTask(task.id);
      if (res.snapshot) applyState(res.snapshot);
      toast(res.ok ? "Duplicated" : res.error || "Dup failed", res.ok ? "ok" : "err");
    } else if (t.dataset.ctx === "run") {
      const res = await window.desktop.runTasks([task.id]);
      toast(res.ok ? `Started (${res.enqueued})` : res.error || "Start failed", res.ok ? "ok" : "err");
      if (res.snapshot) applyState(res.snapshot);
    } else if (t.dataset.ctx === "stop") {
      applyState(await window.desktop.upsertTask({ ...task, enabled: false }));
      toast("Task stopped (disabled)", "muted");
    } else if (t.dataset.ctx === "del") {
      if (!confirmDelete(`task “${task.label || "Task"}”`)) return;
      applyState(await window.desktop.deleteTask(task.id));
      toast("Task deleted", "muted");
    }
    return;
  }
  if (t.dataset.ctxGroup != null) {
    const id = $("taskContextMenu")?.dataset.taskId;
    const task = (state.tasks || []).find((x) => x.id === id);
    hideTaskContextMenu();
    if (!task) return;
    applyState(await window.desktop.upsertTask({ ...task, taskGroup: t.dataset.ctxGroup || "" }));
    toast(t.dataset.ctxGroup ? `Moved to ${t.dataset.ctxGroup}` : "Ungrouped", "ok");
    return;
  }
  if (t.dataset.sgCtx) {
    const id = $("storeGroupContextMenu")?.dataset.groupId;
    const group = (state?.storeGroups || []).find((g) => g.id === id);
    hideStoreGroupContextMenu();
    if (!group) return;
    if (t.dataset.sgCtx === "edit") {
      openStoreGroupDialog(group);
    } else if (t.dataset.sgCtx === "clone") {
      const res = await window.desktop.storeGroupClone(group.id);
      if (res.snapshot) applyState(res.snapshot);
      toast(res.ok ? "Store group cloned" : res.error || "Clone failed", res.ok ? "ok" : "err");
    } else if (t.dataset.sgCtx === "del") {
      if (!window.confirm(`Delete store group “${group.name}”?`)) return;
      const res = await window.desktop.storeGroupDelete(group.id);
      if (res.snapshot) applyState(res.snapshot);
      toast("Store group deleted", "muted");
    }
    return;
  }
  if (t.dataset.delPx) {
    const g = (state.proxyGroups || []).find((x) => x.id === t.dataset.delPx);
    if (!confirmDelete(`proxy group “${g?.name || "group"}”`)) return;
    applyState(await window.desktop.deleteProxyGroup(t.dataset.delPx));
  }
});

function readTaskForm() {
  const storeRaw = $("taskStore").value;
  const parsed = parseBandaiStoreSelection(storeRaw);
  const store = parsed.store;
  const bandai = store === "bandai";
  const accountAssign =
    store === "toymate"
      ? $("taskAccountAssign")?.value || "auto"
      : bandai
        ? $("taskBandaiAccountAssign")?.value || "auto"
        : undefined;
  let pdpUrl = $("taskPdp").value;
  if (bandai) pdpUrl = rewriteBandaiPdpArea(pdpUrl, parsed.bandaiArea);
  return {
    id: $("taskId").value || undefined,
    label: $("taskLabel").value,
    taskGroup: $("taskGroup")?.value?.trim() || "",
    store,
    bandaiArea: bandai ? parsed.bandaiArea || "au" : undefined,
    pdpUrl,
    qty: Number($("taskQty").value),
    quantity: Number($("taskQuantity").value),
    profileId: $("taskProfile").value || null,
    proxyGroupId: $("taskProxy").value || null,
    placeOrder: $("taskPlaceOrder").checked,
    toymateMode: store === "toymate" ? $("taskToymateMode")?.value || "checkout" : undefined,
    bandaiMode: bandai ? $("taskBandaiMode")?.value || "checkout" : undefined,
    disneyMode: store === "disney" ? $("taskDisneyMode")?.value || "pay" : undefined,
    bandaiCheckoutMode: bandai ? $("taskBandaiCheckoutMode")?.value || "fast" : undefined,
    bandaiMonitorMode:
      bandai && $("taskBandaiMode")?.value === "monitor"
        ? $("taskBandaiMonitorMode")?.value || "local"
        : undefined,
    bandaiWatchSku:
      bandai
        ? ["checkout", "atc"].includes($("taskBandaiMode")?.value || "")
          ? $("taskBandaiCheckoutWatchSku")?.value?.trim() || ""
          : $("taskBandaiWatchSku")?.value?.trim() || ""
        : undefined,
    bandaiWatchKeywords:
      bandai
        ? ["checkout", "atc"].includes($("taskBandaiMode")?.value || "")
          ? $("taskBandaiCheckoutWatchKeywords")?.value?.trim() || ""
          : $("taskBandaiWatchKeywords")?.value?.trim() || ""
        : undefined,
    bandaiMonitorIntervalMs: bandai
      ? Number($("taskBandaiMonitorIntervalMs")?.value) || 10000
      : undefined,
    bandaiMonitorDelayMs: bandai
      ? Number($("taskBandaiMonitorDelayMs")?.value) || 0
      : undefined,
    bandaiCheckoutOnHit:
      bandai && ($("taskBandaiMode")?.value || "") === "monitor"
        ? $("taskBandaiCheckoutOnHit")?.checked !== false
        : undefined,
    bandaiWatchdog:
      bandai && ["checkout", "atc"].includes($("taskBandaiMode")?.value || "")
        ? $("taskBandaiWatchdog")?.checked !== false
        : undefined,
    bandaiAreaItemNo: bandai ? $("taskBandaiAreaItemNo")?.value?.trim() || "" : undefined,
    pcMode: store === "pokemoncentre" ? $("taskPcMode")?.value || "monitor" : undefined,
    pcLocale: store === "pokemoncentre" ? "en-au" : undefined,
    paymentMethod:
      store === "toymate"
        ? $("taskToymatePay")?.value || "credit_card"
        : bandai
          ? $("taskBandaiPay")?.value || "credit_card"
          : undefined,
    accountPassword:
      store === "toymate"
        ? $("taskAccountPassword")?.value || ""
        : bandai
          ? $("taskBandaiAccountPassword")?.value || ""
          : undefined,
    accountAssign,
    accountId:
      store === "toymate" && accountAssign === "manual"
        ? $("taskAccountId")?.value || null
        : bandai && accountAssign === "manual"
          ? $("taskBandaiAccountId")?.value || null
          : null,
  };
}

function applyProfileDefaultsToTaskForm() {
  const profileId = $("taskProfile")?.value || "";
  if (!profileId || $("taskId")?.value) return;
  const p = (state?.profiles || []).find((x) => x.id === profileId);
  if (!p) return;
  if (p.proxyGroupId && $("taskProxy")) {
    const exists = [...($("taskProxy").options || [])].some((o) => o.value === p.proxyGroupId);
    if (exists) $("taskProxy").value = p.proxyGroupId;
  }
}

$("taskStore").onchange = () => syncTaskFormForStore();
$("taskProfile")?.addEventListener("change", () => applyProfileDefaultsToTaskForm());
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
  const base = readTaskForm();
  const groupMode =
    !$("taskId")?.value && ($("taskProfileSource")?.value || "single") === "group";
  if (groupMode) {
    const groupName = $("taskProfileGroup")?.value?.trim() || "";
    const per = Math.max(1, Math.min(20, Number($("taskPerProfile")?.value) || 1));
    const profiles = profilesInGroup(groupName);
    if (!groupName) {
      toast("Pick a profile group", "err");
      return;
    }
    if (!profiles.length) {
      toast(`No profiles in “${groupName}”`, "err");
      return;
    }
    const total = profiles.length * per;
    if (total > 100) {
      toast(`Too many tasks (${total}) — max 100 at once`, "err");
      return;
    }
    let snap = state;
    let created = 0;
    for (const p of profiles) {
      for (let n = 1; n <= per; n++) {
        const labelBase = base.label || p.name || p.email || "Task";
        const label =
          profiles.length * per > 1
            ? `${labelBase} · ${p.name || p.email || "profile"}${per > 1 ? ` #${n}` : ""}`
            : labelBase;
        snap = await window.desktop.upsertTask({
          ...base,
          id: undefined,
          label: String(label).slice(0, 120),
          profileId: p.id,
          proxyGroupId: base.proxyGroupId || p.proxyGroupId || null,
        });
        created += 1;
      }
    }
    applyState(snap);
    $("taskReset").click();
    closeDialog("taskDialog");
    toast(`Created ${created} task${created === 1 ? "" : "s"}`, "ok");
    return;
  }
  applyState(await window.desktop.upsertTask(base));
  $("taskReset").click();
  closeDialog("taskDialog");
  toast("Task saved", "ok");
};

$("taskReset").onclick = () => {
  $("taskId").value = "";
  $("taskFormTitle").textContent = "New task";
  $("taskForm").reset();
  $("taskPlaceOrder").checked = true;
  if ($("taskProfileSource")) $("taskProfileSource").value = "single";
  if ($("taskPerProfile")) $("taskPerProfile").value = "1";
  syncTaskFormForStore();
  syncTaskProfileSourceUi();
};

$("taskProfileSource")?.addEventListener("change", () => syncTaskProfileSourceUi());
$("taskProfileGroup")?.addEventListener("change", () => refreshTaskProfileGroupHint());
$("taskPerProfile")?.addEventListener("input", () => refreshTaskProfileGroupHint());

$("taskRunOne").onclick = async () => {
  if (($("taskProfileSource")?.value || "single") === "group" && !$("taskId")?.value) {
    toast("Save group tasks first, then run from the table", "err");
    return;
  }
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
      accountGroup: $("accGroup")?.value?.trim() || "",
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
    toast("Account saved", "ok");
    resetAccountForm();
    closeDialog("accountDialog");
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

function wireBulkIo({ exportBtn, importBtn, fileInput, exportFn, importFn, noun, countKey }) {
  if ($(exportBtn)) {
    $(exportBtn).onclick = async () => {
      const fmt = window.confirm("OK = JSON export\nCancel = CSV export") ? "json" : "csv";
      const res = await exportFn({ format: fmt });
      if (!res.ok) {
        appendLog(esc(res.error || "export failed"), "err");
        return;
      }
      downloadTextFile(
        res.filename || `${noun}.${fmt === "csv" ? "csv" : "json"}`,
        res.body || "",
        fmt === "csv" ? "text/csv" : "application/json",
      );
      appendLog(`Exported ${res.count} ${noun} (${fmt})`, "ok");
    };
  }
  if ($(importBtn) && $(fileInput)) {
    $(importBtn).onclick = () => $(fileInput).click();
    $(fileInput).onchange = async () => {
      const file = $(fileInput).files?.[0];
      $(fileInput).value = "";
      if (!file) return;
      let text = "";
      try {
        text = await file.text();
      } catch (e) {
        appendLog(`Import read failed: ${esc(e?.message || e)}`, "err");
        return;
      }
      if (!window.confirm(`Import ${noun} from ${file.name}?`)) return;
      const existing = Number(countKey?.() || 0);
      const replace =
        existing > 0 &&
        window.confirm(`Wipe existing ${noun} first?\n\nOK = replace all\nCancel = merge`);
      const res = await importFn(text, { replace });
      if (res.snapshot) applyState(res.snapshot);
      if (!res.ok) {
        appendLog(esc(res.error || "import failed"), "err");
        return;
      }
      appendLog(`Imported ${res.imported} ${noun}${res.errors?.length ? ` · ${res.errors.length} warn` : ""}`, "ok");
    };
  }
}

wireBulkIo({
  exportBtn: "btnExportProfiles",
  importBtn: "btnImportProfiles",
  fileInput: "profImportFile",
  exportFn: (o) => window.desktop.exportProfiles(o),
  importFn: (t, o) => window.desktop.importProfiles(t, o),
  noun: "profile(s)",
  countKey: () => (state.profiles || []).length,
});
wireBulkIo({
  exportBtn: "btnExportProxies",
  importBtn: "btnImportProxies",
  fileInput: "pxImportFile",
  exportFn: (o) => window.desktop.exportProxyGroups(o),
  importFn: (t, o) => window.desktop.importProxyGroups(t, o),
  noun: "proxy group(s)",
  countKey: () => (state.proxyGroups || []).length,
});
wireBulkIo({
  exportBtn: "btnExportTasks",
  importBtn: "btnImportTasks",
  fileInput: "taskImportFile",
  exportFn: (o) => window.desktop.exportTasks(o),
  importFn: (t, o) => window.desktop.importTasks(t, o),
  noun: "task(s)",
  countKey: () => (state.tasks || []).length,
});

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
      profileGroup: $("profGroup")?.value?.trim() || "",
      proxyGroupId: $("profProxyGroup")?.value || null,
      accountGroup: $("profAccountGroup")?.value?.trim() || "",
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
      paypal_email: $("profPaypalEmail")?.value?.trim() || "",
      paypal_password: $("profPaypalPassword")?.value || "",
    }),
  );
  $("profReset").click();
  closeDialog("profileDialog");
  toast("Profile saved", "ok");
};
$("profReset").onclick = () => {
  $("profId").value = "";
  $("profileForm").reset();
  const group =
    profileGroupFilter !== "all" && profileGroupFilter !== "ungrouped" ? profileGroupFilter : "";
  if ($("profGroup")) {
    fillNamedGroupSelect($("profGroup"), profileGroupNames([group]), {
      selected: group,
      emptyLabel: "No group",
    });
  }
  fillProfileProxyGroupSelect("");
  if ($("profAccountGroup")) {
    fillNamedGroupSelect($("profAccountGroup"), accountGroupNames(), {
      selected: "",
      emptyLabel: "None",
    });
  }
  if ($("profileFormTitle")) $("profileFormTitle").textContent = "Profile";
};

if ($("proxyForm")) {
  $("proxyForm").onsubmit = async (e) => {
    e.preventDefault();
    const snap = await window.desktop.upsertProxyGroup({
      id: $("pxId").value || undefined,
      name: $("pxName").value,
      entriesText: $("pxEntries").value,
    });
    const name = $("pxName").value;
    applyState(snap);
    const saved =
      (state.proxyGroups || []).find((g) => g.name === name) || state.proxyGroups?.slice(-1)[0];
    if (saved) selectedProxyGroupId = saved.id;
    toast("Proxy group saved", "ok");
    renderProxies();
  };
}
if ($("pxReset")) {
  $("pxReset").onclick = () => {
    selectedProxyGroupId = null;
    if ($("pxId")) $("pxId").value = "";
    if ($("pxName")) $("pxName").value = "";
    if ($("pxEntries")) $("pxEntries").value = "";
    if ($("pxTestHint")) $("pxTestHint").textContent = "";
    if ($("proxyEditorTitle")) $("proxyEditorTitle").textContent = "Proxy group";
    if ($("proxyGroupMeta")) $("proxyGroupMeta").textContent = "Select or create a group";
    renderProxyEntryList(null);
  };
}

function openProxyAddDialog({ replace = false } = {}) {
  const g = (state?.proxyGroups || []).find((x) => x.id === selectedProxyGroupId);
  if ($("proxyAddTitle")) $("proxyAddTitle").textContent = replace ? "Replace proxies" : "Add proxies";
  if ($("proxyAddName")) $("proxyAddName").value = g?.name || $("pxName")?.value || "";
  if ($("proxyAddEntries")) $("proxyAddEntries").value = replace ? "" : "";
  $("proxyAddDialog")?.showModal?.();
}

if ($("btnAddProxies")) {
  $("btnAddProxies").onclick = () => openProxyAddDialog();
}
if ($("proxyAddDialogClose")) {
  $("proxyAddDialogClose").onclick = () => $("proxyAddDialog")?.close?.();
}
if ($("proxyAddCancel")) {
  $("proxyAddCancel").onclick = () => $("proxyAddDialog")?.close?.();
}
if ($("proxyAddSave")) {
  $("proxyAddSave").onclick = async () => {
    const name = String($("proxyAddName")?.value || "").trim() || "Proxy group";
    const pasted = String($("proxyAddEntries")?.value || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!pasted.length) {
      toast("Paste at least one proxy line", "err");
      return;
    }
    const existingId = $("pxId")?.value || selectedProxyGroupId || undefined;
    const existing = (state?.proxyGroups || []).find((g) => g.id === existingId);
    const merged = existing
      ? [...new Set([...(existing.entries || []), ...pasted])]
      : pasted;
    const snap = await window.desktop.upsertProxyGroup({
      id: existingId,
      name: existing?.name || name,
      entriesText: merged.join("\n"),
    });
    applyState(snap);
    const saved =
      (state.proxyGroups || []).find((g) => g.id === existingId) ||
      (state.proxyGroups || []).find((g) => g.name === (existing?.name || name)) ||
      state.proxyGroups?.slice(-1)[0];
    if (saved) selectedProxyGroupId = saved.id;
    $("proxyAddDialog")?.close?.();
    toast(`Added ${pasted.length} prox${pasted.length === 1 ? "y" : "ies"}`, "ok");
    renderProxies();
  };
}

if ($("pxMoreBtn") && $("pxMoreMenu")) {
  $("pxMoreBtn").onclick = (e) => {
    e.stopPropagation();
    const open = $("pxMoreMenu").hidden;
    $("pxMoreMenu").hidden = !open;
    $("pxMoreBtn").setAttribute("aria-expanded", open ? "true" : "false");
  };
  document.addEventListener("click", (e) => {
    const wrap = e.target instanceof HTMLElement ? e.target.closest(".menu-wrap") : null;
    if (!wrap || !wrap.contains($("pxMoreBtn"))) closePxMoreMenu();
  });
}

if ($("pxClearAll")) {
  $("pxClearAll").onclick = async () => {
    const id = $("pxId")?.value || selectedProxyGroupId;
    if (!id) return toast("Pick a proxy group first", "err");
    if (!confirm("Clear all proxies in this group?")) return;
    await rewriteProxyEntries([]);
  };
}

if ($("pxTestPreset")) {
  $("pxTestPreset").addEventListener("change", syncProxyTestTargetUi);
  syncProxyTestTargetUi();
}

if ($("pxTestForm")) {
  $("pxTestForm").onclick = async () => {
    const text = $("pxEntries")?.value || "";
    if (!text.trim()) {
      toast("Add proxies first", "err");
      return;
    }
    const targetUrl = resolveProxyTestTargetUrl();
    if (($("pxTestPreset")?.value || "") === "custom" && !targetUrl) {
      toast("Enter a custom test URL", "err");
      return;
    }
    const id = $("pxId")?.value || selectedProxyGroupId;
    appendLog(
      targetUrl ? `Testing proxies → ${targetUrl.replace(/^https?:\/\//, "")}…` : "Testing proxies…",
      "muted",
    );
    let res;
    if (id) {
      res = await window.desktop.testProxyGroup(id, {
        removeDead: Boolean($("pxRemoveDead")?.checked),
        concurrency: 20,
        targetUrl: targetUrl || undefined,
      });
      if (res.snapshot) applyState(res.snapshot);
    } else {
      res = await window.desktop.testProxyEntries(text, {
        concurrency: 20,
        targetUrl: targetUrl || undefined,
      });
      if ($("pxRemoveDead")?.checked && res.results) {
        $("pxEntries").value = res.results
          .filter((r) => r.ok)
          .map((r) => r.entry)
          .join("\n");
      }
    }
    if (id) proxyTestResults[id] = res.ok || res.results ? res : { error: res.error };
    appendLog(
      `Proxy test · ${res.alive ?? 0}/${res.total ?? 0} alive`,
      res.dead ? "err" : "ok",
    );
    toast(`Proxy test · ${res.alive ?? 0}/${res.total ?? 0} alive`, res.dead ? "err" : "ok");
    closePxMoreMenu();
    renderProxies();
  };
}

async function rewriteProxyEntries(nextEntries) {
  const id = $("pxId")?.value || selectedProxyGroupId;
  if (!id) {
    $("pxEntries").value = nextEntries.join("\n");
    renderProxyEntryList({ entries: nextEntries });
    return;
  }
  $("pxEntries").value = nextEntries.join("\n");
  const snap = await window.desktop.upsertProxyGroup({
    id,
    name: $("pxName").value,
    entriesText: nextEntries.join("\n"),
  });
  applyState(snap);
  selectedProxyGroupId = id;
  toast("Proxy list updated", "muted");
}

if ($("pxSortSpeed")) {
  $("pxSortSpeed").onclick = () => {
    proxySortMode = "speed";
    closePxMoreMenu();
    renderProxies();
  };
}
if ($("pxSortFailed")) {
  $("pxSortFailed").onclick = () => {
    proxySortMode = "failed";
    closePxMoreMenu();
    renderProxies();
  };
}
if ($("pxClearFailed")) {
  $("pxClearFailed").onclick = async () => {
    const id = $("pxId")?.value || selectedProxyGroupId;
    const test = id ? proxyTestResults[id] : null;
    const dead = new Set((test?.results || []).filter((r) => !r.ok).map((r) => r.entry));
    if (!dead.size) {
      toast("No failed results — run Test all first", "muted");
      return;
    }
    const next = String($("pxEntries").value || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !dead.has(l));
    await rewriteProxyEntries(next);
    closePxMoreMenu();
  };
}
if ($("pxClearOver")) {
  $("pxClearOver").onclick = async () => {
    const over = Number($("pxClearOverMs")?.value || 0);
    if (!(over > 0)) {
      toast("Enter a millisecond threshold", "err");
      return;
    }
    const id = $("pxId")?.value || selectedProxyGroupId;
    const test = id ? proxyTestResults[id] : null;
    const slow = new Set(
      (test?.results || []).filter((r) => r.ok && Number(r.ms) > over).map((r) => r.entry),
    );
    if (!slow.size) {
      toast("No slow proxies in last test", "muted");
      return;
    }
    const next = String($("pxEntries").value || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !slow.has(l));
    await rewriteProxyEntries(next);
    closePxMoreMenu();
  };
}

/** Group ops use the left rail selection (not a second dropdown). */
function activeTaskGroupName() {
  if (taskGroupFilter === "all" || taskGroupFilter === "ungrouped") return "";
  return String(taskGroupFilter || "").trim();
}

async function massGroupOpts() {
  const taskGroup = activeTaskGroupName() || $("massTaskGroup")?.value?.trim() || "";
  if ($("massTaskGroup") && taskGroup) $("massTaskGroup").value = taskGroup;
  return {
    taskGroup,
    qty: $("massQty")?.value,
    quantity: $("massQuantity")?.value,
    bandaiMonitorDelayMs: $("massDelay")?.value,
  };
}

function activeCheckoutLimits() {
  const name = activeTaskGroupName();
  if (!name) return null;
  const key = groupKey(name);
  const map = state?.checkoutLimits || {};
  return map[key] || map[name] || null;
}

function syncCheckoutLimitFields() {
  const lim = activeCheckoutLimits();
  const gIn = $("limitGroupMax");
  const pIn = $("limitProfileMax");
  const usage = $("limitUsageLine");
  if (gIn && document.activeElement !== gIn) {
    gIn.value = lim?.groupMax != null ? String(lim.groupMax) : "";
  }
  if (pIn && document.activeElement !== pIn) {
    pIn.value = lim?.profileMax != null ? String(lim.profileMax) : "";
  }
  if (usage) {
    if (!lim || (lim.groupMax == null && lim.profileMax == null && !(lim.groupUsed > 0))) {
      usage.hidden = true;
      usage.textContent = "";
    } else {
      const g =
        lim.groupMax != null ? `${lim.groupUsed || 0}/${lim.groupMax} group` : `${lim.groupUsed || 0} group`;
      const p =
        lim.profileMax != null ? ` · per-profile max ${lim.profileMax}` : "";
      usage.textContent = `${g}${p}`;
      usage.hidden = false;
    }
  }
}

function syncTaskGroupOpsBar() {
  syncCheckoutLimitFields();
  const ops = $("taskGroupOps");
  if (!ops) return;
  const group = activeTaskGroupName();
  ops.hidden = !group;
  if ($("massTaskGroup") && group) $("massTaskGroup").value = group;
  const heldBtn = $("btnGroupCheckoutHeld");
  if (heldBtn) {
    const held = group ? heldCartsInGroup(group) : [];
    heldBtn.hidden = !group || held.length === 0;
    heldBtn.textContent =
      held.length > 0 ? `Checkout held (${held.length})` : "Checkout held";
  }
}

if ($("btnGroupStart")) {
  $("btnGroupStart").onclick = async () => {
    const opts = await massGroupOpts();
    if (!opts.taskGroup) return appendLog("Pick a task group on the left first", "err");
    const res = await window.desktop.runTaskGroup(opts);
    if (!res.ok) appendLog(esc(res.error), "err");
    else appendLog(`Started group “${esc(opts.taskGroup)}” · ${res.enqueued || 0} job(s)`, "ok");
    if (res.snapshot) applyState(res.snapshot);
  };
}
if ($("btnGroupStop")) {
  $("btnGroupStop").onclick = async () => {
    const opts = await massGroupOpts();
    if (!opts.taskGroup) return appendLog("Pick a task group on the left first", "err");
    const res = await window.desktop.stopTaskGroup(opts);
    if (!res.ok) appendLog(esc(res.error), "err");
    else appendLog(`Stopped group “${esc(opts.taskGroup)}” · ${res.stopped} task(s)`, "ok");
    if (res.snapshot) applyState(res.snapshot);
  };
}
if ($("btnGroupCheckoutHeld")) {
  $("btnGroupCheckoutHeld").onclick = async () => {
    const opts = await massGroupOpts();
    if (!opts.taskGroup) return appendLog("Pick a task group on the left first", "err");
    const held = heldCartsInGroup(opts.taskGroup);
    if (!held.length) {
      appendLog("No held carts in this group", "err");
      syncTaskGroupOpsBar();
      return;
    }
    if (
      !confirm(
        `Checkout ${held.length} held cart${held.length === 1 ? "" : "s"} in “${opts.taskGroup}”?\n\nEach task pays from its live Bandai cart (pay window ~30 min).`,
      )
    ) {
      return;
    }
    const ids = held.map((t) => t.id);
    const res = await window.desktop.runTasks(ids, { payFromCart: true });
    if (!res.ok) appendLog(esc(res.error), "err");
    else {
      appendLog(
        `Checkout held · “${esc(opts.taskGroup)}” · ${res.enqueued || 0}/${ids.length} enqueued`,
        "ok",
      );
    }
    if (res.snapshot) applyState(res.snapshot);
  };
}
if ($("btnGroupDup")) {
  $("btnGroupDup").onclick = async () => {
    const opts = await massGroupOpts();
    if (!opts.taskGroup) return appendLog("Pick a task group on the left first", "err");
    const res = await window.desktop.duplicateTaskGroup({ taskGroup: opts.taskGroup });
    if (!res.ok) appendLog(esc(res.error || "dup group failed"), "err");
    else {
      appendLog(
        `Duplicated group “${esc(opts.taskGroup)}” → “${esc(res.destGroup)}” · ${res.duplicated} task(s)`,
        "ok",
      );
      if (res.destGroup) taskGroupFilter = res.destGroup;
      if ($("massTaskGroup")) $("massTaskGroup").value = res.destGroup || opts.taskGroup;
      if (res.snapshot) applyState(res.snapshot);
    }
  };
}
if ($("btnLimitSave")) {
  $("btnLimitSave").onclick = async () => {
    const opts = await massGroupOpts();
    if (!opts.taskGroup) return appendLog("Pick a task group on the left first", "err");
    const groupMax = String($("limitGroupMax")?.value || "").trim();
    const profileMax = String($("limitProfileMax")?.value || "").trim();
    const res = await window.desktop.setCheckoutLimits({
      taskGroup: opts.taskGroup,
      groupMax: groupMax === "" ? null : Number(groupMax),
      profileMax: profileMax === "" ? null : Number(profileMax),
    });
    if (!res.ok) appendLog(esc(res.error || "save limits failed"), "err");
    else {
      appendLog(
        `Limits saved for “${esc(opts.taskGroup)}” · group ${res.limits?.groupMax ?? "∞"} · per profile ${res.limits?.profileMax ?? "∞"}`,
        "ok",
      );
      if (res.snapshot) applyState(res.snapshot);
    }
  };
}
if ($("btnLimitReset")) {
  $("btnLimitReset").onclick = async () => {
    const opts = await massGroupOpts();
    if (!opts.taskGroup) return appendLog("Pick a task group on the left first", "err");
    const res = await window.desktop.resetCheckoutLimits({ taskGroup: opts.taskGroup });
    if (!res.ok) appendLog(esc(res.error || "reset limits failed"), "err");
    else {
      appendLog(`Checkout used counts reset for “${esc(opts.taskGroup)}”`, "ok");
      if (res.snapshot) applyState(res.snapshot);
    }
  };
}

$("btnSaveSettings").onclick = async () => {
  const patch = {
    apiKey: $("setApiKey").value.trim(),
    hyperApiKey: $("setHyper").value.trim(),
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
    discordSuccessWebhook: $("setDiscordSuccess")?.value?.trim() || "",
    discordCheckoutWebhook: $("setDiscordSuccess")?.value?.trim() || "",
    discordFailWebhook: $("setDiscordFail")?.value?.trim() || "",
    discord3dsWebhook: $("setDiscord3ds")?.value?.trim() || "",
    discordMonitorWebhook: $("setDiscordMonitor")?.value?.trim() || "",
    discordEmbedFields: readDiscordEmbedFieldsFromForm(),
    successAlertEnabled: $("setSuccessAlert")?.checked !== false,
    detailedLogs: $("setDetailedLogs")?.checked !== false,
    quickTaskPreset: readQuickTaskPresetFromForm(),
  };
  // Never wipe baked-in secrets from empty hidden fields.
  const cp = $("setControlPlane")?.value?.trim().replace(/\/$/, "");
  if (cp) patch.controlPlaneUrl = cp;
  const paydock = $("setPaydockPk")?.value?.trim();
  if (paydock) patch.paydockPublicKey = paydock;
  applyState(await window.desktop.saveSettings(patch));
  appendLog("Settings saved", "muted");
  toast("Settings saved", "ok");
  if (!state?.engine?.running) {
    const res = await window.desktop.startEngine();
    if (res.snapshot) applyState(res.snapshot);
    if (res.ok) appendLog("Engine started", "ok");
    else if (res.error) appendLog(esc(res.error), "err");
  }
};

$("btnValidate").onclick = async () => {
  await $("btnSaveSettings").onclick();
  const res = await window.desktop.validateLicense();
  if (res.snapshot) applyState(res.snapshot);
  appendLog(esc(res.message || (res.ok ? "OK" : "Invalid")), res.ok ? "ok" : "err");
};

document.body.addEventListener("click", async (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("[data-discord-test]") : null;
  if (!btn) return;
  e.preventDefault();
  await $("btnSaveSettings").onclick();
  const kind = btn.getAttribute("data-discord-test") || "success";
  const res = await window.desktop.discordTest({ kind });
  if (!res.ok) appendLog(`Discord ${esc(kind)} test failed: ${esc(res.error || "unknown")}`, "err");
  else appendLog(`Discord ${esc(kind)} test sent${res.urlHost ? ` → ${esc(res.urlHost)}` : ""}`, "ok");
});

if ($("btnRetryEngine")) {
  $("btnRetryEngine").onclick = async () => {
    await $("btnSaveSettings").onclick();
    const res = await window.desktop.startEngine();
    if (res.snapshot) applyState(res.snapshot);
    appendLog(res.ok ? "Engine started" : esc(res.error || "Failed"), res.ok ? "ok" : "err");
  };
}

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
  appendLog("Preparing one Bandai harvest session…", "muted");
  const res = await window.desktop.bandaiHarvestOnce(bandaiHarvestOptsFromForm());
  if (res.snapshot) applyState(res.snapshot);
  else if (res.harvest && state) {
    state.bandaiHarvest = res.harvest;
    renderBandaiHarvest();
  }
  appendLog(
    res.ok ? `Harvested session (${Math.round((res.ms || 0) / 1000)}s)` : esc(res.error || "Harvest failed"),
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
    appendLog("Harvesting one Disney session…", "muted");
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
  const power = $("feedPower");
  if (power) {
    let pillState = "off";
    let label = "Off";
    if (mon.connected) {
      pillState = "on";
      label = "On";
    } else if (mon.running) {
      pillState = "busy";
      label = "…";
    } else if (state?.engine?.running) {
      pillState = "off";
      label = "Off";
    }
    power.dataset.state = pillState;
    const lbl = power.querySelector(".power-pill-label");
    if (lbl) lbl.textContent = label;
    power.title = mon.lastError
      ? `Monitor · ${mon.lastError}`
      : mon.connected
        ? "Monitor connected"
        : mon.running
          ? "Reconnecting…"
          : "Monitor offline";
  }

  const list = $("feedList");
  if (!list) return;
  const rows = state?.monitorFeed || mon.feed || [];
  if (!rows.length) {
    list.innerHTML = `<div class="empty muted">No stock updates yet — they’ll stay here once they land.</div>`;
    return;
  }
  list.innerHTML = rows
    .map((h, idx) => {
      const title = h.title || h.productName || h.productId || "—";
      const reason = (h.reason || "restock").replace(/_/g, " ");
      const when = h.receivedAt
        ? new Date(h.receivedAt).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : h.at
          ? String(h.at).replace("T", " ").slice(0, 16)
          : "";
      const inStock = h.inStock !== false;
      return `<div class="item feed-item" data-feed-idx="${idx}">
        <div class="feed-item-main">
          <div class="feed-item-top">
            <span class="badge ${inStock ? "hv" : "err"}">${esc(reason)}</span>
            <strong>${esc(title)}</strong>
          </div>
          <div class="meta">${esc(h.productId || "")}${when ? ` · ${esc(when)}` : ""}</div>
          <div class="feed-row-actions">
            <button type="button" data-feed-qt="${idx}">Quick Task</button>
            <button type="button" class="secondary" data-feed-sa="${idx}">Smart Action</button>
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
  return state?.smartActionCatalog || { rows: [], templates: [], enabledTemplateIds: null, quickPackIds: [] };
}

function saCatalogDisplayName(t) {
  if (t?.displayName) return String(t.displayName);
  return String(t?.name || t?.id || "Preset").replace(/\{\{.*?\}\}/g, "").replace(/^·\s*/, "").trim() || "Preset";
}

function saStoreLabel(store) {
  const s = String(store || "").toLowerCase();
  if (s === "bandai") return "Premium Bandai";
  if (s === "toymate") return "Toymate";
  if (s === "pokemoncentre" || s === "pokemon") return "Pokémon Centre";
  return store || "Store";
}

function saStoreMark(store) {
  const s = String(store || "").toLowerCase();
  if (s === "bandai") return "PB";
  if (s === "toymate") return "TM";
  if (s === "pokemoncentre" || s === "pokemon") return "PC";
  return (s.slice(0, 2) || "·").toUpperCase();
}

function saResolveImageUrl(row) {
  const direct = String(row?.imageUrl || "").trim();
  if (direct) return direct;
  const sku = String(row?.sku || "").trim();
  if (!sku) return "";
  const hit = (state?.monitorFeed || []).find(
    (h) => String(h.sku || h.productId || "").toUpperCase() === sku.toUpperCase(),
  );
  return String(hit?.imageUrl || hit?.meta?.imageUrl || "").trim();
}

function saQuickPackIds() {
  const cat = saCatalogState();
  if (Array.isArray(cat.quickPackIds) && cat.quickPackIds.length) return cat.quickPackIds;
  return ["monitor_atc", "monitor_checkout_delay_30m", "monitor_alert", "quicktask_atc"];
}

function saPackShortLabel(t) {
  const id = t?.id || "";
  if (id === "monitor_atc") return "Checkout";
  if (id === "monitor_checkout_delay_30m") return "+30m";
  if (id === "monitor_alert") return "Alert";
  if (id === "quicktask_atc") return "Quick Task";
  if (id === "monitor_watch") return "Watch";
  if (id === "drop_harvest_chain") return "Drop chain";
  if (id === "drop_delay_tighten") return "Tighten";
  return saCatalogDisplayName(t);
}

const SA_CATALOG_FILTER_KEY = "vanta.sa.catalogFilters.v1";
const saCatalogFilterState = {
  search: "",
  store: "",
  set: "",
  tcgOnly: true,
  blockKeywords: "t-shirt, acrylic, charm, standee, pin, hoodie, jacket, new era, costume",
  requireKeywords: "",
};

function loadSaCatalogFilters() {
  try {
    const raw = JSON.parse(localStorage.getItem(SA_CATALOG_FILTER_KEY) || "{}");
    if (typeof raw.search === "string") saCatalogFilterState.search = raw.search;
    if (typeof raw.store === "string") saCatalogFilterState.store = raw.store;
    if (typeof raw.set === "string") saCatalogFilterState.set = raw.set;
    if (typeof raw.tcgOnly === "boolean") saCatalogFilterState.tcgOnly = raw.tcgOnly;
    if (typeof raw.blockKeywords === "string") saCatalogFilterState.blockKeywords = raw.blockKeywords;
    if (typeof raw.requireKeywords === "string") {
      saCatalogFilterState.requireKeywords = raw.requireKeywords;
    }
  } catch {
    /* ignore */
  }
}

function persistSaCatalogFilters() {
  try {
    localStorage.setItem(SA_CATALOG_FILTER_KEY, JSON.stringify(saCatalogFilterState));
  } catch {
    /* ignore */
  }
}

function readSaCatalogFiltersFromDom() {
  saCatalogFilterState.search = $("saCatalogSearch")?.value || "";
  saCatalogFilterState.store = $("saCatalogStore")?.value || "";
  saCatalogFilterState.set = $("saCatalogSet")?.value || "";
  saCatalogFilterState.tcgOnly = $("saCatalogTcgOnly") ? $("saCatalogTcgOnly").checked : true;
  saCatalogFilterState.blockKeywords = $("saCatalogBlockKw")?.value || "";
  saCatalogFilterState.requireKeywords = $("saCatalogRequireKw")?.value || "";
  persistSaCatalogFilters();
}

function syncSaCatalogFilterControls(allRows) {
  const CF = window.CatalogFilters;
  if (!CF) return;
  const storeEl = $("saCatalogStore");
  if (storeEl) {
    const stores = CF.uniqueStores(allRows);
    const cur = saCatalogFilterState.store;
    storeEl.innerHTML =
      `<option value="">All stores</option>` +
      stores
        .map(
          (s) =>
            `<option value="${esc(s)}" ${s === cur ? "selected" : ""}>${esc(saStoreLabel(s))}</option>`,
        )
        .join("");
  }
  const setEl = $("saCatalogSet");
  if (setEl) {
    const sets = CF.uniqueSets(allRows, { tcgOnly: false });
    const cur = saCatalogFilterState.set;
    setEl.innerHTML =
      `<option value="">All sets</option>` +
      sets
        .map(
          (s) =>
            `<option value="${esc(s.id)}" ${s.id === cur ? "selected" : ""}>${esc(s.label)} (${s.count})</option>`,
        )
        .join("");
  }
  if ($("saCatalogSearch") && document.activeElement !== $("saCatalogSearch")) {
    $("saCatalogSearch").value = saCatalogFilterState.search;
  }
  if ($("saCatalogTcgOnly")) $("saCatalogTcgOnly").checked = saCatalogFilterState.tcgOnly !== false;
  if ($("saCatalogBlockKw") && document.activeElement !== $("saCatalogBlockKw")) {
    $("saCatalogBlockKw").value = saCatalogFilterState.blockKeywords;
  }
  if ($("saCatalogRequireKw") && document.activeElement !== $("saCatalogRequireKw")) {
    $("saCatalogRequireKw").value = saCatalogFilterState.requireKeywords;
  }
}

function filteredSaCatalogRows() {
  const cat = saCatalogState();
  const all = cat.rows || [];
  const CF = window.CatalogFilters;
  if (!CF?.filterCatalogRows) return all.filter((r) => r.enabled !== false);
  return CF.filterCatalogRows(all, saCatalogFilterState);
}

function renderSaCatalog() {
  const cat = saCatalogState();
  const templates = cat.templates || [];
  const tmplById = new Map(templates.map((t) => [t.id, t]));
  const quickIds = saQuickPackIds().filter((id) => tmplById.has(id));
  const allRows = (cat.rows || []).filter((r) => r.enabled !== false);
  syncSaCatalogFilterControls(allRows);
  const rows = filteredSaCatalogRows();

  const srcHint = $("saCatalogSourceHint");
  if (srcHint) {
    srcHint.textContent =
      cat.source === "monitor"
        ? cat.pulledAt
          ? `updated · ${new Date(cat.pulledAt).toLocaleString()}`
          : "from product library"
        : "not synced yet";
  }

  const rowsEl = $("saCatalogRows");
  if (rowsEl) {
    if (!allRows.length) {
      rowsEl.innerHTML = `<div class="sa-store-empty">No products yet — click Refresh library to sync the product list.</div>`;
    } else if (!rows.length) {
      rowsEl.innerHTML = `<div class="sa-store-empty">No matches — loosen search, set, or TCG / keyword filters.</div>`;
    } else {
      rowsEl.innerHTML = rows
        .map((r) => {
          const img = saResolveImageUrl(r);
          const store = String(r.store || "bandai");
          const title = window.CatalogFilters?.rowTitle?.(r) || r.title || r.sku;
          const setId = window.CatalogFilters?.inferSet?.(title) || "";
          const setLbl = setId ? window.CatalogFilters.setLabel(setId) : "";
          const quickBtns = quickIds
            .filter((id) => {
              const t = tmplById.get(id);
              if (!t) return false;
              if (Array.isArray(t.stores) && t.stores.length) {
                return t.stores.map(String).includes(store);
              }
              return true;
            })
            .map((id) => {
              const t = tmplById.get(id);
              const armed = listUserSmartActions().some(
                (a) =>
                  a.catalogTemplateId === id &&
                  (a.catalogRowId === r.id ||
                    String(a.catalogKey || "").endsWith(`::${String(r.sku)}`)),
              );
              const tip = t.explain || t.does || t.blurb || "Open in builder";
              return `<button type="button" class="sa-pack-chip ${armed ? "is-on" : ""}" data-sa-row-pack="${esc(r.id)}" data-sa-pack="${esc(id)}" title="${esc(tip)}">${esc(saPackShortLabel(t))}</button>`;
            })
            .join("");
          const savedForSku = (state?.smartActions?.actions || []).filter(
            (a) =>
              a.catalogRowId === r.id ||
              (Array.isArray(a.filters) &&
                a.filters.some(
                  (f) =>
                    String(f.field).toLowerCase() === "sku" &&
                    String(f.value || "").toUpperCase() === String(r.sku || "").toUpperCase(),
                )),
          ).length;
          return `<article class="sa-sku-card" data-store="${esc(store)}" role="listitem">
            <button type="button" class="sa-sku-media" data-sa-sku-open="${esc(r.id)}" aria-label="Open presets for ${esc(title)}">
              ${
                img
                  ? `<img class="sa-sku-img" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
                  : `<span class="sa-sku-fallback" data-store="${esc(store)}">${esc(saStoreMark(store))}</span>`
              }
              <span class="sa-store-badge" data-store="${esc(store)}">${esc(saStoreLabel(store))}</span>
            </button>
            <div class="sa-sku-body">
              <button type="button" class="sa-sku-title" data-sa-sku-open="${esc(r.id)}">${esc(title)}</button>
              <div class="sa-sku-meta"><code>${esc(r.sku)}</code>${setLbl ? ` · ${esc(setLbl)}` : ""}${savedForSku ? ` · ${savedForSku} saved` : " · open a pack to build"}</div>
              <div class="sa-pack-row">${quickBtns}</div>
              <button type="button" class="sa-sku-more" data-sa-sku-open="${esc(r.id)}">All presets →</button>
            </div>
          </article>`;
        })
        .join("");
    }
  }
  refreshSaCatalogMeta();
}

function refreshSaCatalogMeta() {
  const cat = saCatalogState();
  const all = (cat.rows || []).filter((r) => r.enabled !== false);
  const shown = filteredSaCatalogRows();
  const saved = listUserSmartActions().length;
  const meta = $("saCatalogMeta");
  if (meta) {
    if (!all.length) meta.textContent = "Library empty";
    else if (shown.length === all.length) meta.textContent = `${all.length} products · ${saved} saved`;
    else meta.textContent = `${shown.length} shown · ${all.length} total · ${saved} saved`;
  }
  const countEl = $("saCatalogTmplCount");
  if (countEl) {
    countEl.textContent = all.length
      ? shown.length === all.length
        ? `${all.length} SKUs`
        : `${shown.length}/${all.length}`
      : "";
  }
}

async function setSaRowPack(rowId, packId, on) {
  const cat = saCatalogState();
  const row = (cat.rows || []).find((r) => r.id === rowId);
  if (!row || !window.desktop?.smartActionCatalogSetRowPacks) return;
  const cur = new Set(Array.isArray(row.enabledTemplateIds) ? row.enabledTemplateIds : []);
  if (on) cur.add(packId);
  else cur.delete(packId);
  const res = await window.desktop.smartActionCatalogSetRowPacks(rowId, [...cur]);
  if (res?.snapshot) applyState(res.snapshot);
  else if (res?.ok === false) toast(res.error || "Could not update packs", "err");
  else toast(on ? "Pack enabled for this SKU" : "Pack off for this SKU", "muted");
}

function openSaSkuDialog(rowId) {
  const cat = saCatalogState();
  const row = (cat.rows || []).find((r) => r.id === rowId);
  if (!row) return;
  // Presets open the builder gallery pre-scoped to this product — no silent arming.
  if (typeof openSaTemplateGallery === "function") openSaTemplateGallery({ row });
}

function listUserSmartActions() {
  const all = state?.smartActions?.actions || [];
  // Hide legacy silent catalog materializations only — everything saved from the builder stays.
  return all.filter((a) => a && !String(a.id || "").startsWith("sa_cat_"));
}

function storeGroupStoreLabel(id) {
  return saStoreLabel(id);
}

function renderStoreGroups() {
  const list = $("saStoreGroupList");
  if (!list) return;
  const rows = [...(state?.storeGroups || [])].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || "")),
  );
  if (!rows.length) {
    list.innerHTML = `<div class="empty muted">No store groups — New group to bundle Bandai / Kmart / etc.</div>`;
    return;
  }
  list.innerHTML = rows
    .map((g) => {
      const chips = (g.stores || [])
        .map((s) => `<span class="sg-chip" data-store="${esc(s)}">${esc(storeGroupStoreLabel(s))}</span>`)
        .join("");
      return `<div class="item sa-store-group-item" data-store-group-row="${esc(g.id)}" title="Right-click for clone / edit / delete">
        <div class="sa-store-group-row">
          <strong>${esc(g.name)}</strong>
          <div class="sg-chips">${chips || `<span class="meta">No stores</span>`}</div>
        </div>
      </div>`;
    })
    .join("");
}

function hideStoreGroupContextMenu() {
  const menu = $("storeGroupContextMenu");
  if (menu) menu.hidden = true;
}

function showStoreGroupContextMenu(groupId, x, y) {
  const menu = $("storeGroupContextMenu");
  const group = (state?.storeGroups || []).find((g) => g.id === groupId);
  if (!menu || !group) return;
  menu.innerHTML = `
    <button type="button" class="ctx-item" data-sg-ctx="edit">Edit</button>
    <button type="button" class="ctx-item" data-sg-ctx="clone">Clone</button>
    <div class="ctx-sep"></div>
    <button type="button" class="ctx-item danger" data-sg-ctx="del">Delete</button>
  `;
  menu.hidden = false;
  menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 140)}px`;
  menu.dataset.groupId = groupId;
  hideTaskContextMenu();
}

function openStoreGroupDialog(group = null) {
  const dlg = $("storeGroupDialog");
  if (!dlg) return;
  $("storeGroupDialogTitle").textContent = group?.id ? "Edit Store Group" : "New Store Group";
  $("storeGroupId").value = group?.id || "";
  $("storeGroupName").value = group?.name || "";
  const selected = new Set((group?.stores || []).map((s) => String(s).toLowerCase()));
  document.querySelectorAll("#storeGroupStores input[type=checkbox]").forEach((cb) => {
    cb.checked = selected.has(String(cb.value).toLowerCase());
  });
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function closeStoreGroupDialog() {
  const dlg = $("storeGroupDialog");
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

async function saveStoreGroupDialog() {
  const name = String($("storeGroupName")?.value || "").trim();
  const stores = [...document.querySelectorAll("#storeGroupStores input[type=checkbox]:checked")].map(
    (cb) => cb.value,
  );
  if (!name) {
    toast("Name required", "err");
    return;
  }
  if (!stores.length) {
    toast("Pick at least one store", "err");
    return;
  }
  if (!window.desktop?.storeGroupUpsert) {
    toast("Store groups unavailable — restart Desktop", "err");
    return;
  }
  const res = await window.desktop.storeGroupUpsert({
    id: $("storeGroupId")?.value || undefined,
    name,
    stores,
  });
  if (res.snapshot) applyState(res.snapshot);
  if (!res.ok) {
    toast(res.error || "Save failed", "err");
    return;
  }
  closeStoreGroupDialog();
  toast("Store group saved", "ok");
}

function renderSmartActions() {
  renderSaCatalog();
  renderStoreGroups();
  const list = $("saList");
  if (!list) return;
  const rows = listUserSmartActions().sort(
    (a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0),
  );
  const countEl = $("saSavedCount");
  if (countEl) countEl.textContent = rows.length ? `${rows.length}` : "";
  if (!rows.length) {
    list.innerHTML = `<div class="empty muted">No Smart Actions yet — click a product pack or New Action, then Save.</div>`;
    return;
  }
  const packs = saCatalogState().templates || [];
  const packById = new Map(packs.map((t) => [t.id, t]));
  list.innerHTML = rows
    .map((a) => {
      const pack = a.catalogTemplateId ? packById.get(a.catalogTemplateId) : null;
      const does = pack?.explain || pack?.does || pack?.blurb || "";
      const on = a.enabled !== false;
      const failHint =
        a.lastResult === "Failed"
          ? `<span class="meta sa-fail-hint">Last run failed</span>`
          : "";
      return `<div class="item sa-saved-item ${on ? "is-on" : "is-off"}">
        <div class="sa-saved-row">
          <label class="power-pill sa-power" data-state="${on ? "on" : "off"}" title="${
            on
              ? "On — armed for new monitor hits"
              : "Off — no new SA runs; in-flight waits cancelled. Watchdog is separate."
          }">
            <input type="checkbox" class="sa-power-input" data-sa-toggle="${esc(a.id)}" ${
              on ? "checked" : ""
            } />
            <span class="power-pill-track" aria-hidden="true">
              <span class="power-pill-knob"></span>
              <span class="power-pill-label">${on ? "On" : "Off"}</span>
            </span>
          </label>
          <div class="sa-saved-body">
            <strong>${esc(a.name)}</strong>
            ${does ? `<div class="meta sa-does-line">${esc(does)}</div>` : ""}
            ${failHint}
            <div class="feed-row-actions">
              <button type="button" data-sa-edit="${esc(a.id)}">Edit</button>
              <button type="button" class="secondary" data-sa-logs="${esc(a.id)}">Logs</button>
              <button type="button" class="secondary" data-sa-del="${esc(a.id)}">Delete</button>
            </div>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

function saStoreGroupSelectHtml(attrs, selected = "", { emptyLabel = "Select store group…" } = {}) {
  const groups = state?.storeGroups || [];
  const cur = String(selected || "");
  const opts = [
    `<option value="">${esc(emptyLabel)}</option>`,
    ...groups.map(
      (g) =>
        `<option value="${esc(g.id)}" ${g.id === cur || g.name === cur ? "selected" : ""}>${esc(
          g.name,
        )} (${(g.stores || []).length})</option>`,
    ),
  ];
  return `<select ${attrs}>${opts.join("")}</select>`;
}

function saTargetEditorHtml(i, cfg, { allowCreated = true } = {}) {
  const t = cfg.target || {};
  const scope = t.scope || "created";
  const groupHtml =
    typeof saTaskGroupSelectHtml === "function"
      ? saTaskGroupSelectHtml(`data-sa-ac="${i}" data-k="target.taskGroup"`, t.taskGroup || "", {
          emptyLabel: "Select group…",
        })
      : `<input data-sa-ac="${i}" data-k="target.taskGroup" list="taskGroupList" value="${esc(
          t.taskGroup || "",
        )}" placeholder="Optional" />`;
  const storeGroupHtml = saStoreGroupSelectHtml(
    `data-sa-ac="${i}" data-k="target.storeGroup"`,
    t.storeGroup || "",
    { emptyLabel: "Select store group…" },
  );
  return `<div class="sa-field-grid">
    <div class="sa-field sa-field-span">
      <label>Target</label>
      <select data-sa-ac="${i}" data-k="target.scope">
        ${allowCreated ? `<option value="created" ${scope === "created" ? "selected" : ""}>Tasks created above</option>` : ""}
        <option value="group" ${scope === "group" ? "selected" : ""}>Task group</option>
        <option value="store_group" ${scope === "store_group" ? "selected" : ""}>Store group</option>
        <option value="all" ${scope === "all" ? "selected" : ""}>All enabled tasks</option>
      </select>
    </div>
    <div class="sa-field sa-field-span">
      <label>Task group</label>
      ${groupHtml}
    </div>
    <div class="sa-field sa-field-span">
      <label>Store group</label>
      ${storeGroupHtml}
    </div>
  </div>`;
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
            <option value="checkout" ${!cfg.bandaiMode || cfg.bandaiMode === "checkout" ? "selected" : ""}>Autocheckout</option>
            <option value="atc" ${cfg.bandaiMode === "atc" ? "selected" : ""}>ATC only</option>
            <option value="monitor" ${cfg.bandaiMode === "monitor" ? "selected" : ""}>Monitor</option>
          </select>
          <label>Task group</label>
          <input data-sa-ac="${i}" data-k="taskGroup" list="taskGroupList" value="${esc(
            cfg.taskGroup || "",
          )}" placeholder="optional — tag created tasks" />
          <label>Task name</label>
          <input data-sa-ac="${i}" data-k="labelTemplate" value="${esc(
            cfg.labelTemplate || "{{sku}} · {{title}}",
          )}" placeholder="e.g. {{sku}} · {{title}}" />
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
          <div class="grid2">
            <div>
              <label>Qty <span class="optional">blank = keep</span></label>
              <input type="number" min="1" max="20" data-sa-ac="${i}" data-k="qty" value="${
                cfg.qty != null && cfg.qty !== "" ? cfg.qty : ""
              }" />
            </div>
            <div>
              <label>Parallel <span class="optional">blank = keep</span></label>
              <input type="number" min="1" max="50" data-sa-ac="${i}" data-k="quantity" value="${
                cfg.quantity != null && cfg.quantity !== "" ? cfg.quantity : ""
              }" />
            </div>
          </div>
          <div class="grid2">
            <div>
              <label>Monitor delay ms <span class="optional">pre-drop tighten → 0</span></label>
              <input type="number" min="0" step="100" data-sa-ac="${i}" data-k="bandaiMonitorDelayMs" value="${
                cfg.bandaiMonitorDelayMs != null && cfg.bandaiMonitorDelayMs !== ""
                  ? cfg.bandaiMonitorDelayMs
                  : ""
              }" placeholder="blank = keep" />
            </div>
            <div>
              <label>Poll interval ms <span class="optional">blank = keep</span></label>
              <input type="number" min="2000" step="500" data-sa-ac="${i}" data-k="bandaiMonitorIntervalMs" value="${
                cfg.bandaiMonitorIntervalMs != null && cfg.bandaiMonitorIntervalMs !== ""
                  ? cfg.bandaiMonitorIntervalMs
                  : ""
              }" />
            </div>
          </div>
          <label>Task name <span class="optional">blank = keep</span></label>
          <input data-sa-ac="${i}" data-k="labelTemplate" value="${esc(cfg.labelTemplate || "")}" />
          <p class="field-hint">Schedule at <code>HH:MM:SS</code> (e.g. 12:59:30) + set delay to 0 = pre-drop tighten.</p>
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
          <p class="field-hint">Uses your Success Discord webhook from Settings → Alerts.</p>
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
  saDraftFilters = saDraftFilters.map((f, i) => {
    const node = document.querySelector(`[data-sa-fv="${i}"]`);
    let value = f.value ?? "";
    if (node) {
      if (node.multiple) {
        value = [...node.selectedOptions].map((o) => o.value).filter(Boolean).join(", ");
      } else {
        value = node.value ?? "";
      }
    }
    return {
      field: document.querySelector(`[data-sa-ff="${i}"]`)?.value || f.field || "title",
      op: document.querySelector(`[data-sa-fo="${i}"]`)?.value || f.op || "matches",
      value,
    };
  });
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
            labelTemplate: "{{sku}} · {{title}}",
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

// btnSaNew wired in sa-builder.js (template gallery)
if ($("btnSaCatalogPull")) {
  $("btnSaCatalogPull").onclick = async () => {
    if (!window.desktop?.smartActionCatalogPull) {
      appendLog("Catalog pull unavailable — restart Desktop", "err");
      return;
    }
    const res = await window.desktop.smartActionCatalogPull();
    if (res.snapshot) applyState(res.snapshot);
    if (!res.ok) {
      appendLog(`Monitor library pull failed: ${esc(res.error || "error")}`, "err");
      toast(res.error || "Library pull failed", "err");
      return;
    }
    const imgs = res.imagesFilled != null ? ` · ${res.imagesFilled} image(s)` : "";
    appendLog(`Library synced from monitor — ${res.count ?? 0} SKU(s)${imgs}`, "ok");
    toast(`Library · ${res.count ?? 0} products${imgs}`, "ok");
  };
}

loadSaCatalogFilters();
(function wireSaCatalogFilters() {
  const rerender = () => {
    readSaCatalogFiltersFromDom();
    renderSaCatalog();
  };
  let searchTimer = null;
  $("saCatalogSearch")?.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(rerender, 120);
  });
  $("saCatalogStore")?.addEventListener("change", rerender);
  $("saCatalogSet")?.addEventListener("change", rerender);
  $("saCatalogTcgOnly")?.addEventListener("change", rerender);
  $("saCatalogBlockKw")?.addEventListener("change", rerender);
  $("saCatalogRequireKw")?.addEventListener("change", rerender);
  $("saCatalogBlockKw")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") rerender();
  });
  $("saCatalogRequireKw")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") rerender();
  });
})();
$("saSkuDialogClose")?.addEventListener("click", () => closeDialog("saSkuDialog"));
// Filter / action / save / New Action wired in sa-builder.js
if ($("saTrigger")) {
  $("saTrigger").onchange = () => syncSaScheduleVisibility();
}
if ($("btnSaLogClose")) {
  $("btnSaLogClose").onclick = () => {
    if ($("saLogPanel")) $("saLogPanel").hidden = true;
  };
}

document.body.addEventListener("change", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  if (!t.dataset.saToggle) return;
  const id = t.dataset.saToggle;
  const res = await window.desktop.smartActionSetEnabled(id, t.checked);
  if (res.snapshot) applyState(res.snapshot);
  else renderSmartActions();
});

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
  if (evt.type === "toast" && evt.message) {
    toast(evt.message, evt.level || "ok");
  }
  if (
    (evt.type === "gotoTaskGroup" ||
      (evt.type === "smartAction" &&
        (evt.phase === "goto_task_group" || evt.phase === "tasks_created"))) &&
    (evt.taskGroup || (evt.phase === "tasks_created" && evt.taskIds?.length))
  ) {
    const group = String(evt.taskGroup || "");
    const taskIds = Array.isArray(evt.taskIds) ? evt.taskIds.map(String) : [];
    void (async () => {
      // Pull fresh snapshot — Watchdog can race ahead of SA create and leave UI stale.
      try {
        const snap = await window.desktop?.getState?.();
        if (snap) applyState(snap);
      } catch {
        /* ignore */
      }
      if (group) {
        taskGroupFilter = group;
        const inGroup = (state?.tasks || []).filter(
          (t) => groupKey(t.taskGroup) === groupKey(group),
        );
        // If create stamped a different group (or none), don't strand on an empty rail.
        if (!inGroup.length && taskIds.length) {
          const any = (state?.tasks || []).some((t) => taskIds.includes(String(t.id)));
          taskGroupFilter = any ? "all" : group;
        } else if (!inGroup.length && !taskIds.length) {
          taskGroupFilter = "all";
        }
      } else if (taskIds.length) {
        taskGroupFilter = "all";
      }
      setTab("tasks");
      try {
        renderTaskGroupRail();
        renderTasks();
        if (taskIds[0]) {
          const row = document.querySelector(`[data-task-row="${CSS.escape(taskIds[0])}"]`);
          row?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
        }
      } catch {
        /* ignore */
      }
      if (evt.phase === "tasks_created" && taskIds.length) {
        toast(
          group && taskGroupFilter === group
            ? `Created ${taskIds.length} task(s) in ${group}`
            : `Created ${taskIds.length} task(s)`,
          "ok",
        );
      } else if (group && taskGroupFilter === group) {
        toast(`Task group · ${group}`, "muted");
      }
    })();
  }
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
  if (evt.type === "checkoutWin") {
    if (state?.settings?.successAlertEnabled === false) return;
    playWinSound();
    const winLabel = evt.label || evt.orderNumber || evt.taskId || "checkout";
    appendLog(`WIN · ${esc(winLabel)}`, "ok");
    toast(`Win · ${winLabel}`, "ok");
  }
  if (evt.type === "window" && typeof evt.maximized === "boolean") {
    document.body.classList.toggle("is-maximized", evt.maximized);
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
  if (evt.type === "taskStatus" && evt.taskId && state?.tasks) {
    const t = state.tasks.find((x) => x.id === evt.taskId);
    if (t) {
      t.lastStatus = evt.lastStatus || t.lastStatus;
      t.lastLabel = evt.lastLabel || t.lastLabel;
      if (document.querySelector("#tab-tasks.panel.active, #tab-tasks:not([hidden])") || true) {
        renderTasks();
      }
    }
  }
  if (evt.type === "job") {
    if (evt.phase === "start") {
      appendLog(`${esc(evt.label || evt.runId)} — Starting`, "muted");
      patchTaskLiveStatus(evt.taskId, "running", evt.consumerLabel || "Starting");
    } else if (evt.phase === "status") {
      patchTaskLiveStatus(
        evt.taskId,
        evt.lastStatus || "running",
        evt.consumerLabel || evt.lastLabel || "Starting",
      );
    } else if (evt.phase === "log") {
      const msg = String(evt.message || "");
      // Belt-and-suspenders: hide recipe/debug lines when detailed diagnostics is off.
      if (
        state?.settings?.detailedLogs === false &&
        /^(failedStep=|detail:|MATCH |LOCAL |global poll |local poll |Bandai monitor mode=|Subscribed watch |Backend PID |Bandai policy )/i.test(
          msg,
        )
      ) {
        /* skip */
      } else {
        const cls = evt.level === "err" ? "err" : evt.level === "ok" ? "ok" : "muted";
        appendLog(esc(msg), cls);
      }
    } else if (evt.phase === "progress") {
      const line = evt.consumerLabel || evt.message || evt.progress?.label || "Starting";
      patchTaskLiveStatus(evt.taskId, "running", line);
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

function patchTaskLiveStatus(taskId, lastStatus, lastLabel) {
  if (!taskId || !state?.tasks) return;
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  t.lastStatus = lastStatus || "running";
  t.lastLabel = lastLabel || t.lastLabel;
  renderTasks();
}

wireWindowControls();
tickClock();
setInterval(tickClock, 1000);
setInterval(tickHeldCartCountdowns, 1000);

$("homeOpenDropPrep")?.addEventListener("click", () => focusDropPrep());
$("homeOpenHarvest")?.addEventListener("click", () => setTab("harvest"));
$("homeNewTask")?.addEventListener("click", () => openNewTaskModal());
$("homeOpenTasks")?.addEventListener("click", () => setTab("tasks"));
document.body.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("[data-home-check]") : null;
  if (!btn) return;
  runHomeCheckAction(btn.getAttribute("data-home-check") || "");
});

$("btnNewTask")?.addEventListener("click", () => openNewTaskModal());
$("btnNewTaskGroup")?.addEventListener("click", () => {
  const name = window.prompt("New task group name");
  if (!name?.trim()) return;
  taskGroupFilter = name.trim();
  if ($("massTaskGroup")) $("massTaskGroup").value = taskGroupFilter;
  openNewTaskModal(taskGroupFilter);
});
$("taskDialogClose")?.addEventListener("click", () => closeDialog("taskDialog"));
$("profileDialogClose")?.addEventListener("click", () => closeDialog("profileDialog"));
$("accountDialogClose")?.addEventListener("click", () => closeDialog("accountDialog"));
$("btnNewProfile")?.addEventListener("click", () => {
  $("profReset")?.click();
  if ($("profileFormTitle")) $("profileFormTitle").textContent = "New profile";
  setTab("profiles");
  openDialog("profileDialog");
});
$("btnNewProfileGroup")?.addEventListener("click", () => {
  const name = window.prompt("New profile group name");
  if (!name?.trim()) return;
  profileGroupFilter = name.trim();
  $("profReset")?.click();
  if ($("profileFormTitle")) $("profileFormTitle").textContent = "New profile";
  setTab("profiles");
  openDialog("profileDialog");
});
$("btnNewAccount")?.addEventListener("click", () => {
  resetAccountForm();
  setTab("accounts");
  openDialog("accountDialog");
});
$("btnNewAccountGroup")?.addEventListener("click", () => {
  const name = window.prompt("New account group name");
  if (!name?.trim()) return;
  accountGroupFilter = name.trim();
  resetAccountForm();
  setTab("accounts");
  openDialog("accountDialog");
});
$("btnNewProxyGroup")?.addEventListener("click", async () => {
  const name = window.prompt("New proxy group name");
  if (!name?.trim()) return;
  const snap = await window.desktop.upsertProxyGroup({
    name: name.trim(),
    entriesText: "",
  });
  applyState(snap);
  const saved =
    (state.proxyGroups || []).find((g) => g.name === name.trim()) ||
    state.proxyGroups?.slice(-1)[0];
  if (saved) selectedProxyGroupId = saved.id;
  setTab("proxies");
  renderProxies();
  openProxyAddDialog();
});
$("accStoreFilter")?.addEventListener("change", () => renderAccounts());
$("taskSearch")?.addEventListener("input", () => renderTasks());
$("profileSearch")?.addEventListener("input", () => renderProfiles());
$("accountSearch")?.addEventListener("input", () => renderAccounts());
$("proxySearch")?.addEventListener("input", () => renderProxies());

document.addEventListener("keydown", (e) => {
  const tag = (e.target instanceof HTMLElement ? e.target.tagName : "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
  if (e.key === "n" || e.key === "N") {
    const tasksActive = $("tab-tasks")?.classList.contains("active");
    if (tasksActive) {
      e.preventDefault();
      openNewTaskModal();
    }
  }
  if (e.key === "Escape") {
    hideTaskContextMenu();
    hideStoreGroupContextMenu();
  }
});

document.addEventListener("contextmenu", (e) => {
  const sgRow =
    e.target instanceof HTMLElement ? e.target.closest("[data-store-group-row]") : null;
  if (sgRow && $("tab-smart")?.classList.contains("active")) {
    e.preventDefault();
    showStoreGroupContextMenu(sgRow.getAttribute("data-store-group-row"), e.clientX, e.clientY);
    return;
  }
  const row = e.target instanceof HTMLElement ? e.target.closest("[data-task-row]") : null;
  if (!row || !$("tab-tasks")?.classList.contains("active")) return;
  e.preventDefault();
  showTaskContextMenu(row.getAttribute("data-task-row"), e.clientX, e.clientY);
});
document.addEventListener("click", (e) => {
  if (
    e.target instanceof HTMLElement &&
    (e.target.closest("#taskContextMenu") || e.target.closest("#storeGroupContextMenu"))
  ) {
    return;
  }
  hideTaskContextMenu();
  hideStoreGroupContextMenu();
});

$("btnStoreGroupNew")?.addEventListener("click", () => openStoreGroupDialog(null));
$("storeGroupDialogClose")?.addEventListener("click", () => closeStoreGroupDialog());
$("btnStoreGroupCancel")?.addEventListener("click", () => closeStoreGroupDialog());
$("btnStoreGroupSave")?.addEventListener("click", () => void saveStoreGroupDialog());

refresh();
}
