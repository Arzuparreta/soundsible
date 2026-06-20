/**
 * Tiny haptic feedback helper. Reads the persisted preference directly (no store
 * import) to stay dependency-free and avoid an import cycle. No-op where the
 * Vibration API is unavailable (desktop, iOS Safari).
 */
export function vibrate(ms = 10): void {
  try {
    if (localStorage.getItem('haptics') === 'off') return;
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}
