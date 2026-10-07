import { createSignal } from 'solid-js';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, expect, it, vi } from 'vitest';
import { OverlayOutlet } from '../lib/overlay';
import { openNativeLyrics } from './Lyrics';
import type { ProgramState } from '../lib/program/runtime';
import { api } from '../lib/api';
vi.mock('../lib/api', () => ({ api: { getTrackLyrics: vi.fn(), getLyricsByMetadata: vi.fn() } }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const state: ProgramState = { generation: 1, sequence: 1, ready: true, playing: false, playWhenReady: false, errorKind: '', state: 3, index: 0, id: 'song', title: 'Song', artist: 'Artist', items: [{ key: 'one', id: 'song', title: 'Song', artist: 'Artist', source: 'local' }], queueToken: 'q', queue: ['song'], positionMs: 0, durationMs: 600000, error: 0, errorStatus: 0, shuffle: false, repeat: 0, hasNext: false, hasPrevious: false };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.getTrackLyrics).mockResolvedValue({ status: 'ready', synced: '[00:00.00]First line\n[00:20.00]Second line', plain: null, instrumental: false, cached: true }); });
it('reads native position without repeated lookups and sends line seeks only to native output', async () => {
  const [program, setProgram] = createSignal(state); const execute = vi.fn(async () => {});
  render(() => <OverlayOutlet />);
  const close = openNativeLyrics(program, () => [{ id: 'song', title: 'Song', artist: 'Artist', duration: 600 }], () => [], () => true, execute);
  try {
    await screen.findByText('Second line');
    setProgram({ ...state, positionMs: 21000 });
    await waitFor(() => expect(document.querySelector('[data-line="1"]')).toHaveAttribute('aria-current', 'true'));
    fireEvent.click(screen.getByText('Second line'));
    expect(execute).toHaveBeenCalledWith({ action: 'seek', positionMs: 20000 });
    expect(api.getTrackLyrics).toHaveBeenCalledOnce();
    expect(document.querySelector('audio')).toBeNull();
  } finally { close?.(); }
});
it('closes and aborts a pending lookup when the account is replaced', async () => {
  vi.mocked(api.getTrackLyrics).mockImplementation(() => new Promise(() => {}));
  const [current, setCurrent] = createSignal(true);
  render(() => <OverlayOutlet />);
  openNativeLyrics(() => state, () => [{ id: 'song', title: 'Song', artist: 'Artist' }], () => [], current, vi.fn(async () => {}));
  await waitFor(() => expect(api.getTrackLyrics).toHaveBeenCalledOnce());
  const signal = vi.mocked(api.getTrackLyrics).mock.calls[0][1]?.signal;
  setCurrent(false);
  await waitFor(() => expect(document.querySelector('[data-native-lyrics]')).toBeNull());
  expect(signal?.aborted).toBe(true);
});

it('uses metadata lookup for a saved preview rather than treating its browse row as acquired music', async () => {
  vi.mocked(api.getLyricsByMetadata).mockResolvedValue({ status: 'ready', synced: null, plain: 'Preview words', instrumental: false, cached: true });
  const preview = { ...state, id: 'B1111111111', items: [{ ...state.items[0], id: 'B1111111111', source: 'preview' as const }] };
  render(() => <OverlayOutlet />);
  const close = openNativeLyrics(() => preview, () => [{ id: 'B1111111111', title: 'Song', artist: 'Artist', source: 'preview', playback_source_kind: 'unverified' }], () => [{ keys: ['yt:B1111111111'], title: 'Song', artist: 'Artist' }], () => true, vi.fn(async () => {}));
  try {
    await screen.findByText('Preview words');
    expect(api.getTrackLyrics).not.toHaveBeenCalled();
    expect(api.getLyricsByMetadata).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'B1111111111', sourceKind: 'unverified', persist: true }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  } finally { close?.(); }
});
