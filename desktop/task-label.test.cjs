const test = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultTaskLabel,
  resolveTaskLabel,
  taskSubline,
  taskStoreModeLabel,
  extractSku,
  DEFAULT_LABEL_TEMPLATE,
} = require("./task-label.cjs");

test("extractSku prefers watch sku over URL", () => {
  assert.equal(
    extractSku({
      bandaiWatchSku: "N2847890001",
      pdpUrl: "https://p-bandai.com/au/item/N999",
    }),
    "N2847890001",
  );
});

test("defaultTaskLabel is SKU · title", () => {
  assert.equal(
    defaultTaskLabel({
      store: "bandai",
      bandaiWatchSku: "N2847890001",
      title: "RG Gundam",
      bandaiMode: "checkout",
    }),
    "N2847890001 · RG Gundam",
  );
});

test("resolveTaskLabel keeps custom labels", () => {
  assert.equal(
    resolveTaskLabel({ label: "My drop", bandaiWatchSku: "N1" }),
    "My drop",
  );
  assert.equal(
    resolveTaskLabel({ label: "Task", bandaiWatchSku: "N2847890001" }),
    "N2847890001",
  );
});

test("taskStoreModeLabel uses Autocheckout wording", () => {
  assert.match(
    taskStoreModeLabel({ store: "bandai", bandaiMode: "checkout", bandaiCheckoutMode: "fast" }),
    /Bandai · Autocheckout · fast/,
  );
});

test("taskSubline falls back to sku", () => {
  assert.equal(taskSubline({ bandaiWatchSku: "N2847890001" }), "N2847890001");
});

test("DEFAULT_LABEL_TEMPLATE is product-first", () => {
  assert.equal(DEFAULT_LABEL_TEMPLATE, "{{sku}} · {{title}}");
});
