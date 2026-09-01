import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createResource, Suspense } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { actions, state } = vi.hoisted(() => ({
  actions: {
    autoSkip: vi.fn(), cycleRepeat: vi.fn(), next: vi.fn(), prev: vi.fn(),
    seek: vi.fn(), setVolume: vi.fn(), startRadio: vi.fn(), toggleMute: vi.fn(),
    togglePlay: vi.fn(), toggleShuffle: vi.fn(),
  },
  state: {
    library: [],
    saved: [],
    playback: {
      currentTrack: { id: 'track-1', title: 'Still visible', artist: 'Artist', source: 'preview' as const },
      currentTime: 0,
      duration: 180,
      isLoading: false,
      loadError: false,
      isPlaying: true,
      muted: false,
      volume: 0.8,
      queue: [{ id: 'track-1' }],
      radioMode: false,
      radioLoading: false,
      repeat: 'off' as const,
      shuffle: false,
    },
  },
}));

vi.mock('@solidjs/router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../stores', () => ({ actions, state, isSavedTrack: () => false }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('./CollectionButton', () => ({ CollectionButton: () => null }));
vi.mock('./FavouriteButton', () => ({ FavouriteButton: () => null }));
vi.mock('./RadioBadge', () => ({ RadioBadge: () => null, onStopRadio: vi.fn() }));
vi.mock('./trackActions', () => ({ buildTrackMenu: () => [], openTrackMenu: vi.fn() }));
vi.mock('./ActionMenu', () => ({ openActionMenu: vi.fn() }));
vi.mock('./LyricsPanel', () => ({
  LyricsPanel: () => {
    const [pending] = createResource(() => new Promise<string>(() => {}));
    return <div>{pending()}</div>;
  },
}));

import { PlayerStage } from './PlayerStage';

afterEach(() => localStorage.clear());

describe('PlayerStage lyrics transition', () => {
  it('keeps the stage mounted while lyrics are still loading inside Auto', () => {
    render(() => (
      <Suspense fallback={<div data-testid="auto-fallback" />}>
        <PlayerStage mode="auto" surfaceOpen />
      </Suspense>
    ));

    const toggles = screen.getAllByRole('button', { name: 'nowPlaying.showLyrics' });
    fireEvent.click(toggles[toggles.length - 1]);

    expect(screen.queryByTestId('auto-fallback')).not.toBeInTheDocument();
    expect(screen.getByText('Still visible')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'lyricsPanel.loading' })).toBeInTheDocument();
  });

  it('uses perceptual position while sending linear gain to playback', () => {
    state.playback.volume = 0.1;
    actions.setVolume.mockClear();
    render(() => <PlayerStage mode="now-playing" surfaceOpen />);

    const slider = screen.getByRole('slider', { name: 'omnibar.volume' });
    expect(slider).toHaveValue('50');
    expect(slider).toHaveAttribute('aria-valuetext', '50%');

    fireEvent.input(slider, { target: { value: '50' } });
    expect(actions.setVolume).toHaveBeenCalledWith(expect.closeTo(0.1, 10));
  });
});
