import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/http';
const mocks = vi.hoisted(() => ({ request: vi.fn(), deviceName: vi.fn() }));
vi.mock('../lib/http', async original => ({ ...(await original<typeof import('../lib/http')>()), request: mocks.request }));
vi.mock('./engine', () => ({ engine: { deviceName: mocks.deviceName } }));
import { claimPairing, pairingCode, pairingPayload, PairingError } from './pairing';
import { pairingQrText } from '../lib/pairingQr';
afterEach(() => vi.resetAllMocks());
const qr = (fields: Record<string, unknown>) => JSON.stringify({ type: 'soundsible_pairing', version: 1, code: 'ABCD2345', ...fields });
it('reads the server and code from the engine QR and from the sheet QR', () => {
  expect(pairingPayload(qr({ claim_url: 'http://192.168.1.4:5005/api/pairing/sessions/claim', player_url: 'http://192.168.1.4:5005/player/' })))
    .toEqual({ origin: 'http://192.168.1.4:5005', code: 'ABCD2345' });
  expect(pairingPayload(pairingQrText('WXYZ6789', undefined, 'https://music.example')!)).toEqual({ origin: 'https://music.example', code: 'WXYZ6789' });
  expect(pairingPayload(qr({ claim_url: null, player_url: 'https://music.example/player/' }))).toEqual({ origin: 'https://music.example', code: 'ABCD2345' });
});
it('refuses anything that could point the app somewhere unintended', () => {
  for (const text of [
    qr({ claim_url: null, player_url: null }),
    qr({ claim_url: 'https://user:pass@music.example/api/pairing/sessions/claim' }),
    qr({ claim_url: 'https://music.example/api/pairing/sessions/claim?next=evil' }),
    qr({ claim_url: 'https://music.example/elsewhere' }),
    qr({ claim_url: 'https://a.example/api/pairing/sessions/claim', player_url: 'https://b.example/player/' }),
    qr({ claim_url: 'javascript:alert(1)//api/pairing/sessions/claim' }),
    qr({ code: 'ABCD-23O5', claim_url: 'https://music.example/api/pairing/sessions/claim' }),
    JSON.stringify({ type: 'other', code: 'ABCD2345', claim_url: 'https://music.example/api/pairing/sessions/claim' }),
    'https://music.example/player/', 'x'.repeat(5000),
  ]) expect(pairingPayload(text)).toBeNull();
});
it('normalises typed codes', () => {
  expect(pairingCode(' abcd-2345 ')).toBe('ABCD2345');
  expect(pairingCode('ABCD234')).toBeNull(); expect(pairingCode('ABCD2O45')).toBeNull();
});
it('claims a full session named after this phone and explains each refusal', async () => {
  mocks.deviceName.mockResolvedValue({ name: 'Pixel 8' });
  mocks.request.mockResolvedValueOnce({ user: { id: 'owner', username: 'owner' } });
  await expect(claimPairing('ABCD2345', new AbortController().signal)).resolves.toMatchObject({ id: 'owner' });
  expect(mocks.request.mock.calls[0][1].body).toEqual({ code: 'ABCD2345', device_name: 'Pixel 8', device_type: 'android', credential: 'session' });
  for (const [failure, reason] of [[new ApiError(404, 'x'), 'invalid'], [new ApiError(409, 'x', 'pairing_display_required'), 'notShowing'],
    [new ApiError(409, 'x'), 'used']] as const) {
    mocks.request.mockRejectedValueOnce(failure);
    await expect(claimPairing('ABCD2345', new AbortController().signal)).rejects.toEqual(new PairingError(reason));
  }
  mocks.request.mockRejectedValueOnce(new ApiError(503, 'x'));
  await expect(claimPairing('ABCD2345', new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
});
