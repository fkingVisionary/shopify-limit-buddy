import fs from "fs";

const path = new URL("../renderer/index.html", import.meta.url);
let html = fs.readFileSync(path, "utf8");

function extractTagged(src, openRe, closeTag) {
  const m = openRe.exec(src);
  if (!m) throw new Error(`open not found: ${openRe}`);
  const start = m.index;
  const afterOpen = start + m[0].length;
  const close = `</${closeTag}>`;
  let depth = 1;
  let i = afterOpen;
  const openTag = `<${closeTag}`;
  while (i < src.length && depth > 0) {
    const nextOpen = src.indexOf(openTag, i);
    const nextClose = src.indexOf(close, i);
    if (nextClose < 0) throw new Error(`close not found for ${closeTag}`);
    if (nextOpen >= 0 && nextOpen < nextClose) {
      // only count real open tags like <form ...> not </form>
      const ch = src[nextOpen + openTag.length];
      if (ch === " " || ch === ">" || ch === "\n" || ch === "\r" || ch === "\t") {
        depth += 1;
        i = nextOpen + openTag.length;
        continue;
      }
    }
    depth -= 1;
    if (depth === 0) {
      return {
        full: src.slice(start, nextClose + close.length),
        inner: src.slice(afterOpen, nextClose),
        start,
        end: nextClose + close.length,
      };
    }
    i = nextClose + close.length;
  }
  throw new Error(`unbalanced ${closeTag}`);
}

function extractSection(src, id) {
  const re = new RegExp(`<section\\s+id="${id}"[^>]*>`);
  return extractTagged(src, re, "section");
}

function extractForm(src, id) {
  const re = new RegExp(`<form\\s+id="${id}"[^>]*>`);
  return extractTagged(src, re, "form");
}

// ——— TASKS ———
{
  const sec = extractSection(html, "tab-tasks");
  const form = extractForm(sec.full, "taskForm");
  // Strip outer form chrome; keep fields. Title h3 stays for modal head sync.
  const formInner = form.inner
    .replace(/<h3 id="taskFormTitle">[\s\S]*?<\/h3>\s*/, "")
    .trim();

  const tasksHtml = `
    <!-- TASKS -->
    <section id="tab-tasks" class="panel tasks-panel">
      <aside class="groups-rail">
        <div class="rail-head">Groups</div>
        <div id="taskGroupRail" class="group-list"></div>
        <div class="rail-foot">
          <button type="button" class="secondary" id="btnNewTaskGroup">New group</button>
        </div>
      </aside>
      <div class="tasks-main">
        <div class="tasks-toolbar">
          <div class="panel-header" style="margin-bottom:12px">
            <div>
              <h2>Tasks</h2>
              <p class="hint">Drop prep + group ops stay here. Press <kbd>N</kbd> for a new task.</p>
            </div>
            <div class="toolbar-actions">
              <button type="button" class="secondary" id="btnExportTasks">Export</button>
              <button type="button" class="secondary" id="btnImportTasks">Import</button>
              <input type="file" id="taskImportFile" accept=".json,.csv,.txt,text/*,application/json" hidden />
              <button type="button" id="btnNewTask">New task</button>
            </div>
          </div>
          <p id="harvestBankStrip" class="harvest-bank-strip" aria-live="polite">Harvest banks —</p>
          <div id="dropPrepCard" class="drop-prep-card">
            <div class="drop-prep-head">
              <strong>Bandai drop prep</strong>
              <span id="dropReadyBadge" class="badge">—</span>
            </div>
            <p id="dropReadyStrip" class="drop-ready-strip" aria-live="polite">Ready —</p>
            <div class="drop-prep-row">
              <label class="drop-fire-label">Fire at (AEST)</label>
              <input id="dropFireAt" placeholder="13:00 or 2026-07-27T13:00" autocomplete="off" />
              <button type="button" id="btnDropModeArm">Arm Drop Mode</button>
              <button type="button" id="btnDropScheduleArm" class="secondary">Arm schedule</button>
              <button type="button" id="btnDropScheduleCancel" class="secondary">Cancel</button>
              <button type="button" id="btnVaultLoginCheck" class="secondary">Check vault logins</button>
            </div>
            <p id="dropScheduleLine" class="field-hint">No schedule armed</p>
          </div>
          <div class="task-group-ops" id="taskGroupOps">
            <label class="drop-fire-label">Group ops</label>
            <input id="massTaskGroup" list="taskGroupList" placeholder="Task group" autocomplete="off" />
            <datalist id="taskGroupList"></datalist>
            <input id="massGroupColor" type="color" value="#c8c8cc" title="Group color tag" aria-label="Group color" />
            <button type="button" id="btnGroupColor" class="secondary">Set color</button>
            <button type="button" id="btnGroupStart">Start group</button>
            <button type="button" id="btnGroupStop" class="secondary">Stop group</button>
            <button type="button" id="btnGroupDup" class="secondary">Duplicate group</button>
            <input id="massQty" type="number" min="1" max="20" placeholder="Qty" title="Qty per checkout" style="width:4.5rem" />
            <input id="massQuantity" type="number" min="1" max="50" placeholder="Parallel" title="Parallel jobs" style="width:5rem" />
            <input id="massDelay" type="number" min="0" step="500" placeholder="Delay ms" title="Monitor start delay (ms)" style="width:6rem" />
            <button type="button" id="btnGroupPatch" class="secondary">Apply to group</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data-table" id="taskTable">
            <thead>
              <tr>
                <th class="col-check">On</th>
                <th>Task</th>
                <th>Store</th>
                <th>Profile</th>
                <th>Proxy</th>
                <th>Qty</th>
                <th>Status</th>
                <th class="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody id="taskList"></tbody>
          </table>
        </div>
      </div>
    </section>

    <dialog id="taskDialog" class="modal">
      <div class="modal-card" style="width:min(560px,94vw)">
        <div class="modal-head">
          <h3 id="taskFormTitle">New task</h3>
          <button type="button" class="icon-btn" id="taskDialogClose" aria-label="Close">✕</button>
        </div>
        <form id="taskForm" class="modal-body">
          ${formInner}
        </form>
      </div>
    </dialog>
`;

  html = html.slice(0, sec.start) + tasksHtml + html.slice(sec.end);
}

