import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeDownloaderSettings } from './downloaderSettings';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const config = (quality: string, ytdlp = false, curl = false) => ({ quality, auto_update_ytdlp: ytdlp, auto_update_curl_cffi: curl, output_dir: '/srv/music' });
function setup() {
  let state!: ReturnType<typeof createNativeDownloaderSettings>;
  const [identity, setIdentity] = createSignal(1);
  render(() => { state = createNativeDownloaderSettings({ identity, available: () => true }); return null; });
  return { state, setIdentity };
}
it('shows nothing editable until a complete read, and keeps only the documented fields', async () => {
  mocks.request.mockResolvedValueOnce({ quality: 'ultra' }).mockResolvedValueOnce(config('normal'));
  const { state } = setup(); await waitFor(() => expect(state.error()).not.toBe(''));
  expect(state.settings()).toBeUndefined();
  await state.load(); expect(state.settings()).toEqual({ quality: 'normal', autoUpdateYtdlp: false, autoUpdateCurlCffi: false });
});
it('applies a change only once the server stores it, and reports a change it did not keep', async () => {
  mocks.request.mockResolvedValueOnce(config('high')).mockResolvedValueOnce({ status: 'updated' }).mockResolvedValueOnce(config('low'));
  const { state } = setup(); await waitFor(() => expect(state.settings()?.quality).toBe('high'));
  const operation = state.quality('low'); expect(state.settings()?.quality).toBe('high'); await operation;
  expect(state.settings()?.quality).toBe('low'); expect(mocks.request.mock.calls[1][1]).toMatchObject({ method: 'POST', body: { quality: 'low' } });
  mocks.request.mockResolvedValueOnce({ status: 'updated' }).mockResolvedValueOnce(config('low', false));
  await state.toggleYtdlp(); expect(state.settings()?.autoUpdateYtdlp).toBe(false); expect(state.error()).not.toBe('');
});
it('drops a reply that arrives after the account changed', async () => {
  let deliver!: (value: unknown) => void;
  mocks.request.mockReturnValueOnce(new Promise(done => deliver = done)).mockResolvedValue(config('normal'));
  const { state, setIdentity } = setup(); setIdentity(2); deliver(config('low'));
  await waitFor(() => expect(state.settings()?.quality).toBe('normal'));
  expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(true);
});
