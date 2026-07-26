import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

const { actions, setNowPlayingOpen, state } = vi.hoisted(() => ({
  actions: {
    togglePlay: vi.fn(),
    next: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    stopRadio: vi.fn(),
  },
  setNowPlayingOpen: vi.fn(),
  state: {
    online: true,
    playback: {
      currentTrack: { id: 'track-1', title: 'A track', artist: 'An artist' },
      currentTime: 30,
      duration: 120,
      isPlaying: true,
      isLoading: false,
      loadError: '',
      volume: 0.8,
      muted: false,
      radioMode: true,
      radioLoading: false,
    },
  },
}));

vi.mock('../stores', () => ({ actions, setNowPlayingOpen, state }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));

import { OmniBar } from './OmniBar';

describe('OmniBar interaction structure', () => {
  it('keeps the radio action separate from the expand-player button', () => {
    render(() => <OmniBar />);

    const expand = screen.getByRole('button', { name: /A track/ });
    const radio = screen.getByRole('button', { name: 'nowPlaying.radioActiveAria' });
    expect(expand).not.toContainElement(radio);

    fireEvent.click(expand);
    expect(setNowPlayingOpen).toHaveBeenCalledWith(true);
  });
});
