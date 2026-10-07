/**
 * Tiny haptic feedback helper. Reads the persisted preference directly (no store
 * import) to stay dependency-free and avoid an import cycle. No-op where the
 * Vibration API is unavailable (desktop, iOS Safari).
 */
let nativeTransport: ((ms: number) => void) | undefined;
/** Native entry supplies feedback; ordinary browsers keep their Vibration API. */
export function installHapticTransport(transport: (ms: number) => void): () => void {
  const previous = nativeTransport; nativeTransport = transport;
  return () => { if (nativeTransport === transport) nativeTransport = previous; };
}

export function vibrate(ms = 10): void {
  try {
    try { if (localStorage.getItem('haptics') === 'off') return; } catch { /* Native session preferences still apply. */ }
    if (nativeTransport) nativeTransport(ms); else navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}
