const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { resolveExecutorDir, resolveNodeBinary } = require("./paths.cjs");

test("resolveExecutorDir finds repo executor in unpackaged layout", () => {
  const dir = resolveExecutorDir();
  assert.ok(fs.existsSync(path.join(dir, "server.js")), `server.js in ${dir}`);
  assert.match(dir.replace(/\\/g, "/"), /executor$/);
});

test("resolveNodeBinary returns a usable default off Windows packaging", () => {
  const bin = resolveNodeBinary();
  assert.ok(bin === "node" || bin === "node.exe" || fs.existsSync(bin));
});

test("resolveExecutorDir honors J1MS_EXECUTOR_DIR", () => {
  const real = resolveExecutorDir();
  const prev = process.env.J1MS_EXECUTOR_DIR;
  process.env.J1MS_EXECUTOR_DIR = real;
  try {
    assert.equal(path.resolve(resolveExecutorDir()), path.resolve(real));
  } finally {
    if (prev == null) delete process.env.J1MS_EXECUTOR_DIR;
    else process.env.J1MS_EXECUTOR_DIR = prev;
  }
});
