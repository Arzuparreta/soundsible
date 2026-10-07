import { cleanup, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import NativeSettingsLinkStatus from './SettingsLinkStatus';
import { setLocale } from '../lib/i18n';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('clears a measured reading on account change and ignores the prior account response', async () => {
  await setLocale('en');
  let deliver!: (value: unknown) => void;
  mocks.request.mockReturnValueOnce(new Promise(done => deliver = done)).mockResolvedValue({ scope: 'remote', kbps: 2400, samples: 1, measured_at: 1 });
  const [identity, setIdentity] = createSignal(1), [available, setAvailable] = createSignal(true);
  render(() => <NativeSettingsLinkStatus identity={identity} available={available} />);
  setIdentity(2); deliver({ scope: 'local', kbps: 9000, samples: 1, measured_at: 1 });
  await waitFor(() => expect(screen.getByText(/2\.4/)).toBeVisible());
  expect(screen.queryByText(/9\.0/)).toBeNull(); expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(true);
  setAvailable(false); expect(screen.queryByText(/2\.4/)).toBeNull(); expect(mocks.request).toHaveBeenCalledTimes(2);
});
it('retains an unknown diagnostic if the engine cannot measure or returns an invalid reading', async () => {
  await setLocale('en'); mocks.request.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce({ scope: 'invented', kbps: 9000 });
  const [identity, setIdentity] = createSignal(1);
  render(() => <NativeSettingsLinkStatus identity={identity} available={() => true} />);
  await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce()); setIdentity(2);
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2)); expect(screen.queryByText(/9\.0/)).toBeNull();
});