// ——— PROFILES ———
{
  const sec = extractSection(html, "tab-profiles");
  const form = extractForm(sec.full, "profileForm");
  const formInner = form.inner.replace(/<h3>[\s\S]*?<\/h3>\s*/, "").trim();
  const profilesHtml = `
    <!-- PROFILES -->
    <section id="tab-profiles" class="panel table-panel">
      <div class="panel-pad">
        <div class="panel-header">
          <div>
            <h2>Profiles</h2>
            <p class="hint">Stored only on this computer. Used for address + card on checkout.</p>
          </div>
          <div class="toolbar-actions">
            <button type="button" class="secondary" id="btnExportProfiles">Export</button>
            <button type="button" class="secondary" id="btnImportProfiles">Import</button>
            <input type="file" id="profImportFile" accept=".json,.csv,.txt,text/*,application/json" hidden />
            <button type="button" id="btnNewProfile">New profile</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Location</th>
                <th>Card</th>
                <th class="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody id="profileList"></tbody>
          </table>
        </div>
      </div>
    </section>

    <dialog id="profileDialog" class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3 id="profileFormTitle">Profile</h3>
          <button type="button" class="icon-btn" id="profileDialogClose" aria-label="Close">✕</button>
        </div>
        <form id="profileForm" class="modal-body">
          ${formInner}
        </form>
      </div>
    </dialog>
`;
  html = html.slice(0, sec.start) + profilesHtml + html.slice(sec.end);
}

