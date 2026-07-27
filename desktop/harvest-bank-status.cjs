/**
 * Compact harvest-bank lines for the Tasks tab (Bandai / Toymate / Disney).
 * Pure formatting — no Electron.
 */

function sessionAgeSec(snap) {
  const rows = Array.isArray(snap?.sessions) ? snap.sessions : [];
  if (!rows.length) return null;
  // Prefer youngest ready session (most recently minted).
  let min = Infinity;
  for (const s of rows) {
    const a = Number(s.ageSec);
    if (Number.isFinite(a) && a < min) min = a;
  }
  return Number.isFinite(min) ? min : null;
}

function formatBankChip(label, snap) {
  const ready = Number(snap?.ready) || 0;
  const desired = Number(snap?.config?.desired);
  const desiredLabel = Number.isFinite(desired) ? String(desired) : "–";
  const age = sessionAgeSec(snap);
  const agePart = ready > 0 && age != null ? ` · ${age}s` : "";
  let state = "off";
  if (snap?.busy) state = "mint";
  else if (snap?.running) state = "armed";
  else if (ready > 0) state = "ready";
  const stateLabel =
    state === "mint" ? "minting" : state === "armed" ? "armed" : state === "ready" ? "banked" : "off";
  return {
    label,
    ready,
    desired: desiredLabel,
    ageSec: age,
    state,
    stateLabel,
    text: `${label} ${ready}/${desiredLabel}${agePart} ${stateLabel}`,
  };
}

/**
 * @param {{ bandai?: object, toymate?: object, disney?: object }} banks
 * @returns {{ chips: object[], text: string }}
 */
function formatHarvestBankStrip(banks = {}) {
  const chips = [
    formatBankChip("Bandai F5", banks.bandai || banks.bandaiHarvest),
    formatBankChip("Toymate CF", banks.toymate || banks.harvest),
    formatBankChip("Disney", banks.disney || banks.disneyHarvest),
  ];
  return {
    chips,
    text: chips.map((c) => c.text).join("  ·  "),
  };
}

module.exports = {
  sessionAgeSec,
  formatBankChip,
  formatHarvestBankStrip,
};
