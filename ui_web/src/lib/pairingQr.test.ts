import { expect, it } from 'vitest';
import { browserPairingOrigin, pairingQrText } from './pairingQr';

const at = (url: string) => { const value = new URL(url); return { protocol: value.protocol, hostname: value.hostname, origin: value.origin }; };
it('uses the address the sheet is open at, except loopback which no phone can reach', () => {
  expect(browserPairingOrigin(at('https://music.example/player/#/settings/devices'))).toBe('https://music.example');
  expect(browserPairingOrigin(at('http://100.64.1.2:5005/player/'))).toBe('http://100.64.1.2:5005');
  for (const loopback of ['http://127.0.0.1:5005/player/', 'http://localhost:5005/', 'http://[::1]:5005/']) expect(browserPairingOrigin(at(loopback))).toBeNull();
  expect(browserPairingOrigin({ protocol: 'capacitor:', hostname: 'localhost', origin: 'capacitor://localhost' })).toBeNull();
});
it('writes the engine format for that address, and falls back to the engine payload without one', () => {
  expect(JSON.parse(pairingQrText('ABCD2345', { qr_text: 'engine' }, 'https://music.example')!)).toEqual({ type: 'soundsible_pairing', version: 1, code: 'ABCD2345',
    claim_url: 'https://music.example/api/pairing/sessions/claim', player_url: 'https://music.example/player/' });
  expect(pairingQrText('ABCD2345', { qr_text: 'engine' }, null)).toBe('engine');
});
