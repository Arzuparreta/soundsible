import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';

const { actions, api, state } = vi.hoisted(() => ({
  actions: {
    seek: vi.fn(),
  },
  api: {
    getTrackLyrics: vi.fn(),
    getLyricsByMetadata: vi.fn(),
  },
  state: {
    library: [] as Track[],
    playback: {
      currentTrack: null as Track | null,
      currentTime: 0,
    },
  },
}));

vi.mock('../stores', () => ({ actions, state }));
vi.mock('../lib/api', () => ({ api }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));

import { LyricsPanel } from './LyricsPanel';

describe('LyricsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = vi.fn();
    const track: Track = { id: 'song', title: 'Song', artist: 'Artist' };
    state.library = [track];
    state.playback.currentTrack = track;
    state.playback.currentTime = 0;
    api.getTrackLyrics.mockResolvedValue({
      synced: '[00:00.00]First line\n[00:05.00]Second line',
      plain: null,
      instrumental: false,
      cached: true,
    });
    api.getLyricsByMetadata.mockResolvedValue({
      synced: null,
      plain: null,
      instrumental: false,
      cached: true,
    });
  });

  it('exposes its scroll owner and keeps synced lines seekable', async () => {
    const scrollRef = vi.fn();
    render(() => <LyricsPanel scrollRef={scrollRef} />);

    const second = await screen.findByRole('button', { name: 'Second line' });
    expect(scrollRef).toHaveBeenCalledWith(expect.any(HTMLDivElement));
    expect(scrollRef.mock.calls[0][0]).toHaveAttribute('data-lyrics-scroll');

    fireEvent.click(second);
    expect(actions.seek).toHaveBeenCalledWith(5);
  });

  it('centres the active line by scrolling its own container, not scrollIntoView', async () => {
    // scrollIntoView walks up to ancestors and does nothing useful inside the
    // fixed, transformed mobile Now Playing sheet — the panel has to move its
    // own scrollTop instead, or synced lyrics sit frozen while the song plays.
    state.playback.currentTime = 25;
    api.getTrackLyrics.mockResolvedValue({
      synced: Array.from({ length: 6 }, (_, i) => `[00:${String(i * 5).padStart(2, '0')}.00]Line ${i}`).join('\n'),
      plain: null,
      instrumental: false,
      cached: true,
    });

    // The mobile panel is laid out only once the cover toggle reveals it, so the
    // resize callback is what re-centres it — jsdom needs the observer stubbed.
    const reveals: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { reveals.push(callback); }
      observe() {}
      disconnect() {}
    });

    let scroller: HTMLDivElement | undefined;
    render(() => <LyricsPanel scrollRef={(element) => { scroller = element; }} />);
    await screen.findByRole('button', { name: 'Line 5' });

    // jsdom has no layout: give the panel a 200px viewport over 400px of lines,
    // each 40px tall, so the centring maths has something real to work with.
    const el = scroller!;
    let scrollTop = 0;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 400 });
    el.getBoundingClientRect = () => ({ top: 0, height: 200 }) as DOMRect;
    for (const line of el.querySelectorAll<HTMLElement>('[data-line]')) {
      const index = Number(line.dataset.line);
      line.getBoundingClientRect = () => ({ top: index * 40 - scrollTop, height: 40 }) as DOMRect;
    }

    // Reveal it. The first placement of a set of lyrics is an instant jump.
    for (const reveal of reveals) reveal();

    // Line 5 sits at 200; centring it in a 200px box lands the scroller at 120.
    expect(scrollTop).toBe(120);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('never asks the lyrics API for a podcast episode', () => {
    state.library = [];
    state.playback.currentTrack = {
      id: 'episode',
      title: 'Episode',
      artist: 'Show',
      media_kind: 'podcast_episode',
      podcast_episode_guid: 'episode-guid',
    };

    render(() => <LyricsPanel />);

    expect(api.getTrackLyrics).not.toHaveBeenCalled();
    expect(api.getLyricsByMetadata).not.toHaveBeenCalled();
  });
});
