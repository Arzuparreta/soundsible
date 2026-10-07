import type { PairingConnect } from './api';

/**
 * The server address a phone should claim a pairing code at.
 *
 * The engine can only suggest a LAN address (or none, when it listens on
 * loopback), which is useless to someone who reaches Soundsible over HTTPS or
 * Tailscale. The address this sheet is being viewed at is the one the owner
 * actually uses, so it wins — except loopback, which no phone can reach.
 */
export function browserPairingOrigin(location: Pick<Location, 'protocol' | 'hostname' | 'origin'> = window.location): string | null {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname)) return null;
  return location.origin;
}

/** The QR text, in the engine's `soundsible_pairing` format, pointing at `origin` when one is known. */
export function pairingQrText(code: string, connect: PairingConnect | undefined, origin: string | null): string | undefined {
  if (!origin) return connect?.qr_text;
  return JSON.stringify({ type: 'soundsible_pairing', version: 1, code,
    claim_url: `${origin}/api/pairing/sessions/claim`, player_url: `${origin}/player/` });
}
