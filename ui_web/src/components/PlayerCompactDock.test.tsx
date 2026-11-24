import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlayerCompact } from '../lib/playerDock';

const harness = vi.hoisted(() => ({
  actions: {
    startRadio: vi.fn(),
    toggleMute: vi.fn(),
    setVolume: vi.fn(),
  },
  mobileWeb: false,
  setState: undefined as undefined | ((...args: unknown[]) => void),
}));

vi.mock('../stores', async () => {
  const { createStore } = await vi.importActual<typeof import('solid-js/store')>('solid-js/store');
  const [state, setState] = createStore({
    playback: {
      currentTrack: { id: 'track-1', title: 'Track', artist: 'Artist' } as {
        id: string;
        title: string;
        artist: string;
        podcast_guid?: string;
      } | null,
      volume: 0.8,
      muted: false,
      radioMode: false,
      radioLoading: false,
    },
  });
  harness.setState = setState as unknown as (...args: unknown[]) => void;
  return {
    actions: harness.actions,
    state,
  };
});
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('../lib/deviceIdentity', () => ({ isMobileWeb: () => harness.mobileWeb }));
vi.mock('../lib/track', () => ({
  PODCAST_SKIP_SECONDS: 15,
  isPodcastTrack: (track: { podcast_guid?: string }) => Boolean(track.podcast_guid),
}));
vi.mock('./RadioBadge', () => ({ onStopRadio: vi.fn() }));

import { PlayerCompactDock } from './PlayerCompactDock';
import styles from './PlayerCompactDock.module.css';

beforeEach(() => {
  setPlayerCompact(true);
  harness.mobileWeb = false;
  harness.setState?.('playback', {
    currentTrack: { id: 'track-1', title: 'Track', artist: 'Artist' },
    volume: 0.8,
    muted: false,
    radioMode: false,
    radioLoading: false,
  });
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  setPlayerCompact(false);
});

function renderDock(overrides: Partial<Parameters<typeof PlayerCompactDock>[0]> = {}) {
  return render(() => (
    <PlayerCompactDock
      auto={false}
      lyricsActive={false}
      listActive={false}
      listCount={0}
      surfaceOpen
      onToggleLyrics={vi.fn()}
      onToggleList={vi.fn()}
      {...overrides}
    />
  ));
}

function openDesktopPopover(volumeButton: HTMLElement) {
  const enter = new Event('pointerenter', { bubbles: true });
  Object.defineProperty(enter, 'pointerType', { value: 'mouse' });
  volumeButton.dispatchEvent(enter);
}

describe('PlayerCompactDock', () => {
  it('keeps the Lyrics accessible name stable across active and inactive states', () => {
    const first = renderDock({ lyricsActive: false });
    const inactive = screen.getByRole('button', { name: 'nowPlaying.lyricsLabel' });
    expect(inactive).toHaveAttribute('aria-pressed', 'false');
    expect(inactive).toHaveAttribute('title', 'nowPlaying.showLyrics');
    first.unmount();

    renderDock({ lyricsActive: true });
    const active = screen.getByRole('button', { name: 'nowPlaying.lyricsLabel' });
    expect(active).toHaveAttribute('aria-pressed', 'true');
    expect(active).toHaveAttribute('title', 'nowPlaying.showCover');
    expect(screen.queryByRole('button', { name: 'nowPlaying.showCover' })).toBeNull();
  });

  it('opens the desktop volume popover on hover/Tab, scopes scroll, and lets external text inputs keep Escape', async () => {
    const siblingScroller = document.createElement('div');
    const externalInput = document.createElement('input');
    externalInput.type = 'search';
    document.body.append(siblingScroller, externalInput);
    try {
      renderDock();
      const volumeButton = screen.getByRole('button', { name: 'omnibar.volume' });
      expect(volumeButton).toHaveAttribute('aria-expanded', 'false');

      openDesktopPopover(volumeButton);
      const slider = await screen.findByRole('slider', { name: 'omnibar.volume' });
      expect(volumeButton).toHaveAttribute('aria-expanded', 'true');

      fireEvent.keyDown(volumeButton, { key: 'Tab' });
      expect(slider).toHaveFocus();

      siblingScroller.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      expect(screen.getByRole('slider', { name: 'omnibar.volume' })).toBeInTheDocument();
      expect(slider).toHaveFocus();

      const onSliderEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      slider.dispatchEvent(onSliderEscape);
      expect(onSliderEscape.defaultPrevented).toBe(true);
      expect(screen.queryByRole('slider', { name: 'omnibar.volume' })).toBeNull();
      expect(volumeButton).toHaveFocus();

      // Ancestor scroll dismisses and restores trigger focus.
      openDesktopPopover(volumeButton);
      const sliderAgain = await screen.findByRole('slider', { name: 'omnibar.volume' });
      sliderAgain.focus();
      document.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      expect(screen.queryByRole('slider', { name: 'omnibar.volume' })).toBeNull();
      expect(volumeButton).toHaveFocus();

      // Hover-opened popover while typing outside closes passively without stealing Escape.
      openDesktopPopover(volumeButton);
      await screen.findByRole('slider', { name: 'omnibar.volume' });
      externalInput.focus();
      const externalEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      externalInput.dispatchEvent(externalEscape);
      expect(externalEscape.defaultPrevented).toBe(false);
      expect(screen.queryByRole('slider', { name: 'omnibar.volume' })).toBeNull();
      expect(externalInput).toHaveFocus();
    } finally {
      siblingScroller.remove();
      externalInput.remove();
    }
  });

  it('acts as a direct mute toggle on mobile web and keeps Mute at volume 0', () => {
    harness.mobileWeb = true;
    harness.setState?.('playback', 'volume', 0);
    harness.setState?.('playback', 'muted', false);

    const zeroUnmuted = renderDock();
    const muteBtn = screen.getByRole('button', { name: 'omnibar.mute' });
    expect(muteBtn).toHaveAttribute('aria-pressed', 'false');
    expect(muteBtn).not.toHaveClass(styles.dockIconOn);
    fireEvent.click(muteBtn);
    expect(harness.actions.toggleMute).toHaveBeenCalledOnce();
    expect(screen.queryByRole('slider', { name: 'omnibar.volume' })).toBeNull();
    zeroUnmuted.unmount();

    harness.setState?.('playback', 'muted', true);
    renderDock();
    const unmuteBtn = screen.getByRole('button', { name: 'omnibar.unmute' });
    expect(unmuteBtn).toHaveAttribute('aria-pressed', 'true');
    expect(unmuteBtn).toHaveClass(styles.dockIconOn);
  });

  it('hides Lyrics and Radio for podcasts and shows Route count in DJ mode', () => {
    harness.setState?.('playback', 'currentTrack', {
      id: 'ep-1',
      title: 'Episode',
      artist: 'Show',
      podcast_guid: 'guid-1',
    });
    const podcastView = renderDock();
    expect(screen.queryByRole('button', { name: 'nowPlaying.lyricsLabel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'trackActions.startRadio' })).toBeNull();
    expect(screen.getByRole('button', { name: 'nowPlaying.panel.queue' })).toBeInTheDocument();
    podcastView.unmount();

    harness.setState?.('playback', 'currentTrack', { id: 'track-1', title: 'Track', artist: 'Artist' });
    renderDock({ auto: true, listCount: 4 });
    expect(screen.getByRole('button', { name: 'autoMode.panel.route' })).toHaveTextContent('4');
    expect(screen.queryByRole('button', { name: 'trackActions.startRadio' })).toBeNull();
  });
});
