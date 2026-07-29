/**
 * Operator vault for phone Bot lab — accounts, profile, checkout proxies.
 * Separate from monitor keyword/proxy runtime config.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateFile } from "./data-dir.mjs";

function defaultVaultPath() {
  if (process.env.BOT_VAULT_PATH) return process.env.BOT_VAULT_PATH;
  return resolveStateFile("vanta-bot-vault.json").path;
}

export function emptyVault() {
  return {
    accounts: [],
    profile: {
      label: "default",
      email: "",
      first_name: "",
      last_name: "",
      address1: "",
      city: "",
      province: "",
      zip: "",
      phone: "",
      card_number: "",
      card_cvv: "",
      card_exp_month: "",
      card_exp_year: "",
      card_name: "",
    },
    checkoutProxies: "",
    defaults: {
      bandaiArea: "au",
      bandaiSku: "N2890904001",
      kmartUrl: "",
      kmartVariantId: "",
    },
    updatedAt: null,
  };
}

export function loadBotVault(filePath = defaultVaultPath()) {
  const base = emptyVault();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(raw);
    return {
      ...base,
      ...(typeof j === "object" && j ? j : {}),
      profile: { ...base.profile, ...(j?.profile || {}) },
      defaults: { ...base.defaults, ...(j?.defaults || {}) },
      accounts: Array.isArray(j?.accounts) ? j.accounts : [],
      _path: filePath,
      _fromDisk: true,
    };
  } catch {
    return { ...base, _path: filePath, _fromDisk: false };
  }
}

export function saveBotVault(vault, filePath = defaultVaultPath()) {
  const out = {
    accounts: (Array.isArray(vault.accounts) ? vault.accounts : [])
      .map((a) => ({
        id: String(a.id || `acc_${Date.now()}`),
        storeId: String(a.storeId || "bandai"),
        label: String(a.label || a.email || "").slice(0, 80),
        email: String(a.email || "").trim(),
        password: String(a.password || ""),
      }))
      .filter((a) => a.email && a.password),
    profile: { ...emptyVault().profile, ...(vault.profile || {}) },
    checkoutProxies: String(vault.checkoutProxies || ""),
    defaults: { ...emptyVault().defaults, ...(vault.defaults || {}) },
    updatedAt: new Date().toISOString(),
  };
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2));
  return { ...out, _path: filePath, _fromDisk: true };
}

/** Public view — mask card PAN/CVV for GET responses. */
export function vaultPublicView(vault) {
  const pan = String(vault.profile?.card_number || "").replace(/\s+/g, "");
  return {
    accounts: (vault.accounts || []).map((a) => ({
      id: a.id,
      storeId: a.storeId,
      label: a.label,
      email: a.email,
      // password present flag only
      hasPassword: Boolean(a.password),
    })),
    profile: {
      ...vault.profile,
      card_number: pan ? `•••• ${pan.slice(-4)}` : "",
      card_cvv: vault.profile?.card_cvv ? "•••" : "",
      _hasCard: pan.length >= 12 && Boolean(vault.profile?.card_cvv),
    },
    checkoutProxies: vault.checkoutProxies || "",
    proxyCount: String(vault.checkoutProxies || "")
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")).length,
    defaults: vault.defaults || {},
    updatedAt: vault.updatedAt || null,
  };
}

export { defaultVaultPath };