// ——— ACCOUNTS ———
{
  const sec = extractSection(html, "tab-accounts");
  const form = extractForm(sec.full, "accountForm");
  const formInner = form.inner.replace(/<h3 id="accountFormTitle">[\s\S]*?<\/h3>\s*/, "").trim();
  const howto = sec.full.match(/<div class="form-card" style="margin-top:12px">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/section>/);
  const howtoInner = howto
    ? howto[0].match(/<div class="form-card" style="margin-top:12px">([\s\S]*?)<\/div>/)?.[1] || ""
    : `<h3>How to generate</h3><p class="hint">Profiles → Proxies → Settings OTP → Account gen, or Import.</p>`;

  const accountsHtml = `
    <!-- ACCOUNTS -->
    <section id="tab-accounts" class="panel table-panel">
      <div class="panel-pad">
        <div class="panel-header">
          <div>
            <h2>Accounts</h2>
            <p class="hint">Retailer logins (manual, import, or Account gen). Save the <strong>exact</strong> Bandai member email + password.</p>
          </div>
          <div class="toolbar-actions">
            <select id="accStoreFilter" class="toolbar-select">
              <option value="">All stores</option>
              <option value="bandai">Bandai</option>
              <option value="toymate">Toymate</option>
              <option value="disney">Disney</option>
              <option value="kmart">Kmart</option>
            </select>
            <button type="button" class="secondary" id="btnExportAccounts">Export</button>
            <button type="button" class="secondary" id="btnImportAccounts">Import</button>
            <button type="button" class="secondary" id="btnClearAccounts">Clear all</button>
            <input type="file" id="accImportFile" accept=".json,.csv,.txt,text/*,application/json" hidden />
            <button type="button" id="btnNewAccount">Add account</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Store</th>
                <th>Email</th>
                <th>Status</th>
                <th>Notes</th>
                <th class="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody id="accountList"></tbody>
          </table>
        </div>
      </div>
    </section>

    <dialog id="accountDialog" class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h3 id="accountFormTitle">Add account</h3>
          <button type="button" class="icon-btn" id="accountDialogClose" aria-label="Close">✕</button>
        </div>
        <form id="accountForm" class="modal-body">
          ${formInner}
          <div class="howto" style="margin-top:14px">${howtoInner}</div>
        </form>
      </div>
    </dialog>
`;
  html = html.slice(0, sec.start) + accountsHtml + html.slice(sec.end);
}

// ——— PROXIES ———
{
  const sec = extractSection(html, "tab-proxies");
  const form = extractForm(sec.full, "proxyForm");
  const formInner = form.inner.replace(/<h3>[\s\S]*?<\/h3>\s*/, "").trim();
  const proxiesHtml = `
    <!-- PROXIES -->
    <section id="tab-proxies" class="panel proxies-panel">
      <aside class="groups-rail">
        <div class="rail-head">Proxy groups</div>
        <div id="proxyGroupRail" class="group-list"></div>
        <div class="rail-foot">
          <button type="button" id="btnNewProxyGroup">New group</button>
        </div>
      </aside>
      <div class="proxies-main">
        <div class="panel-header">
          <div>
            <h2 id="proxyEditorTitle">Proxy group</h2>
            <p class="hint">One entry per line. Supports <code>host:port</code>, <code>user:pass@host:port</code>, <code>host:port:user:pass</code>. Probe uses IP check; Bandai lanes should use sticky AU ISP (site <code>https://p-bandai.com/au/</code> — no www).</p>
          </div>
          <div class="toolbar-actions">
            <button type="button" class="secondary" id="btnExportProxies">Export</button>
            <button type="button" class="secondary" id="btnImportProxies">Import</button>
            <input type="file" id="pxImportFile" accept=".json,.csv,.txt,text/*,application/json" hidden />
          </div>
        </div>
        <div class="proxies-grid">
          <form id="proxyForm" class="form-card">
            ${formInner}
          </form>
          <div class="form-card proxy-test-card">
            <h3>Test results</h3>
            <p id="pxTestHint" class="hint" style="margin-top:0"></p>
            <div class="proxy-tools">
              <div class="row" style="flex-wrap:wrap;gap:8px">
                <button type="button" class="secondary" id="pxSortSpeed">Sort by speed</button>
                <button type="button" class="secondary" id="pxSortFailed">Sort failed first</button>
                <button type="button" class="secondary" id="pxClearFailed">Clear failed</button>
              </div>
              <div class="inline-fields" style="margin-top:10px">
                <input id="pxClearOverMs" type="number" min="1" placeholder="Clear over ms" />
                <button type="button" class="secondary" id="pxClearOver">Clear slow</button>
              </div>
            </div>
            <div id="proxyEntryList" class="proxy-entry-list"></div>
            <div id="proxyList" hidden></div>
          </div>
        </div>
      </div>
    </section>
`;
  // Note: pxTestHint may duplicate if it was inside form — strip from formInner
  html = html.slice(0, sec.start) + proxiesHtml.replace(
    /(<form id="proxyForm"[^>]*>)([\s\S]*?)(<\/form>)/,
    (_a, open, inner, close) => {
      let cleaned = inner.replace(/<p id="pxTestHint"[\s\S]*?<\/p>/, "");
      return open + cleaned + close;
    },
  ) + html.slice(sec.end);
}

