import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';
import { installPageVisibility } from '../lib/pageVisibility';

const { actions, api, state } = vi.hoisted(() => ({
  actions: {
    seek: vi.fn(),
  },
  api: {
    getTrackLyrics: vi.fn(),
    getLyricsByMetadata: vi.fn(),
    setLyricsOffset: vi.fn(),
  },
  state: {
    library: [] as Track[],
    saved: [] as Array<{ keys: string[]; title: string; artist?: string }>,
    playback: {
      currentTrack: null as Track | null,
      currentTime: 0,
      duration: 0,
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
    state.saved = [];
    state.playback.currentTrack = track;
    state.playback.currentTime = 0;
    state.playback.duration = 0;
    api.setLyricsOffset.mockResolvedValue({ offset_ms: null });
    api.getTrackLyrics.mockResolvedValue({
      status: 'ready',
      synced: '[00:00.00]First line\n[00:05.00]Second line',
      plain: null,
      instrumental: false,
      cached: true,
    });
    api.getLyricsByMetadata.mockResolvedValue({
      status: 'not_found',
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

  it('does not seek when a touch on a lyric line becomes a scroll', async () => {
    render(() => <LyricsPanel />);

    const second = await screen.findByRole('button', { name: 'Second line' });
    fireEvent.pointerDown(second, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 20,
      clientY: 30,
    });
    fireEvent.pointerMove(second, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 20,
      clientY: 50,
    });
    fireEvent.pointerUp(second, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 20,
      clientY: 50,
    });

    expect(actions.seek).not.toHaveBeenCalled();
  });

  it('centres the active line by scrolling its own container, not scrollIntoView', async () => {
    // scrollIntoView walks up to ancestors and does nothing useful inside the
    // fixed, transformed mobile Now Playing sheet — the panel has to move its
    // own scrollTop instead, or synced lyrics sit frozen while the song plays.
    state.playback.currentTime = 25;
    api.getTrackLyrics.mockResolvedValue({
      status: 'ready',
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
    let visibility: DocumentVisibilityState = 'hidden';
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const stop = installPageVisibility();
    try {
      scrollTop = 0;
      state.playback.currentTime = 15;
      for (const reveal of reveals) reveal();
      expect(scrollTop).toBe(0);
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      // Catch up to line 3 immediately, without restarting an old scroll tween.
      expect(scrollTop).toBe(40);
    } finally {
      stop();
      visible.mockRestore();
    }
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

  it('persists metadata lyrics when the streaming song is saved', async () => {
    state.library = [];
    state.saved = [{ keys: ['yt:song'], title: 'Song', artist: 'Artist' }];
    state.playback.currentTrack = {
      id: 'song',
      title: 'Song',
      artist: 'Artist',
      source: 'preview',
    };

    render(() => <LyricsPanel />);

    await screen.findByText('lyricsPanel.notFound');
    expect(api.getLyricsByMetadata).toHaveBeenCalledWith(expect.objectContaining({
      artist: 'Artist',
      title: 'Song',
      persist: true,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('reports a provider outage honestly and lets the listener retry', async () => {
    state.library = [];
    state.playback.currentTrack = {
      id: 'song',
      title: 'Song',
      artist: 'Artist',
      source: 'preview',
    };
    api.getLyricsByMetadata.mockResolvedValue({
      status: 'unavailable',
      synced: null,
      plain: null,
      instrumental: false,
      cached: false,
      pending: false,
    });

    render(() => <LyricsPanel />);

    expect(await screen.findByText('lyricsPanel.unavailable')).toBeInTheDocument();
    expect(screen.queryByText('lyricsPanel.notFound')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'lyricsPanel.retry' }));
    await vi.waitFor(() => expect(api.getLyricsByMetadata).toHaveBeenCalledTimes(2));
  });

  describe('timing', () => {
    const timed = (extra: Record<string, unknown>) => api.getTrackLyrics.mockResolvedValue({
      status: 'ready',
      synced: '[00:00.00]First line\n[00:05.00]Second line',
      plain: null,
      instrumental: false,
      cached: true,
      ...extra,
    });

    it('asks for a tap instead of following lines timed for another cut', async () => {
      timed({ timing_safe: false, synced_duration: 236 });
      state.playback.currentTime = 21;
      render(() => <LyricsPanel />);

      expect(await screen.findByText('lyricsPanel.alignHint')).toBeInTheDocument();
      const second = screen.getByRole('button', { name: 'Second line' });
      expect(second).not.toHaveAttribute('aria-current');

      // Heard at 21 s, timed at 5 s: the lines sit 16 s later, less the tap's reaction.
      fireEvent.click(second);
      expect(actions.seek).not.toHaveBeenCalled();
      expect(api.setLyricsOffset).toHaveBeenCalledWith({ trackId: 'song', offsetMs: 15_750 });
      expect(screen.queryByText('lyricsPanel.alignHint')).not.toBeInTheDocument();
      expect(second).toHaveAttribute('aria-current', 'true');
    });

    it('follows a saved offset, for highlighting and for seeking', async () => {
      timed({ timing_safe: false, synced_duration: 236, offset_ms: 16_000 });
      state.playback.currentTime = 17;
      render(() => <LyricsPanel />);

      const first = await screen.findByRole('button', { name: 'First line' });
      expect(first).toHaveAttribute('aria-current', 'true');
      expect(screen.queryByText('lyricsPanel.alignHint')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Second line' }));
      expect(actions.seek).toHaveBeenCalledWith(21);
    });

    it('doubts the timing when the audio playing is longer than the lines were timed for', async () => {
      timed({ timing_safe: true, synced_duration: 236 });
      state.playback.duration = 251;
      render(() => <LyricsPanel />);
      expect(await screen.findByText('lyricsPanel.alignHint')).toBeInTheDocument();
    });

    it('lets the listener re-align lines that do follow, and back out', async () => {
      timed({ timing_safe: true, synced_duration: 236 });
      state.playback.duration = 236;
      render(() => <LyricsPanel />);

      fireEvent.click(await screen.findByRole('button', { name: 'lyricsPanel.adjust' }));
      expect(screen.getByText('lyricsPanel.adjustHint')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'lyricsPanel.cancelAdjust' }));
      expect(screen.queryByText('lyricsPanel.adjustHint')).not.toBeInTheDocument();
      expect(api.setLyricsOffset).not.toHaveBeenCalled();
    });

    it('keeps the old timing when the new one cannot be saved', async () => {
      timed({ timing_safe: false, synced_duration: 236 });
      api.setLyricsOffset.mockRejectedValueOnce(new Error('offline'));
      state.playback.currentTime = 21;
      render(() => <LyricsPanel />);

      fireEvent.click(await screen.findByRole('button', { name: 'Second line' }));
      expect(await screen.findByText('lyricsPanel.alignHint')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Second line' })).not.toHaveAttribute('aria-current');
    });

    it('sends timing saves in order, and an older failure never undoes a newer one', async () => {
      timed({ timing_safe: false, synced_duration: 236 });
      let failFirst!: (error: Error) => void;
      api.setLyricsOffset
        .mockImplementationOnce(() => new Promise((_, reject) => { failFirst = reject; }))
        .mockResolvedValueOnce({ offset_ms: 2_750 });
      state.playback.currentTime = 21;
      render(() => <LyricsPanel />);

      fireEvent.click(await screen.findByRole('button', { name: 'Second line' }));
      fireEvent.click(screen.getByRole('button', { name: 'lyricsPanel.adjust' }));
      state.playback.currentTime = 8;
      fireEvent.click(screen.getByRole('button', { name: 'Second line' }));
      // The second save waits for the first to settle.
      expect(api.setLyricsOffset).toHaveBeenCalledTimes(1);

      failFirst(new Error('offline'));
      await vi.waitFor(() => expect(api.setLyricsOffset).toHaveBeenCalledTimes(2));
      expect(api.setLyricsOffset).toHaveBeenLastCalledWith({ trackId: 'song', offsetMs: 2_750 });
      expect(screen.queryByText('lyricsPanel.alignHint')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Second line' })).toHaveAttribute('aria-current', 'true');
    });

    it('forgets a saved offset on request', async () => {
      timed({ timing_safe: true, synced_duration: 236, offset_ms: 2_000 });
      render(() => <LyricsPanel />);

      fireEvent.click(await screen.findByRole('button', { name: 'lyricsPanel.adjust' }));
      fireEvent.click(screen.getByRole('button', { name: 'lyricsPanel.resetTiming' }));
      expect(api.setLyricsOffset).toHaveBeenCalledWith({ trackId: 'song', offsetMs: null });
    });
  });
});
