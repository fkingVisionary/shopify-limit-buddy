// Seed node-tls-client's shared library into os.tmpdir() before initTLS().
//
// LibraryHandler.validateFile() downloads from api.github.com when the .so is
// missing; on Fly that often 403s, then the package calls process.exit(1) with
// no thrown error — which looks like "tls-worker exited code=1" and forces the
// undici fallback (Akamai _abck plateau). Dockerfile bakes the linux-x64 .so
// into /app/vendor; this helper copies it into TMPDIR for the worker/parent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor");

function nativeFileName() {
  if (process.platform === "linux" && process.arch === "x64") return "tls-client-x64.so";
  if (process.platform === "linux" && process.arch === "arm64") return "tls-client-arm64.so";
  if (process.platform === "darwin" && process.arch === "arm64") return "tls-client-arm64.dylib";
  if (process.platform === "darwin" && process.arch === "x64") return "tls-client-x86.dylib";
  return null;
}

/** @returns {{ ok: boolean, seeded: boolean, note: string, dest?: string }} */
export function ensureTlsNativeLib() {
  const name = nativeFileName();
  if (!name) {
    return { ok: true, seeded: false, note: `no vendor seed for ${process.platform}/${process.arch}` };
  }
  const dest = path.join(os.tmpdir(), name);
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
      return { ok: true, seeded: false, note: `native present ${dest}`, dest };
    }
  } catch {
    /* continue to seed */
  }

  const vendor = path.join(VENDOR_DIR, name);
  if (!fs.existsSync(vendor)) {
    return {
      ok: false,
      seeded: false,
      note: `vendor missing (${vendor}); node-tls-client may process.exit(1) if GitHub download fails`,
      dest,
    };
  }

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(vendor, dest);
    fs.chmodSync(dest, 0o755);
    return { ok: true, seeded: true, note: `seeded ${name} → ${dest}`, dest };
  } catch (e) {
    return {
      ok: false,
      seeded: false,
      note: `seed failed: ${e?.message ?? e}`,
      dest,
    };
  }
}
