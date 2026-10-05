import { createSignal } from 'solid-js';
import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import type { DiscoveryMusicFeed } from '../lib/api';
import { createNativeDiscoveryFeed } from './discoveryFeed';
const song = (id: string): DiscoveryMusicFeed => ({ items: [{ id, title: id, artist: 'Artist', track_id: id }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('aborts and discards a provider response from the previous account even when it ignores abort', async () => {
  const old = deferred<DiscoveryMusicFeed>(), [generation, setGeneration] = createSignal(1);
  const fetchFeed = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(song('new-account'));
  let state!: ReturnType<typeof createNativeDiscoveryFeed>;
  render(() => { state = createNativeDiscoveryFeed({ generation, disconnected: () => false, expanded: () => undefined, known: () => false }, fetchFeed); return null; });
  await waitFor(() => expect(fetchFeed).toHaveBeenCalledTimes(1));
  setGeneration(2);
  await waitFor(() => expect(state.songs()[0]?.title).toBe('new-account'));
  expect(fetchFeed.mock.calls[0][0].aborted).toBe(true);
  old.resolve(song('old-account')); await Promise.resolve();
  expect(state.songs().map(item => item.title)).toEqual(['new-account']);
});
it('keeps the explored section stable during refresh and cancels on disconnection and disposal', async () => {
  const [expanded, setExpanded] = createSignal<string | undefined>(), [disconnected, setDisconnected] = createSignal(false);
  const next = deferred<DiscoveryMusicFeed>();
  const fetchFeed = vi.fn().mockResolvedValueOnce(song('initial')).mockReturnValue(next.promise);
  let state!: ReturnType<typeof createNativeDiscoveryFeed>;
  const view = render(() => { state = createNativeDiscoveryFeed({ generation: () => 1, disconnected, expanded, known: () => false }, fetchFeed); return null; });
  await waitFor(() => expect(state.songs()[0]?.title).toBe('initial'));
  setExpanded('songs'); state.retry(); next.resolve(song('reordered'));
  await waitFor(() => expect(state.loading()).toBe(false));
  expect(state.songs()[0].title).toBe('initial');
  state.retry(); setDisconnected(true);
  expect(fetchFeed.mock.calls.at(-1)![0].aborted).toBe(true);
  expect(state.loading()).toBe(false);
  view.unmount();
});
it('bounds revalidation and surfaces exhaustion instead of polling indefinitely', async () => {
  vi.useFakeTimers();
  const fetchFeed = vi.fn().mockResolvedValue({ ...song('ready'), revalidating: true });
  let state!: ReturnType<typeof createNativeDiscoveryFeed>;
  render(() => { state = createNativeDiscoveryFeed({ generation: () => 1, disconnected: () => false, expanded: () => undefined, known: () => false }, fetchFeed); return null; });
  await vi.advanceTimersByTimeAsync(65000);
  expect(fetchFeed).toHaveBeenCalledTimes(13);
  expect(state.error()).toBe(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(fetchFeed).toHaveBeenCalledTimes(13);
});