// ——— SETTINGS ———
{
  const sec = extractSection(html, "tab-settings");
  // Keep all input IDs by redistributing content into panes.
  // Extract the wide form-card inner content.
  const cardMatch = sec.full.match(/<div class="form-card wide">([\s\S]*)<\/div>\s*<\/section>/);
  if (!cardMatch) throw new Error("settings card missing");
  // We'll rebuild settings with panes that include the same IDs by moving chunks.

  const settingsHtml = `
    <!-- SETTINGS -->
    <section id="tab-settings" class="panel settings-panel">
      <aside class="settings-nav">
        <div class="rail-head">Settings</div>
        <button type="button" class="settings-nav-item active" data-settings-pane="general">General</button>
        <button type="button" class="settings-nav-item" data-settings-pane="checkout">Checkout keys</button>
        <button type="button" class="settings-nav-item" data-settings-pane="agen">Account gen</button>
        <button type="button" class="settings-nav-item" data-settings-pane="monitor">Monitor</button>
        <button type="button" class="settings-nav-item" data-settings-pane="alerts">Alerts</button>
        <button type="button" class="settings-nav-item" data-settings-pane="data">Data</button>
      </aside>
      <div class="settings-main">
        <div class="settings-pane active" data-pane="general">
          <h2>General</h2>
          <p class="hint">API key is Whop-ready: validation hits the control plane when a URL is set. Leave URL empty for local/dev mode.</p>
          <label>API key</label>
          <input id="setApiKey" placeholder="Your license API key" autocomplete="off" />
          <label>Control plane URL (optional for now)</label>
          <input id="setControlPlane" placeholder="https://your-dashboard.example.com" />
          <label>Max concurrent checkouts</label>
          <input id="setMax" type="number" min="1" max="50" value="5" />
          <label class="check"><input id="setPlaceOrder" type="checkbox" checked /> Default place order on</label>
          <label class="check"><input id="setSuccessAlert" type="checkbox" checked /> Sound + taskbar flash + toast on checkout win</label>
          <h3 style="margin-top:1.25rem">Quick Task preset</h3>
          <p class="hint">Defaults for Monitor Feed → Quick Task and Smart Actions Create Tasks.</p>
          <label>Store</label>
          <select id="qtPresetStore">
            <option value="bandai">Premium Bandai AU</option>
          </select>
          <label>Bandai mode</label>
          <select id="qtPresetMode">
            <option value="checkout">Autocheckout</option>
            <option value="monitor">Monitor (global + checkout on hit)</option>
          </select>
          <label>Profile</label>
          <select id="qtPresetProfile"></select>
          <label>Proxy group</label>
          <select id="qtPresetProxy"></select>
          <div class="grid2">
            <div>
              <label>Qty per checkout</label>
              <input id="qtPresetQty" type="number" min="1" max="20" value="1" />
            </div>
            <div>
              <label>Parallel tasks</label>
              <input id="qtPresetQuantity" type="number" min="1" max="50" value="1" />
            </div>
          </div>
          <label class="check"><input id="qtPresetPlaceOrder" type="checkbox" checked /> Place order</label>
          <label class="check"><input id="qtPresetStart" type="checkbox" checked /> Start after create</label>
          <div class="row" style="margin-top:16px">
            <button type="button" id="btnSaveSettings">Save settings</button>
            <button type="button" class="secondary" id="btnValidate">Validate API key</button>
          </div>
          <p id="licenseMsg" class="hint"></p>
        </div>

        <div class="settings-pane" data-pane="checkout">
          <h2>Checkout keys</h2>
          <label>Hyper API key (BYO — required for Kmart)</label>
          <input id="setHyper" placeholder="Hyper Solutions key" autocomplete="off" />
          <label>Paydock public key (Kmart widget — static)</label>
          <input id="setPaydockPk" placeholder="Paste once; used for card tokenize" autocomplete="off" />
          <p class="hint">Kmart’s client-side Paydock public key. Leave blank to use PAYDOCK_PUBLIC_KEY from the environment / baked-in default.</p>
          <label>CapSolver API key (Toymate Cloudflare + captcha)</label>
          <input id="setCapsolver" placeholder="CapSolver key" autocomplete="off" />
          <p class="hint">Used only by Toymate. Kmart ignores this key.</p>
          <div class="row" style="margin-top:16px">
            <button type="button" class="secondary" data-settings-save>Save settings</button>
          </div>
        </div>

        <div class="settings-pane" data-pane="agen">
          <h2>Account gen</h2>
          <p class="hint">Secrets stay on this computer. Bandai: email via IMAP + SMS via SMSPool. Never logged in full.</p>
          <label>SMSPool API key <span class="optional">(preferred)</span></label>
          <input id="setSmspool" placeholder="SMSPool key (BYO)" autocomplete="off" />
          <div class="grid2">
            <div>
              <label>SMS provider</label>
              <select id="setSmsProvider">
                <option value="auto">Auto (SMSPool → OnlineSim)</option>
                <option value="smspool">SMSPool only</option>
                <option value="onlinesim">OnlineSim only</option>
              </select>
            </div>
            <div>
              <label>SMSPool country</label>
              <select id="setSmspoolCountry">
                <option value="GB">UK (+44) — cheaper</option>
                <option value="US">US (+1)</option>
              </select>
            </div>
          </div>
          <label>OnlineSim API key <span class="optional">(fallback)</span></label>
          <input id="setOnlinesim" placeholder="OnlineSim apikey" autocomplete="off" />
          <div class="grid2">
            <div>
              <label>OnlineSim mode</label>
              <select id="setOnlinesimMode">
                <option value="rent">Rent (AU)</option>
                <option value="activation">Activation (service slug)</option>
              </select>
            </div>
            <div>
              <label>Service slug <span class="optional">(activation)</span></label>
              <input id="setOnlinesimSlug" placeholder="other" />
            </div>
          </div>
          <label>IMAP host</label>
          <input id="setImapHost" placeholder="imap.gmail.com" />
          <div class="grid2">
            <div>
              <label>IMAP port</label>
              <input id="setImapPort" type="number" value="993" />
            </div>
            <div>
              <label>Mailbox</label>
              <input id="setImapMailbox" placeholder="INBOX" />
            </div>
          </div>
          <label>IMAP user (email = Bandai memberId)</label>
          <input id="setImapUser" type="email" placeholder="you@gmail.com" autocomplete="off" />
          <label>IMAP app password</label>
          <input id="setImapAppPassword" type="password" placeholder="App password (not Bandai password)" autocomplete="off" />
          <div class="row" style="margin-top:16px">
            <button type="button" class="secondary" data-settings-save>Save settings</button>
          </div>
        </div>

        <div class="settings-pane" data-pane="monitor">
          <h2>Monitor</h2>
          <p class="hint">Restocks appear on the Monitor page.</p>
          <label class="check"><input id="setBandaiGlobalMon" type="checkbox" checked /> Follow admin feed when engine starts</label>
          <label>Monitor URL</label>
          <input id="setBandaiGlobalMonUrl" placeholder="https://j1ms-bandai-monitor-production.up.railway.app" />
          <label>Operator token (optional)</label>
          <input id="setBandaiGlobalMonToken" placeholder="Only for cache push / admin overrides — leave blank" autocomplete="off" />
          <label class="check"><input id="setDesktopWatchdog" type="checkbox" checked /> Watchdog — auto-start Autocheckout tasks on restock match</label>
          <p class="hint">Armed Bandai Autocheckout tasks start when the Railway feed reports in-stock.</p>
          <div class="row" style="margin-top:16px">
            <button type="button" class="secondary" data-settings-save>Save settings</button>
          </div>
        </div>

        <div class="settings-pane" data-pane="alerts">
          <h2>Alerts</h2>
          <p class="hint">Split Discord channels so wins stay visible. Empty fields fall back to Success.</p>
          <label>Success (checkouts OK)</label>
          <div class="row webhook-row">
            <input id="setDiscordSuccess" placeholder="https://discord.com/api/webhooks/…" autocomplete="off" />
            <button type="button" class="secondary" id="btnDiscordTestSuccess" data-discord-test="success">Test</button>
          </div>
          <label>Fail (checkout errors)</label>
          <div class="row webhook-row">
            <input id="setDiscordFail" placeholder="https://discord.com/api/webhooks/…" autocomplete="off" />
            <button type="button" class="secondary" id="btnDiscordTestFail" data-discord-test="fail">Test</button>
          </div>
          <label>3DS / bank approval</label>
          <div class="row webhook-row">
            <input id="setDiscord3ds" placeholder="https://discord.com/api/webhooks/…" autocomplete="off" />
            <button type="button" class="secondary" id="btnDiscordTest3ds" data-discord-test="threeds">Test</button>
          </div>
          <label>Monitor / Smart Action notify</label>
          <div class="row webhook-row">
            <input id="setDiscordMonitor" placeholder="https://discord.com/api/webhooks/…" autocomplete="off" />
            <button type="button" class="secondary" id="btnDiscordTestMonitor" data-discord-test="monitor">Test</button>
          </div>
          <p class="hint">Legacy single “checkout” webhook still works as Success if Success is empty.</p>
          <div class="row" style="margin-top:16px">
            <button type="button" class="secondary" data-settings-save>Save settings</button>
          </div>
        </div>

        <div class="settings-pane" data-pane="data">
          <h2>Data</h2>
          <p class="hint">Import / export local vault data. Files stay on this machine.</p>
          <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:12px">
            <button type="button" class="secondary" id="btnExportTasksData" data-export-mirror="btnExportTasks">Export tasks</button>
            <button type="button" class="secondary" id="btnImportTasksData" data-import-mirror="btnImportTasks">Import tasks</button>
            <button type="button" class="secondary" id="btnExportProfilesData" data-export-mirror="btnExportProfiles">Export profiles</button>
            <button type="button" class="secondary" id="btnImportProfilesData" data-import-mirror="btnImportProfiles">Import profiles</button>
            <button type="button" class="secondary" id="btnExportAccountsData" data-export-mirror="btnExportAccounts">Export accounts</button>
            <button type="button" class="secondary" id="btnImportAccountsData" data-import-mirror="btnImportAccounts">Import accounts</button>
            <button type="button" class="secondary" id="btnExportProxiesData" data-export-mirror="btnExportProxies">Export proxies</button>
            <button type="button" class="secondary" id="btnImportProxiesData" data-import-mirror="btnImportProxies">Import proxies</button>
          </div>
          <p class="hint">Mirrors the Export/Import buttons on each tab.</p>
        </div>
      </div>
    </section>
`;
  html = html.slice(0, sec.start) + settingsHtml + html.slice(sec.end);
}

