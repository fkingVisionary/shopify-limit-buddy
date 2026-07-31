import fs from "fs";
const h = fs.readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const ids = [...h.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const counts = {};
for (const id of ids) counts[id] = (counts[id] || 0) + 1;
const dups = Object.entries(counts).filter(([, c]) => c > 1);
console.log("dups", dups);
for (const x of [
  "taskDialog",
  "tab-home",
  "taskLabel",
  "taskBandaiMode",
  "pxEntries",
  "pxTestForm",
  "pxSortSpeed",
  "setHyper",
  "setSmspool",
  "checkoutFeed",
  "homeStats",
]) {
  console.log(x, (h.match(new RegExp(`id="${x}"`, "g")) || []).length);
}
