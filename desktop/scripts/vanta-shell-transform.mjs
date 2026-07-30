import fs from "fs";

const path = new URL("../renderer/index.html", import.meta.url);
let html = fs.readFileSync(path, "utf8");

const shell = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Vanta</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="titlebar">
    <div class="titlebar-drag">
      <img class="titlebar-logo" src="assets/icon.png" alt="" width="18" height="18" />
      <span class="titlebar-brand">VANTA</span>
    </div>
    <div class="titlebar-controls">
      <button type="button" class="win-btn" id="btnWinMin" aria-label="Minimize">─</button>
      <button type="button" class="win-btn" id="btnWinMax" aria-label="Maximize">□</button>
      <button type="button" class="win-btn win-close" id="btnWinClose" aria-label="Close">✕</button>
    </div>
  </div>

  <header class="topnav">
    <div class="topnav-left">
      <nav class="topnav-tabs tabs" aria-label="Main">
        <button type="button" data-tab="home" class="active">Home</button>
        <button type="button" data-tab="tasks">Tasks</button>
        <button type="button" data-tab="feed">Monitor Feed</button>
        <button type="button" data-tab="smart">Smart Actions</button>
        <button type="button" data-tab="harvest">Harvest</button>
        <button type="button" data-tab="profiles">Profiles</button>
        <button type="button" data-tab="accounts">Accounts</button>
        <button type="button" data-tab="proxies">Proxies</button>
        <button type="button" data-tab="results">Results</button>
        <button type="button" data-tab="settings">Settings</button>
      </nav>
    </div>
    <div class="topnav-right">
      <div class="engine-pill">
        <span id="engineDot" class="dot"></span>
        <span class="engine-label" id="engineLabel">Starting…</span>
      </div>
      <button id="btnRetryEngine" class="secondary" type="button" hidden>Retry</button>
      <button id="btnRunAll" type="button">Run enabled</button>
      <span id="clock" class="clock"></span>
    </div>
  </header>

  <main>
`;

html = html.replace(/^[\s\S]*?<main>\s*/, shell);

const home = `
    <!-- HOME -->
    <section id="tab-home" class="panel active home-panel">
      <div class="home-main">
        <div class="home-toolbar">
          <div>
            <h2>Dashboard</h2>
            <p class="hint">Quiet overview of checkouts, harvest banks, and live activity.</p>
          </div>
          <div class="seg-row">
            <button type="button" class="seg active" data-home-period="today">Today</button>
            <button type="button" class="seg" data-home-period="week">Week</button>
            <button type="button" class="seg" data-home-period="month">Month</button>
          </div>
        </div>
        <div class="stat-grid" id="homeStats"></div>
        <div class="home-grid">
          <div class="home-card">
            <div class="home-card-head"><h3>Success by store</h3></div>
            <div id="homeStoreBars" class="bar-list"></div>
          </div>
          <div class="home-card">
            <div class="home-card-head"><h3>Activity</h3></div>
            <div id="homeActivity" class="log home-log"></div>
          </div>
        </div>
      </div>
      <aside class="home-feed">
        <h3>Recent cops</h3>
        <div id="checkoutFeed" class="feed-list"></div>
      </aside>
    </section>

`;

if (!html.includes('id="tab-home"')) {
  html = html.replace("<!-- TASKS -->", home + "<!-- TASKS -->");
}

html = html.replace(
  '<section id="tab-tasks" class="panel active">',
  '<section id="tab-tasks" class="panel tasks-panel">'
);

html = html.replace(/J1m Presets/g, "Vanta Presets");
html = html.replace(/J1m's Bot/g, "Vanta");

if (!html.includes("toastHost")) {
  html = html.replace(
    '<script src="app.js"></script>',
    `<div id="taskContextMenu" class="ctx-menu" hidden></div>
  <div id="toastHost" class="toast-host" aria-live="polite"></div>
  <script src="app.js"></script>`
  );
}

fs.writeFileSync(path, html);
console.log("shell transform ok", html.length);
