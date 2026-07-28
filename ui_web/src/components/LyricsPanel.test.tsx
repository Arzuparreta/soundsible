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
