import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  actions: {
    enterAutoMode: vi.fn(),
    exitAutoMode: vi.fn(),
  },
  setOpen: undefined as undefined | ((open: boolean) => void),
  setState: undefined as undefined | ((...args: unknown[]) => void),
  setBrowserOpen: undefined as undefined | ((open: boolean) => void),
  openBrowser: vi.fn(),
  toggleBrowser: vi.fn(),
  mobileViewport: false,
}));

vi.mock('../stores', async () => {
  const { createSignal } = await vi.importActual<typeof import('solid-js')>('solid-js');
  const { createStore } = await vi.importActual<typeof import('solid-js/store')>('solid-js/store');
  const [open, setOpen] = createSignal(true);
  const [state, setState] = createStore({
    playback: {
      currentTrack: { id: 'current', title: 'Current', artist: 'Artist', cover: '/current.jpg' } as {
        id: string;
        title: string;
        artist: string;
        cover?: string;
        podcast_guid?: string;
      } | null,
    },
    autoMode: { active: false },
  });
  harness.setOpen = setOpen;
  harness.setState = setState as unknown as (...args: unknown[]) => void;
  harness.actions.enterAutoMode.mockImplementation(() => setState('autoMode', 'active', true));
  harness.actions.exitAutoMode.mockImplementation(() => setState('autoMode', 'active', false));
  return {
    actions: harness.actions,
    nowPlayingOpen: open,
    setNowPlayingOpen: setOpen,
    state,
  };
});

vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/track', () => ({ isPodcastTrack: (track: { podcast_guid?: string }) => Boolean(track.podcast_guid) }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('./NowPlaying', () => ({
  NowPlaying: (props: { mobilePanel: string }) => <div data-testid="now-playing-view">{props.mobilePanel}</div>,
}));
vi.mock('./AutoMode', () => ({ AutoMode: () => <div data-testid="auto-mode-view">Auto</div> }));
vi.mock('./NowPlayingBrowser', async () => {
  const { createSignal } = await vi.importActual<typeof import('solid-js')>('solid-js');
  const [browserOpen, setBrowserOpen] = createSignal(true);
  harness.setBrowserOpen = setBrowserOpen;
  harness.openBrowser.mockImplementation(() => setBrowserOpen(true));
  harness.toggleBrowser.mockImplementation(() => setBrowserOpen((open) => !open));
  return {
    browserOpen,
    openBrowser: harness.openBrowser,
    toggleBrowser: harness.toggleBrowser,
  };
});

import { PlayerSurface } from './PlayerSurface';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: harness.mobileViewport,
    media: '(max-width: 1023px)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
});

afterEach(() => {
  cleanup();
  harness.setOpen?.(true);
  harness.setState?.('autoMode', 'active', false);
  harness.setState?.('playback', 'currentTrack', {
    id: 'current',
    title: 'Current',
    artist: 'Artist',
    cover: '/current.jpg',
  });
  harness.setBrowserOpen?.(true);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  harness.mobileViewport = false;
  delete document.documentElement.dataset.playerSurface;
});

describe('PlayerSurface', () => {
  it('uses the pill as the real Auto Mode switch', () => {
    render(() => <PlayerSurface />);

    fireEvent.click(screen.getByRole('tab', { name: 'autoMode.label' }));
    expect(harness.actions.enterAutoMode).toHaveBeenCalledOnce();
    expect(screen.getByTestId('auto-mode-view')).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('data-player-surface', 'auto');

    fireEvent.click(screen.getByRole('tab', { name: 'nowPlaying.modeLabel' }));
    expect(harness.actions.exitAutoMode).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('auto-mode-view')).not.toBeInTheDocument();
  });

  it('hides the surface without stopping a running Auto session', () => {
    render(() => <PlayerSurface />);
    fireEvent.click(screen.getByRole('tab', { name: 'autoMode.label' }));

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));

    expect(harness.actions.exitAutoMode).not.toHaveBeenCalled();
    expect(screen.getByTestId('auto-mode-view')).toBeInTheDocument();
    expect(screen.getByTestId('auto-mode-view').closest('[aria-hidden]')).toHaveAttribute('aria-hidden', 'true');
    expect(document.documentElement).not.toHaveAttribute('data-player-surface');
  });

  it('keeps the Auto half visible but disabled for podcasts', () => {
    harness.setState?.('playback', 'currentTrack', {
      id: 'episode',
      title: 'Episode',
      artist: 'Show',
      podcast_guid: 'guid',
    });
    render(() => <PlayerSurface />);

    expect(screen.getByRole('tab', { name: 'autoMode.label' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'nowPlaying.modeLabel' })).toHaveAttribute('aria-selected', 'true');
  });

  it('moves between the three compact panels through accessible indicators', () => {
    render(() => <PlayerSurface />);
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('stage');

    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.panel.queue' }));
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('queue');

    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.panel.browser' }));
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('browser');
  });

  it('resets the compact carousel before every close and reopen', () => {
    harness.mobileViewport = true;
    render(() => <PlayerSurface />);

    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.panel.browser' }));
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('browser');

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('stage');

    harness.setOpen?.(true);
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('stage');
  });

  it('opens the compact browser without changing the desktop browser preference', () => {
    harness.mobileViewport = true;
    render(() => <PlayerSurface />);

    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.showSearchPanel' }));

    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('browser');
    expect(harness.openBrowser).not.toHaveBeenCalled();
    expect(harness.toggleBrowser).not.toHaveBeenCalled();
  });

  it('opens the desktop browser from the top-left toggle', () => {
    harness.setBrowserOpen?.(false);
    render(() => <PlayerSurface />);

    const toggle = screen.getByRole('button', { name: 'nowPlaying.showSearchPanel' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    expect(harness.toggleBrowser).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'nowPlaying.hideSearchPanel' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
