// Mirrors `aio:*` localStorage keys to the workspace's app_settings blob.
// Strategy:
//   1. On mount: pull cloud → if cloud has data, overwrite local; if cloud is
//      empty, push local → cloud (first-device migration).
//   2. Listen to `storage` and a same-tab "aio:changed" event; debounce + push.
//   3. Poll cloud every 15s to pick up changes from other devices.
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { loadSync, saveSync } from "@/lib/sync.functions";
import { isPaired } from "@/integrations/workspace/client";

const PREFIX = "aio:";
// Keys we never sync — kept device-local (e.g. card numbers if ever added).
const LOCAL_ONLY = (key: string) =>
  /card|cvv|cc[-_]?num/i.test(key);

function readAllAio(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(PREFIX) || LOCAL_ONLY(k)) continue;
    const v = localStorage.getItem(k);
    if (v != null) out[k] = v;
  }
  return out;
}

function writeAllAio(data: Record<string, string>) {
  if (typeof window === "undefined") return;
  // Remove cloud-absent aio:* keys (so deletes propagate). Skip LOCAL_ONLY.
  const incoming = new Set(Object.keys(data));
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(PREFIX) || LOCAL_ONLY(k)) continue;
    if (!incoming.has(k)) toRemove.push(k);
  }
  toRemove.forEach((k) => localStorage.removeItem(k));
  for (const [k, v] of Object.entries(data)) {
    if (LOCAL_ONLY(k)) continue;
    if (localStorage.getItem(k) !== v) localStorage.setItem(k, v);
  }
  window.dispatchEvent(new Event("aio:cloud-applied"));
}

function snapshotEqual(a: Record<string, string>, b: Record<string, string>) {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

export function useCloudSync() {
  const loadFn = useServerFn(loadSync);
  const saveFn = useServerFn(saveSync);
  const lastSnapshot = useRef<Record<string, string>>({});
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyingRef = useRef(false);
  const [paired, setPaired] = useState<boolean>(() => isPaired());

  useEffect(() => {
    const check = () => setPaired(isPaired());
    window.addEventListener("workspace:pairing-changed", check);
    window.addEventListener("storage", check);
    return () => {
      window.removeEventListener("workspace:pairing-changed", check);
      window.removeEventListener("storage", check);
    };
  }, []);

  useEffect(() => {
    if (!paired) return;
    let cancelled = false;

    const pull = async () => {
      try {
        const r = await loadFn();
        if (cancelled) return;
        const local = readAllAio();
        if (Object.keys(r.data).length === 0 && Object.keys(local).length > 0) {
          // First-device migration: push local → cloud.
          await saveFn({ data: { data: local } });
          lastSnapshot.current = local;
        } else if (!snapshotEqual(r.data, local)) {
          applyingRef.current = true;
          writeAllAio(r.data);
          lastSnapshot.current = r.data;
          // Give the storage event a tick to fire before re-arming push.
          setTimeout(() => { applyingRef.current = false; }, 50);
        } else {
          lastSnapshot.current = local;
        }
      } catch (e) {
        console.warn("[cloud-sync] pull failed:", e);
      }
    };

    const schedulePush = () => {
      if (applyingRef.current) return;
      if (pushTimer.current) clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(async () => {
        const snap = readAllAio();
        if (snapshotEqual(snap, lastSnapshot.current)) return;
        try {
          await saveFn({ data: { data: snap } });
          lastSnapshot.current = snap;
        } catch (e) {
          console.warn("[cloud-sync] push failed:", e);
        }
      }, 1200);
    };

    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith(PREFIX)) return;
      schedulePush();
    };
    const onSameTab = () => schedulePush();

    // Wrap localStorage.setItem / removeItem to emit a same-tab event so we
    // catch writes made by this tab (the `storage` event only fires on other tabs).
    const w = window as typeof window & { __aioSyncPatched?: boolean };
    if (!w.__aioSyncPatched) {
      w.__aioSyncPatched = true;
      const origSet = localStorage.setItem.bind(localStorage);
      const origRemove = localStorage.removeItem.bind(localStorage);
      localStorage.setItem = (k: string, v: string) => {
        origSet(k, v);
        if (k.startsWith(PREFIX)) window.dispatchEvent(new Event("aio:changed"));
      };
      localStorage.removeItem = (k: string) => {
        origRemove(k);
        if (k.startsWith(PREFIX)) window.dispatchEvent(new Event("aio:changed"));
      };
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("aio:changed", onSameTab);

    void pull();
    const pollId = setInterval(() => { void pull(); }, 15000);

    return () => {
      cancelled = true;
      clearInterval(pollId);
      if (pushTimer.current) clearTimeout(pushTimer.current);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("aio:changed", onSameTab);
    };
  }, [loadFn, saveFn]);
}
