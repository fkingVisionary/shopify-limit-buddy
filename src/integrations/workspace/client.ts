// Browser-only helpers for storing the device token + workspace id.
// SSR-safe: every read/write guards on `typeof window`.

export const TOKEN_KEY = "ws:device-token";
export const WORKSPACE_KEY = "ws:workspace-id";
export const DEVICE_ID_KEY = "ws:device-id";

export function readDeviceToken(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function readWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(WORKSPACE_KEY); } catch { return null; }
}

export function readDeviceId(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(DEVICE_ID_KEY); } catch { return null; }
}

export function savePairing(p: { workspaceId: string; deviceId: string; deviceToken: string }) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(TOKEN_KEY, p.deviceToken);
    localStorage.setItem(WORKSPACE_KEY, p.workspaceId);
    localStorage.setItem(DEVICE_ID_KEY, p.deviceId);
    // Notify same-tab listeners (storage event only fires across tabs).
    window.dispatchEvent(new Event("workspace:pairing-changed"));
  } catch {}
}

export function clearPairing() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(WORKSPACE_KEY);
    localStorage.removeItem(DEVICE_ID_KEY);
    window.dispatchEvent(new Event("workspace:pairing-changed"));
  } catch {}
}

export function isPaired(): boolean {
  return !!readDeviceToken();
}

export function guessDeviceName(): string {
  if (typeof navigator === "undefined") return "Device";
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Linux/i.test(ua)) return "Linux";
  return "Browser";
}
