const fs = require("fs");
const http = require("http");
const path = require("path");

const dbPath = path.join(process.env.APPDATA, "j1ms-bot-desktop", "j1ms-desktop", "db.json");
const setPath = path.join(process.env.APPDATA, "j1ms-bot-desktop", "j1ms-desktop", "settings.json");
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const settings = JSON.parse(fs.readFileSync(setPath, "utf8"));
const profile = db.profiles[0];
const account = (db.accounts || []).find((a) => a.storeId === "bandai") || db.accounts[0];
const group = (db.proxyGroups || []).find((g) => g.name === "Proxy1") || db.proxyGroups.find((g) => g.entries?.length);
const proxyLine = group.entries[Math.floor(Math.random() * group.entries.length)];
function toUrl(line) {
  const p = String(line).trim();
  if (/^https?:\/\//i.test(p)) return p;
  const parts = p.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts;
    return `http://${user}:${rest.join(":")}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
  return p;
}
const proxy = toUrl(proxyLine);
const pan = String(profile.card_number || "").replace(/\s+/g, "");
const payload = {
  taskId: `bandai-statefix-${Date.now()}`,
  storeUrl: "https://p-bandai.com/au/item/N2847890001",
  pdpUrl: "https://p-bandai.com/au/item/N2847890001",
  qty: 1,
  proxy,
  dryRun: false,
  placeOrder: true,
  forceUndici: true,
  debugTrace: true,
  bandaiMode: "checkout",
  bandaiCheckoutMode: "fast",
  bandaiGeHttpPay: true,
  bandaiGeRiskHydrate: true,
  bandaiGePreferPageIssuer: true,
  bandaiF5Bridge: true,
  account: { email: account.email, password: account.password },
  profile: {
    email: profile.email,
    first_name: profile.first_name,
    last_name: profile.last_name,
    address1: profile.address1,
    city: profile.city,
    province: profile.province,
    zip: profile.zip,
    phone: profile.phone,
  },
  card: {
    number: pan,
    expMonth: String(profile.card_exp_month || "").padStart(2, "0"),
    expYear: String(profile.card_exp_year || "").replace(/^20/, "").slice(-2),
    cvv: String(profile.card_cvv || ""),
    holder: profile.card_name || `${profile.first_name} ${profile.last_name}`,
  },
};
fs.writeFileSync("C:/Users/crumb/AppData/Local/Temp/bandai-smoke-payload.json", JSON.stringify({
  proxyHost: proxy.replace(/:[^:@]+@/, ":***@"),
  email: account.email,
  province: profile.province,
  taskId: payload.taskId,
}, null, 2));
fs.writeFileSync("C:/Users/crumb/AppData/Local/Temp/bandai-smoke-full.json", JSON.stringify(payload));
console.log(JSON.stringify({ ok: true, taskId: payload.taskId, province: profile.province, proxy: proxy.split("@").pop(), email: account.email }));