// ——— HARVEST: wrap banks in clearer sections ———
{
  const sec = extractSection(html, "tab-harvest");
  let body = sec.full
    .replace('<section id="tab-harvest" class="panel">', '<section id="tab-harvest" class="panel harvest-panel">')
    .replace('<div class="split">', '<div class="harvest-bank" data-bank="toymate"><div class="split">');
  // This is messy for 3 banks. Simpler: add class harvest-panel and panel header only.
  body = sec.full.replace(
    '<section id="tab-harvest" class="panel">',
    `<section id="tab-harvest" class="panel harvest-panel">
      <div class="panel-pad" style="padding-bottom:8px">
        <h2>Harvest</h2>
        <p class="hint">Three banks — Toymate CF, Disney Akamai, Bandai F5. Same sticky proxy group as checkout.</p>
      </div>`,
  );
  // close: before </section> we don't need extra wrap if panel-pad only wraps header
  html = html.slice(0, sec.start) + body + html.slice(sec.end);
}

// Feed / Results light class polish
html = html.replace(
  '<section id="tab-feed" class="panel">',
  '<section id="tab-feed" class="panel feed-panel">',
);
html = html.replace(
  '<section id="tab-smart" class="panel">',
  '<section id="tab-smart" class="panel smart-panel">',
);
html = html.replace(
  '<section id="tab-results" class="panel">',
  '<section id="tab-results" class="panel results-panel">',
);

// Ensure no duplicate datalist ids from leftover
const dlCount = (html.match(/id="taskGroupList"/g) || []).length;
if (dlCount > 1) {
  // keep first only — remove extras by replacing subsequent with empty
  let seen = 0;
  html = html.replace(/<datalist id="taskGroupList"><\/datalist>/g, () => {
    seen += 1;
    return seen === 1 ? '<datalist id="taskGroupList"></datalist>' : "";
  });
}

fs.writeFileSync(path, html);
console.log("panels transform ok", html.length);
