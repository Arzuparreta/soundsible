import { createSignal } from 'solid-js';
import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('@solidjs/router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('./trackActions', () => ({ openTrackMenu: vi.fn() }));
vi.mock('./PlaylistPicker', () => ({ openPlaylistPicker: vi.fn() }));
vi.mock('./MetadataEditor', () => ({ openMetadataEditor: vi.fn() }));
vi.mock('./DeviceSheet', () => ({ openPlayOnDevice: vi.fn() }));
vi.mock('../stores', () => ({
  actions: { playFrom: vi.fn() },
  isPlayingTrack: () => false,
}));

import TrackList from './TrackList';
import type { Track } from '../types/music';

// jsdom ships no matchMedia; the list reads it to follow the --row-h token.
// Kept local so the global setup can't hand a stub to the theme tests, which
// install their own.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
}

// jsdom lays nothing out, so every element measures 0×0 — and a virtualizer
// with no viewport renders no rows at all. Give elements the offset size the
// virtualizer measures, so the window it computes is a real one.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });

const track = (id: string, title: string): Track => ({ id, title, artist: 'Artist' }) as Track;

/**
 * The list is virtualized, and the virtualizer reconciles its items by index:
 * a slot that stays on screen keeps the same `{index, start, size}` — and the
 * same row component — when the array behind it changes. So the row has to read
 * its track through the props, never capture it once. This is the whole reason a
 * finished download did not show up in an open library: the store was already
 * correct, the rendered rows were frozen.
 */
describe('TrackList reactivity', () => {
  it('renders a track prepended to an already-mounted list', () => {
    const [tracks, setTracks] = createSignal<Track[]>([track('a', 'Old song')]);
    render(() => <TrackList tracks={tracks()} />);

    expect(screen.getByText('Old song')).toBeInTheDocument();
    expect(screen.queryByText('Fresh download')).toBeNull();

    // What `syncLibrary()` does when a download completes: newest first.
    setTracks((prev) => [track('b', 'Fresh download'), ...prev]);

    expect(screen.getByText('Fresh download')).toBeInTheDocument();
    expect(screen.getByText('Old song')).toBeInTheDocument();
  });

  it('closes the gap when a track is deleted from the middle of the list', () => {
    const [tracks, setTracks] = createSignal<Track[]>([track('a', 'Delete'), track('b', 'Keep')]);
    render(() => <TrackList tracks={tracks()} />);

    expect(screen.getByText('Delete')).toBeInTheDocument();

    setTracks((prev) => prev.filter((t) => t.id !== 'a'));

    expect(screen.queryByText('Delete')).toBeNull();
    expect(screen.getByText('Keep')).toBeInTheDocument();
  });

  it('plays the track that is under the row when it is clicked, not the one that was', async () => {
    const { actions } = await import('../stores');
    const [tracks, setTracks] = createSignal<Track[]>([track('a', 'Old song')]);
    render(() => <TrackList tracks={tracks()} />);

    setTracks((prev) => [track('b', 'Fresh download'), ...prev]);
    screen.getByText('Fresh download').click();

    const [list, index] = vi.mocked(actions.playFrom).mock.calls.at(-1)!;
    expect((list as Track[])[index as number].title).toBe('Fresh download');
  });
});
