/** Boot may fail before an account and flight recorder exist. Retain only
 * bounded, URL-free transport outcomes in this tab, including across reloads. */
const KEY = 'soundsible-connection-failures';
interface Failure { atMs: number; error: string; phase: string }
function read(): Failure[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.slice(-8).filter((row): row is Failure =>
      typeof row?.atMs === 'number' && Number.isFinite(row.atMs) && row.phase === 'session'
      && typeof row.error === 'string' && /^[a-zA-Z0-9_]{1,40}$/.test(row.error)) : [];
  } catch { return []; }
}
export function noteConnectionFailure(error: unknown): void {
  const name = error instanceof Error && /^[a-zA-Z0-9_]{1,40}$/.test(error.name) ? error.name : 'Error';
  try { sessionStorage.setItem(KEY, JSON.stringify([...read(), { atMs: Date.now(), phase: 'session', error: name }].slice(-8))); }
  catch { /* Storage refusal must never break connection recovery. */ }
}
export function takeConnectionFailures(): Failure[] {
  const rows = read();
  try { sessionStorage.removeItem(KEY); } catch { /* best effort */ }
  return rows;
}
