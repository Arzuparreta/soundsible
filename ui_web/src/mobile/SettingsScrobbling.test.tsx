import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import NativeSettingsScrobbling from './SettingsScrobbling';

const mocks = vi.hoisted(() => ({ request: vi.fn(), prompt: vi.fn(), confirm: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request, ApiError: class ApiError extends Error {} }));
vi.mock('../lib/prompt', () => ({ promptDialog: mocks.prompt }));
vi.mock('../lib/confirm', () => ({ confirmDialog: mocks.confirm }));

beforeEach(() => { void setLocale('en'); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const disconnected = { services: [{ service: 'listenbrainz', connected: false }, { service: 'lastfm', connected: false, available: false },
  { service: 'maloja', connected: false }], custom_servers: false };
const connected = (username: string) => ({ ...disconnected, services: [{ service: 'listenbrainz', connected: true, enabled: true, username, server: '',
  state: 'ok', pending: 0, last_sent_at: null, error: '' }, ...disconnected.services.slice(1)] });

it('draws the shared settings and connects over the native transport', async () => {
  mocks.request.mockResolvedValueOnce(disconnected).mockResolvedValueOnce(connected('ana'));
  mocks.prompt.mockResolvedValueOnce('lb-token');
  render(() => <NativeSettingsScrobbling identity={() => 1} available={() => true} />);
  await fireEvent.click(await screen.findByRole('button', { name: /Connect ListenBrainz/ }));
  expect(await screen.findByText('Connected as ana')).toBeInTheDocument();
  expect(mocks.request.mock.calls[1][0]).toBe('/api/scrobble/listenbrainz');
  expect(mocks.request.mock.calls[1][1]).toMatchObject({ method: 'PUT', body: { token: 'lb-token', server: '' } });
});

it('never shows one account the services of another', async () => {
  let answerFirst!: (value: unknown) => void;
  mocks.request.mockReturnValueOnce(new Promise(resolve => { answerFirst = resolve; })).mockResolvedValueOnce(disconnected);
  const [identity, setIdentity] = createSignal(1);
  render(() => <NativeSettingsScrobbling identity={identity} available={() => true} />);
  setIdentity(2);  // another account signs in while the first one's status is still on its way
  expect(await screen.findByRole('button', { name: /Connect ListenBrainz/ })).toBeInTheDocument();
  answerFirst(connected('somebody-else'));
  await Promise.resolve();
  expect(screen.queryByText('Connected as somebody-else')).not.toBeInTheDocument();
});

it('reports a failed read and reads again on request', async () => {
  mocks.request.mockRejectedValueOnce(new Error('unreachable')).mockResolvedValueOnce(disconnected);
  render(() => <NativeSettingsScrobbling identity={() => 1} available={() => true} />);
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: /Connect ListenBrainz/ })).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  expect(await screen.findByRole('button', { name: /Connect ListenBrainz/ })).toBeEnabled();
});

it('offers nothing to press while the server is out of reach', async () => {
  mocks.request.mockResolvedValue(disconnected);
  const [available, setAvailable] = createSignal(true);
  render(() => <NativeSettingsScrobbling identity={() => 1} available={available} />);
  await screen.findByRole('button', { name: /Connect ListenBrainz/ });
  setAvailable(false);
  await waitFor(() => expect(screen.queryByRole('button', { name: /Connect ListenBrainz/ })).not.toBeInTheDocument());
  expect(screen.getByRole('status')).toBeInTheDocument();
});
