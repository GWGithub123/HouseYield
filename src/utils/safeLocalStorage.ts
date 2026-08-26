/** Best-effort localStorage helpers that never throw into React render. */

export function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalStorage(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    const isQuotaError = error instanceof DOMException
      && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    if (!isQuotaError) return false;

    // Free assistant-owned caches first, then retry once.
    try {
      window.localStorage.removeItem('houseyield:assistant-activity:v1');
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }
}

export function removeLocalStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
