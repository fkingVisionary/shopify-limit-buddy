const test = require("node:test");
const assert = require("node:assert/strict");
const { formatHarvestBankStrip, formatBankChip } = require("./harvest-bank-status.cjs");

test("formatBankChip shows ready/desired and youngest age", () => {
  const chip = formatBankChip("Bandai F5", {
    ready: 2,
    running: true,
    busy: false,
    config: { desired: 2 },
    sessions: [{ ageSec: 40 }, { ageSec: 12 }],
  });
  assert.equal(chip.ready, 2);
  assert.equal(chip.desired, "2");
  assert.equal(chip.ageSec, 12);
  assert.match(chip.text, /Bandai F5 2\/2 · 12s armed/);
});

test("formatHarvestBankStrip joins three banks", () => {
  const { text, chips } = formatHarvestBankStrip({
    bandai: { ready: 1, running: true, config: { desired: 2 }, sessions: [{ ageSec: 5 }] },
    toymate: { ready: 0, running: false, config: { desired: 2 }, sessions: [] },
    disney: { ready: 0, busy: true, running: true, config: { desired: 1 }, sessions: [] },
  });
  assert.equal(chips.length, 3);
  assert.match(text, /Bandai F5 1\/2 · 5s armed/);
  assert.match(text, /Toymate CF 0\/2 off/);
  assert.match(text, /Disney 0\/1 minting/);
});
