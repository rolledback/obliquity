// localStorage access that never throws. Some contexts (private mode, sandboxed iframes)
// deny storage and raise on access, so every read and write is guarded; persistence is a
// best-effort nicety, never a hard requirement.

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable; skip persistence */
  }
}
