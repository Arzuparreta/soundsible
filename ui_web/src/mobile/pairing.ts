import { ApiError, request } from '../lib/http';
import type { User } from '../lib/session';
import { engine } from './engine';

export interface PairingTarget { origin: string; code: string }
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;

function originOf(value: unknown, suffix: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== suffix) return null;
    return url.origin;
  } catch { return null; }
}

/** Normalises a typed or scanned pairing code; the engine's alphabet has no 0/O/1/I. */
export function pairingCode(value: string): string | null {
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  return CODE.test(code) ? code : null;
}

/** The engine's pairing QR (`qr_text`): only its code and the server it names, nothing else is trusted. */
export function pairingPayload(text: string): PairingTarget | null {
  if (text.length > 4096) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || raw.type !== 'soundsible_pairing' || typeof raw.code !== 'string') return null;
  const code = pairingCode(raw.code);
  const fromClaim = raw.claim_url == null ? null : originOf(raw.claim_url, '/api/pairing/sessions/claim');
  const fromPlayer = raw.player_url == null ? null : originOf(raw.player_url, '/player/');
  if (raw.claim_url != null && !fromClaim || raw.player_url != null && !fromPlayer) return null;
  if (fromClaim && fromPlayer && fromClaim !== fromPlayer) return null;
  const origin = fromClaim ?? fromPlayer;
  return code && origin ? { origin, code } : null;
}

export type PairingFailure = 'invalid' | 'used' | 'notShowing' | 'unavailable';
export class PairingError extends Error { constructor(readonly reason: PairingFailure) { super(reason); } }

/** Claims the code as a sign-in for the account showing it; the session cookie is kept natively, never in JavaScript. */
export async function claimPairing(code: string, signal: AbortSignal): Promise<User> {
  const name = await engine.deviceName().then(value => value.name).catch(() => 'Android');
  try {
    const result = await request<{ user?: User }>('/api/pairing/sessions/claim', { method: 'POST', signal,
      body: { code, device_name: name, device_type: 'android', credential: 'session' } });
    if (!result.user?.id) throw new PairingError('unavailable');
    return result.user;
  } catch (failure) {
    if (failure instanceof PairingError) throw failure;
    if (failure instanceof ApiError && failure.status === 404) throw new PairingError('invalid');
    if (failure instanceof ApiError && failure.status === 409) {
      throw new PairingError(failure.code === 'pairing_display_required' ? 'notShowing' : 'used');
    }
    throw failure;
  }
}
