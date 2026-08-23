// Storage can throw in restricted contexts, so persistence remains best-effort.

/** Read a stored value, returning null if absent or unavailable. */
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store a value when storage is available. */
export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
  }
}
