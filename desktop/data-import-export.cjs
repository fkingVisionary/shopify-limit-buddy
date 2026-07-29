/**
 * Bulk import/export for profiles, proxy groups, and tasks.
 * Mirrors account-vault import style: JSON array / CSV / simple lines.
 */

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseJsonOrText(raw) {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Profiles ──────────────────────────────────────────────────────────

const PROFILE_CSV_HEADERS = [
  "name",
  "email",
  "first_name",
  "last_name",
  "phone",
  "address1",
  "address2",
  "city",
  "province",
  "zip",
  "country",
  "card_number",
  "card_exp_month",
  "card_exp_year",
  "card_cvv",
  "card_name",
];

function normalizeProfileDraft(raw = {}) {
  const email = String(raw.email || "").trim();
  const name = String(raw.name || raw.label || email || "Profile").trim().slice(0, 80);
  if (!email && !raw.first_name && !raw.card_number) {
    return { ok: false, error: "need email or shipping/card fields" };
  }
  return {
    ok: true,
    profile: {
      id: raw.id || undefined,
      name,
      email,
      first_name: String(raw.first_name || raw.firstName || "").trim(),
      last_name: String(raw.last_name || raw.lastName || "").trim(),
      phone: String(raw.phone || "").trim(),
      address1: String(raw.address1 || raw.address || "").trim(),
      address2: String(raw.address2 || "").trim(),
      city: String(raw.city || "").trim(),
      province: String(raw.province || raw.state || "").trim(),
      zip: String(raw.zip || raw.postcode || "").trim(),
      country: String(raw.country || "AU").trim() || "AU",
      card_number: String(raw.card_number || raw.cardNumber || "").replace(/\s+/g, ""),
      card_exp_month: String(raw.card_exp_month || raw.expMonth || raw.mm || "").trim(),
      card_exp_year: String(raw.card_exp_year || raw.expYear || raw.yy || "").trim(),
      card_cvv: String(raw.card_cvv || raw.cvv || "").trim(),
      card_name: String(raw.card_name || raw.cardName || "").trim(),
    },
  };
}

function parseProfilesImport(raw) {
  const errors = [];
  const profiles = [];
  let skipped = 0;
  const parsed = parseJsonOrText(raw);
  if (parsed == null) return { ok: false, profiles: [], errors: ["empty import"], skipped: 0 };

  let drafts = [];
  if (Array.isArray(parsed)) drafts = parsed;
  else if (parsed?.profiles && Array.isArray(parsed.profiles)) drafts = parsed.profiles;
  else if (typeof parsed === "string") {
    const lines = parsed.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (!lines.length) return { ok: false, profiles: [], errors: ["empty import"], skipped: 0 };
    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    const hasHeader = header.includes("email") || header.includes("name");
    const start = hasHeader ? 1 : 0;
    const keys = hasHeader ? header : PROFILE_CSV_HEADERS;
    for (let i = start; i < lines.length; i++) {
      const parts = splitCsvLine(lines[i]);
      if (parts.every((p) => !p)) {
        skipped += 1;
        continue;
      }
      const row = {};
      keys.forEach((k, idx) => {
        if (k) row[k] = parts[idx] || "";
      });
      drafts.push(row);
    }
  } else if (parsed && typeof parsed === "object") drafts = [parsed];
  else return { ok: false, profiles: [], errors: ["unrecognized import format"], skipped: 0 };

  for (let i = 0; i < drafts.length; i++) {
    const n = normalizeProfileDraft(drafts[i]);
    if (!n.ok) {
      errors.push(`row ${i + 1}: ${n.error}`);
      continue;
    }
    profiles.push(n.profile);
  }
  return { ok: profiles.length > 0, profiles, errors, skipped };
}

function formatProfilesExport(profiles, format = "json") {
  const list = Array.isArray(profiles) ? profiles : [];
  if (format === "csv") {
    const lines = [PROFILE_CSV_HEADERS.join(",")];
    for (const p of list) {
      lines.push(PROFILE_CSV_HEADERS.map((h) => csvEscape(p[h] ?? "")).join(","));
    }
    return lines.join("\n");
  }
  return JSON.stringify({ profiles: list }, null, 2);
}

// ── Proxy groups ──────────────────────────────────────────────────────

function normalizeProxyGroupDraft(raw = {}) {
  const name = String(raw.name || "Proxies").trim().slice(0, 80);
  let entries = [];
  if (Array.isArray(raw.entries)) entries = raw.entries.map(String).map((s) => s.trim()).filter(Boolean);
  else if (typeof raw.entries === "string") {
    entries = raw.entries.split(/\r?\n|\|/).map((s) => s.trim()).filter(Boolean);
  } else if (typeof raw.entriesText === "string") {
    entries = raw.entriesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  if (!name && !entries.length) return { ok: false, error: "empty proxy group" };
  return {
    ok: true,
    group: { id: raw.id || undefined, name: name || "Proxies", entries },
  };
}

function parseProxyGroupsImport(raw) {
  const errors = [];
  const groups = [];
  let skipped = 0;
  const parsed = parseJsonOrText(raw);
  if (parsed == null) return { ok: false, groups: [], errors: ["empty import"], skipped: 0 };

  let drafts = [];
  if (Array.isArray(parsed)) drafts = parsed;
  else if (parsed?.proxyGroups && Array.isArray(parsed.proxyGroups)) drafts = parsed.proxyGroups;
  else if (parsed?.groups && Array.isArray(parsed.groups)) drafts = parsed.groups;
  else if (typeof parsed === "string") {
    const lines = parsed.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (!lines.length) return { ok: false, groups: [], errors: ["empty import"], skipped: 0 };
    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    if (header.includes("name") && (header.includes("entries") || header.includes("proxies"))) {
      const nameIdx = header.indexOf("name");
      const entIdx = header.includes("entries") ? header.indexOf("entries") : header.indexOf("proxies");
      for (let i = 1; i < lines.length; i++) {
        const parts = splitCsvLine(lines[i]);
        drafts.push({ name: parts[nameIdx], entries: parts[entIdx] });
      }
    } else {
      // Single group: all lines are entries; optional first line "name: Foo"
      let name = "Imported";
      let start = 0;
      if (/^name\s*:/i.test(lines[0])) {
        name = lines[0].replace(/^name\s*:/i, "").trim() || name;
        start = 1;
      }
      drafts.push({ name, entries: lines.slice(start) });
    }
  } else if (parsed && typeof parsed === "object") drafts = [parsed];
  else return { ok: false, groups: [], errors: ["unrecognized import format"], skipped: 0 };

  for (let i = 0; i < drafts.length; i++) {
    const n = normalizeProxyGroupDraft(drafts[i]);
    if (!n.ok) {
      errors.push(`row ${i + 1}: ${n.error}`);
      skipped += 1;
      continue;
    }
    groups.push(n.group);
  }
  return { ok: groups.length > 0, groups, errors, skipped };
}

function formatProxyGroupsExport(groups, format = "json") {
  const list = Array.isArray(groups) ? groups : [];
  if (format === "csv") {
    const lines = ["name,entries"];
    for (const g of list) {
      lines.push(`${csvEscape(g.name)},${csvEscape((g.entries || []).join("|"))}`);
    }
    return lines.join("\n");
  }
  return JSON.stringify({ proxyGroups: list }, null, 2);
}

// ── Tasks ─────────────────────────────────────────────────────────────

const TASK_CSV_HEADERS = [
  "label",
  "taskGroup",
  "store",
  "pdpUrl",
  "bandaiWatchSku",
  "bandaiAreaItemNo",
  "qty",
  "quantity",
  "profileName",
  "proxyGroupName",
  "bandaiMode",
  "bandaiMonitorDelayMs",
  "bandaiMonitorIntervalMs",
  "placeOrder",
  "enabled",
];

function normalizeTaskDraft(raw = {}, lookups = {}) {
  const store = String(raw.store || "bandai").trim().toLowerCase() || "bandai";
  const label = String(raw.label || raw.name || raw.bandaiWatchSku || raw.pdpUrl || "Task")
    .trim()
    .slice(0, 120);
  let profileId = raw.profileId || null;
  let proxyGroupId = raw.proxyGroupId || null;
  if (!profileId && raw.profileName && lookups.profilesByName) {
    profileId = lookups.profilesByName.get(String(raw.profileName).trim().toLowerCase()) || null;
  }
  if (!proxyGroupId && raw.proxyGroupName && lookups.proxiesByName) {
    proxyGroupId =
      lookups.proxiesByName.get(String(raw.proxyGroupName).trim().toLowerCase()) || null;
  }
  return {
    ok: true,
    task: {
      id: raw.id || undefined,
      store,
      label,
      taskGroup: String(raw.taskGroup || raw.group || "").trim().slice(0, 80),
      pdpUrl: String(raw.pdpUrl || raw.url || "").trim(),
      bandaiWatchSku: String(raw.bandaiWatchSku || raw.sku || raw.productId || "").trim(),
      bandaiAreaItemNo: String(raw.bandaiAreaItemNo || raw.nai || "").trim(),
      qty: Math.max(1, Math.min(20, Number(raw.qty) || 1)),
      quantity: Math.max(1, Math.min(50, Number(raw.quantity) || 1)),
      profileId,
      proxyGroupId,
      placeOrder: raw.placeOrder !== false && String(raw.placeOrder).toLowerCase() !== "false",
      enabled: raw.enabled !== false && String(raw.enabled).toLowerCase() !== "false",
      bandaiMode: store === "bandai" ? String(raw.bandaiMode || "checkout") : undefined,
      bandaiMonitorDelayMs:
        raw.bandaiMonitorDelayMs != null && raw.bandaiMonitorDelayMs !== ""
          ? Math.max(0, Number(raw.bandaiMonitorDelayMs) || 0)
          : undefined,
      bandaiMonitorIntervalMs:
        raw.bandaiMonitorIntervalMs != null && raw.bandaiMonitorIntervalMs !== ""
          ? Math.max(2000, Number(raw.bandaiMonitorIntervalMs) || 10000)
          : undefined,
    },
  };
}

function parseTasksImport(raw, lookups = {}) {
  const errors = [];
  const tasks = [];
  let skipped = 0;
  const parsed = parseJsonOrText(raw);
  if (parsed == null) return { ok: false, tasks: [], errors: ["empty import"], skipped: 0 };

  let drafts = [];
  if (Array.isArray(parsed)) drafts = parsed;
  else if (parsed?.tasks && Array.isArray(parsed.tasks)) drafts = parsed.tasks;
  else if (typeof parsed === "string") {
    const lines = parsed.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (!lines.length) return { ok: false, tasks: [], errors: ["empty import"], skipped: 0 };
    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    const hasHeader =
      header.includes("label") || header.includes("store") || header.includes("pdpurl") || header.includes("sku");
    const start = hasHeader ? 1 : 0;
    const keys = hasHeader
      ? header.map((h) => {
          const aliases = {
            sku: "bandaiWatchSku",
            productid: "bandaiWatchSku",
            bandaiwatchsku: "bandaiWatchSku",
            nai: "bandaiAreaItemNo",
            bandaiareaitemno: "bandaiAreaItemNo",
            url: "pdpUrl",
            pdpurl: "pdpUrl",
            group: "taskGroup",
            taskgroup: "taskGroup",
            profilename: "profileName",
            proxygroupname: "proxyGroupName",
            proxy: "proxyGroupName",
            bandaimode: "bandaiMode",
            bandaimonitordelayms: "bandaiMonitorDelayMs",
            bandaimonitorintervalms: "bandaiMonitorIntervalMs",
            placeorder: "placeOrder",
          };
          return aliases[h] || h;
        })
      : TASK_CSV_HEADERS;
    for (let i = start; i < lines.length; i++) {
      const parts = splitCsvLine(lines[i]);
      if (parts.every((p) => !p)) {
        skipped += 1;
        continue;
      }
      const row = {};
      keys.forEach((k, idx) => {
        if (k) row[k] = parts[idx] || "";
      });
      drafts.push(row);
    }
  } else if (parsed && typeof parsed === "object") drafts = [parsed];
  else return { ok: false, tasks: [], errors: ["unrecognized import format"], skipped: 0 };

  for (let i = 0; i < drafts.length; i++) {
    const n = normalizeTaskDraft(drafts[i], lookups);
    if (!n.ok) {
      errors.push(`row ${i + 1}: ${n.error}`);
      continue;
    }
    tasks.push(n.task);
  }
  return { ok: tasks.length > 0, tasks, errors, skipped };
}

function formatTasksExport(tasks, format = "json", lookups = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const enriched = list.map((t) => ({
    ...t,
    profileName: lookups.profileName?.(t.profileId) || "",
    proxyGroupName: lookups.proxyGroupName?.(t.proxyGroupId) || "",
  }));
  if (format === "csv") {
    const lines = [TASK_CSV_HEADERS.join(",")];
    for (const t of enriched) {
      lines.push(TASK_CSV_HEADERS.map((h) => csvEscape(t[h] ?? "")).join(","));
    }
    return lines.join("\n");
  }
  return JSON.stringify({ tasks: enriched }, null, 2);
}

module.exports = {
  parseProfilesImport,
  formatProfilesExport,
  parseProxyGroupsImport,
  formatProxyGroupsExport,
  parseTasksImport,
  formatTasksExport,
  normalizeProfileDraft,
  normalizeProxyGroupDraft,
  normalizeTaskDraft,
};
