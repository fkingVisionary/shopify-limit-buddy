const test = require("node:test");
const assert = require("node:assert/strict");
const {
  scanIntegrity,
  integrityGateResult,
  SUSPICIOUS_PROCESS_PATTERNS,
} = require("./integrity-guard.cjs");

test("clean process list does not block", () => {
  const prev = { ...process.env };
  delete process.env.SSLKEYLOGFILE;
  delete process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.ALL_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.all_proxy;
  try {
    const s = scanIntegrity({ processNames: ["chrome.exe", "node.exe", "Vanta Beta.exe"] });
    assert.equal(s.blocked, false);
    assert.equal(integrityGateResult().ok, true);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  }
});

test("HTTP Toolkit process name trips the gate", () => {
  const s = scanIntegrity({ processNames: ["HTTPToolkit.exe", "explorer.exe"] });
  assert.equal(s.blocked, true);
  assert.ok(s.reasons.some((r) => /HTTPToolkit/i.test(r)));
  const gate = integrityGateResult();
  assert.equal(gate.ok, false);
  assert.equal(gate.code, "VANTA_INTEGRITY_BLOCK");
});

test("mitmproxy / fiddler / charles / wireshark patterns match", () => {
  for (const name of ["mitmweb", "Fiddler.Everywhere.exe", "Charles.exe", "Wireshark.exe"]) {
    assert.ok(
      SUSPICIOUS_PROCESS_PATTERNS.some((re) => re.test(name)),
      `expected pattern hit for ${name}`,
    );
  }
});

test("SSLKEYLOGFILE env trips the gate", () => {
  const prev = process.env.SSLKEYLOGFILE;
  process.env.SSLKEYLOGFILE = "C:\\temp\\keys.log";
  try {
    const s = scanIntegrity({ processNames: ["notepad.exe"] });
    assert.equal(s.blocked, true);
    assert.ok(s.reasons.some((r) => /SSLKEYLOGFILE/i.test(r)));
  } finally {
    if (prev == null) delete process.env.SSLKEYLOGFILE;
    else process.env.SSLKEYLOGFILE = prev;
  }
});

test("loopback HTTP_PROXY on toolkit port trips the gate", () => {
  const prev = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://127.0.0.1:8000";
  try {
    const s = scanIntegrity({ processNames: ["notepad.exe"] });
    assert.equal(s.blocked, true);
    assert.ok(s.reasons.some((r) => /HTTP_PROXY|8000/i.test(r)));
  } finally {
    if (prev == null) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = prev;
  }
});
