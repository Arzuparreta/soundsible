import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { actions, setNowPlayingOpen, state } = vi.hoisted(() => ({
  actions: {
    togglePlay: vi.fn(),
    next: vi.fn(),
    autoSkip: vi.fn(),
    enterAutoMode: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    stopRadio: vi.fn(),
  },
  setNowPlayingOpen: vi.fn(),
  state: {
    online: true,
    autoMode: { active: false },
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
  beforeEach(() => {
    state.playback.volume = 0.8;
    state.playback.muted = false;
    actions.setVolume.mockClear();
  });

  it('keeps the radio action separate from the expand-player button', () => {
    render(() => <OmniBar />);

    const expand = screen.getByRole('button', { name: /A track/ });
    const radio = screen.getByRole('button', { name: 'nowPlaying.radioActiveAria' });
    expect(expand).not.toContainElement(radio);

    fireEvent.click(expand);
    expect(setNowPlayingOpen).toHaveBeenCalledWith(true);
  });

  it('names the loading transport as Cancel', () => {
    state.playback.isLoading = true;
    render(() => <OmniBar />);

    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeInTheDocument();
    state.playback.isLoading = false;
  });

  it('exposes the mode without reserving a horizontal control', () => {
    const normal = render(() => <OmniBar />);
    expect(screen.getByRole('button', { name: 'nowPlaying.modeLabel: A track — An artist' })).toBeInTheDocument();
    expect(screen.queryByText('DJ')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'nowPlaying.modeSelector' })).not.toBeInTheDocument();
    normal.unmount();

    state.autoMode.active = true;
    const dj = render(() => <OmniBar />);
    const expand = screen.getByRole('button', { name: 'autoMode.label: A track — An artist' });
    expect(expand).toBeInTheDocument();
    expect(screen.getByText('DJ')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('DJ').closest('button')).toBe(expand);
    dj.unmount();
    state.autoMode.active = false;
  });

  it('maps the volume slider and wheel through the perceptual audio taper', () => {
    state.playback.volume = 0.1;
    render(() => <OmniBar />);

    const slider = screen.getByRole('slider', { name: 'omnibar.volume' });
    expect(slider).toHaveValue('50');
    expect(slider).toHaveAttribute('aria-valuetext', '50%');

    fireEvent.input(slider, { target: { value: '50' } });
    expect(actions.setVolume).toHaveBeenLastCalledWith(expect.closeTo(0.1, 10));

    actions.setVolume.mockClear();
    fireEvent.wheel(slider, { deltaY: -1 });
    expect(actions.setVolume).toHaveBeenCalledWith(expect.closeTo(0.1276447, 6));
  });
});
