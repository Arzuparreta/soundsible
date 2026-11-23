import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  actions: {
    enterAutoMode: vi.fn(),
    exitAutoMode: vi.fn(),
  },
  setOpen: undefined as undefined | ((open: boolean) => void),
  setState: undefined as undefined | ((...args: unknown[]) => void),
  mobileViewport: false,
  desktop: false,
}));

vi.mock('../lib/shellLayout', () => ({ desktopShell: () => harness.desktop }));

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

vi.mock('../lib/config', () => ({ apiOrigin: () => '', mediaOrigin: () => '', artworkUrl: (url?: string | null) => url || undefined }));
vi.mock('../lib/track', () => ({ isPodcastTrack: (track: { podcast_guid?: string }) => Boolean(track.podcast_guid) }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('./NowPlaying', () => ({
  NowPlaying: (props: {
    mobilePanel: string;
    onMobilePanelChange: (panel: string) => void;
    onCarouselProgress?: (index: number, live: boolean) => void;
  }) => (
    <div data-testid="now-playing-view">
      {props.mobilePanel}
      {/* The real carousel reports the scroll position and the settled panel on
          two separate channels: the marker follows the finger, the panel waits. */}
      <button
        type="button"
        onClick={() => {
          props.onCarouselProgress?.(1, false);
          props.onMobilePanelChange('queue');
        }}
      >
        simulate swipe
      </button>
      <button type="button" onClick={() => props.onCarouselProgress?.(0.4, true)}>simulate drag</button>
    </div>
  ),
}));
vi.mock('./AutoMode', () => ({
  AutoMode: (props: {
    panel: string;
    onPanelChange: (panel: string) => void;
    onCarouselProgress?: (index: number, live: boolean) => void;
  }) => (
    <div data-testid="auto-mode-view">
      {props.panel}
      <button
        type="button"
        onClick={() => {
          props.onCarouselProgress?.(1, false);
          props.onPanelChange('route');
        }}
      >
        simulate auto swipe
      </button>
      <button type="button" onClick={() => props.onCarouselProgress?.(0.4, true)}>
        simulate auto drag
      </button>
    </div>
  ),
}));

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
    podcast_guid: undefined,
  });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  harness.mobileViewport = false;
  harness.desktop = false;
  localStorage.clear();
  delete document.documentElement.dataset.playerSurface;
  delete document.documentElement.dataset.playerDocked;
});

/** jsdom has no touch input, so the gesture is fed the shape it reads: an
    identified touch on `touches`, and the same one on `changedTouches`. */
function touch(type: 'touchstart' | 'touchmove' | 'touchend', x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y, identifier: 1 };
  const list = { length: 1, item: () => point };
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? { length: 0, item: () => null } : list,
  });
  Object.defineProperty(event, 'changedTouches', { value: list });
  return event;
}

function swipeDown(target: Element) {
  target.dispatchEvent(touch('touchstart', 100, 100));
  target.dispatchEvent(touch('touchmove', 100, 140));
  target.dispatchEvent(touch('touchmove', 100, 240));
  target.dispatchEvent(touch('touchend', 100, 240));
}

describe('PlayerSurface', () => {
  it('uses the pill as the real Auto Mode switch', async () => {
    render(() => <PlayerSurface />);

    fireEvent.click(screen.getByRole('tab', { name: 'autoMode.label' }));
    expect(harness.actions.enterAutoMode).toHaveBeenCalledOnce();
    expect(await screen.findByTestId('auto-mode-view')).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('data-player-surface', 'auto');

    fireEvent.click(screen.getByRole('tab', { name: 'nowPlaying.modeLabel' }));
    expect(harness.actions.exitAutoMode).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('auto-mode-view')).not.toBeInTheDocument();
  });

  it('hides the surface without stopping a running Auto session', async () => {
    render(() => <PlayerSurface />);
    fireEvent.click(screen.getByRole('tab', { name: 'autoMode.label' }));
    await screen.findByTestId('auto-mode-view');

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));

    expect(harness.actions.exitAutoMode).not.toHaveBeenCalled();
    expect(screen.getByTestId('auto-mode-view')).toBeInTheDocument();
    expect(screen.getByTestId('auto-mode-view').closest('[aria-hidden]')).toHaveAttribute('aria-hidden', 'true');
    expect(document.documentElement).not.toHaveAttribute('data-player-surface');
  });

  it('stays out of the way when a restored session turns Auto on', async () => {
    // A session put back on boot flips the same flag a listener asking for Auto
    // does. Only the asking raises the surface, so the restore has to leave the
    // shell collapsed rather than covering whatever the app opened onto.
    harness.setOpen?.(false);
    render(() => <PlayerSurface />);

    harness.setState?.('autoMode', 'active', true);
    const view = await screen.findByTestId('auto-mode-view');

    expect(document.documentElement).not.toHaveAttribute('data-player-surface');
    expect(view.closest('[aria-hidden]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('walks the mode tabs with the keyboard without switching modes', () => {
    render(() => <PlayerSurface />);
    const normal = screen.getByRole('tab', { name: 'nowPlaying.modeLabel' });
    const dj = screen.getByRole('tab', { name: 'autoMode.label' });

    // Only the chosen mode sits in the Tab order; its panel is named by it.
    expect(normal).toHaveAttribute('tabindex', '0');
    expect(dj).toHaveAttribute('tabindex', '-1');
    expect(document.getElementById('now-playing-view')).toHaveAttribute('aria-labelledby', normal.id);
    expect(document.getElementById('auto-mode-view')).toHaveAttribute('aria-labelledby', dj.id);

    normal.focus();
    fireEvent.keyDown(normal, { key: 'ArrowRight' });
    expect(dj).toHaveFocus();
    fireEvent.keyDown(dj, { key: 'ArrowRight' });
    expect(normal).toHaveFocus();
    fireEvent.keyDown(normal, { key: 'End' });
    expect(dj).toHaveFocus();
    fireEvent.keyDown(dj, { key: 'Home' });
    expect(normal).toHaveFocus();
    fireEvent.keyDown(normal, { key: 'ArrowLeft' });
    expect(dj).toHaveFocus();

    // Starting DJ is a decision with consequences for what plays: focus alone
    // never makes it.
    expect(harness.actions.enterAutoMode).not.toHaveBeenCalled();
    expect(normal).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(dj);
    expect(harness.actions.enterAutoMode).toHaveBeenCalledOnce();
    expect(dj).toHaveAttribute('tabindex', '0');
    expect(normal).toHaveAttribute('tabindex', '-1');
  });

  it('claims the arrow keys on the mode tabs so they do not also seek', () => {
    render(() => <PlayerSurface />);
    const normal = screen.getByRole('tab', { name: 'nowPlaying.modeLabel' });
    normal.focus();

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true });
    normal.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
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

    const normal = screen.getByRole('tab', { name: 'nowPlaying.modeLabel' });
    normal.focus();
    fireEvent.keyDown(normal, { key: 'ArrowRight' });
    expect(normal).toHaveFocus();
  });

  it('moves between the two compact panels through accessible indicators', () => {
    render(() => <PlayerSurface />);
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('stage');

    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.panel.queue' }));
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('queue');

    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.panel.stage' }));
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('stage');
    expect(screen.queryByRole('button', { name: 'nowPlaying.panel.browser' })).toBeNull();
  });

  it('moves the compact pill when the carousel reports a user swipe', () => {
    render(() => <PlayerSurface />);
    const nav = screen.getByRole('navigation', { name: 'nowPlaying.mobilePanels' });

    expect(nav).toHaveStyle('--carousel-index: 0');
    fireEvent.click(screen.getByRole('button', { name: 'simulate swipe' }));

    expect(screen.getByRole('button', { name: 'nowPlaying.panel.queue' })).toHaveAttribute('aria-current', 'page');
    expect(nav).toHaveStyle('--carousel-index: 1');
  });

  it('tracks a drag between panels without waiting for it to settle', () => {
    render(() => <PlayerSurface />);
    const nav = screen.getByRole('navigation', { name: 'nowPlaying.mobilePanels' });

    fireEvent.click(screen.getByRole('button', { name: 'simulate drag' }));

    expect(nav).toHaveStyle('--carousel-index: 0.4');
    expect(nav).toHaveAttribute('data-live');
    // The panel itself has not settled yet, so focus and inertness stay put.
    expect(screen.getByRole('button', { name: 'nowPlaying.panel.stage' })).toHaveAttribute('aria-current', 'page');
  });

  it('uses the same live pager contract in Auto Mode', async () => {
    render(() => <PlayerSurface />);
    fireEvent.click(screen.getByRole('tab', { name: 'autoMode.label' }));
    await screen.findByTestId('auto-mode-view');
    const nav = screen.getByRole('navigation', { name: 'autoMode.mobile.controls' });

    expect(nav).toHaveStyle('--carousel-index: 0');
    fireEvent.click(screen.getByRole('button', { name: 'simulate auto drag' }));
    expect(nav).toHaveStyle('--carousel-index: 0.4');
    expect(nav).toHaveAttribute('data-live');
    expect(screen.getByRole('button', { name: 'autoMode.panel.stage' })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: 'simulate auto swipe' }));
    expect(nav).toHaveStyle('--carousel-index: 1');
    expect(screen.getByTestId('auto-mode-view')).toHaveTextContent('route');
    expect(screen.getByRole('button', { name: 'autoMode.panel.route' })).toHaveAttribute('aria-current', 'page');
  });

  it('resets the compact carousel only once the surface has animated out', () => {
    harness.mobileViewport = true;
    render(() => <PlayerSurface />);
    const surface = screen.getByTestId('now-playing-view').closest('[data-player-stage]')!;

    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.panel.queue' }));
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('queue');

    // Realigning the carousel mid-exit is what used to flush layout on top of
    // the close, so the reset waits for the surface to be off screen.
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('queue');

    fireEvent.animationEnd(surface);
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('stage');

    harness.setOpen?.(true);
    expect(screen.getByTestId('now-playing-view')).toHaveTextContent('stage');
  });

  it('gives a button close the whole travel to animate', () => {
    harness.mobileViewport = true;
    render(() => <PlayerSurface />);
    const surface = screen.getByTestId('now-playing-view').closest('[data-player-stage]') as HTMLElement;

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));

    expect(surface.className).toContain('closing');
    expect(surface.style.getPropertyValue('--surface-exit-from')).toBe('0px');
    // Under the 300ms of the entrance: the sheet leaves quicker than it arrives.
    expect(surface.style.getPropertyValue('--surface-exit-duration')).toBe('260ms');
  });

  it('continues a released drag from where the finger left it', () => {
    harness.mobileViewport = true;
    render(() => <PlayerSurface />);
    const surface = screen.getByTestId('now-playing-view').closest('[data-player-stage]') as HTMLElement;

    swipeDown(screen.getByRole('button', { name: 'simulate swipe' }));

    // The sheet is already 140px down, so the exit starts there rather than
    // snapping back to the top, and only pays for the distance still to cover.
    expect(surface.className).toContain('closing');
    expect(surface.style.getPropertyValue('--surface-exit-from')).toBe('140px');
    const duration = Number.parseInt(surface.style.getPropertyValue('--surface-exit-duration'), 10);
    expect(duration).toBeGreaterThanOrEqual(110);
    expect(duration).toBeLessThan(260);
  });

  it('drops the exit values once the surface is off screen', () => {
    harness.mobileViewport = true;
    render(() => <PlayerSurface />);
    const surface = screen.getByTestId('now-playing-view').closest('[data-player-stage]') as HTMLElement;

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    fireEvent.animationEnd(surface);

    expect(surface.className).not.toContain('closing');
    expect(surface.style.getPropertyValue('--surface-exit-from')).toBe('');
    expect(surface.style.getPropertyValue('--surface-exit-duration')).toBe('');
  });

  it('closes on a swipe that starts on a button', () => {
    // The queue rows and the browser cards are full-width buttons, so excluding
    // buttons from the gesture left most of the surface unswipeable.
    harness.mobileViewport = true;
    render(() => <PlayerSurface />);
    const surface = screen.getByTestId('now-playing-view').closest('[data-player-stage]')!;

    swipeDown(screen.getByRole('button', { name: 'simulate swipe' }));

    expect(surface).not.toHaveAttribute('data-player-surface-open');
  });

  it('leaves the gesture alone on controls that opted out', () => {
    harness.mobileViewport = true;
    render(() => <PlayerSurface />);
    const surface = screen.getByTestId('now-playing-view').closest('[data-player-stage]')!;

    swipeDown(screen.getByRole('button', { name: 'nowPlaying.panel.queue' }));

    expect(surface).toHaveAttribute('data-player-surface-open');
  });

  it('ignores a swipe that reads as a horizontal panel change', () => {
    harness.mobileViewport = true;
    render(() => <PlayerSurface />);
    const surface = screen.getByTestId('now-playing-view').closest('[data-player-stage]')!;
    const target = screen.getByRole('button', { name: 'simulate swipe' });

    target.dispatchEvent(touch('touchstart', 200, 100));
    target.dispatchEvent(touch('touchmove', 180, 104));
    target.dispatchEvent(touch('touchmove', 60, 240));
    target.dispatchEvent(touch('touchend', 60, 240));

    expect(surface).toHaveAttribute('data-player-surface-open');
  });

  it('inherits the surface swipe-down gesture in Auto Mode', async () => {
    harness.mobileViewport = true;
    render(() => <PlayerSurface />);
    fireEvent.click(screen.getByRole('tab', { name: 'autoMode.label' }));
    const target = await screen.findByRole('button', { name: 'simulate auto swipe' });
    const surface = target.closest('[data-player-stage]')!;

    swipeDown(target);

    expect(surface).not.toHaveAttribute('data-player-surface-open');
    expect(harness.actions.exitAutoMode).not.toHaveBeenCalled();
  });

  it('opens docked beside the app on a desktop, and gives the app back its room', () => {
    harness.desktop = true;
    render(() => <PlayerSurface />);
    const surface = screen.getByTestId('now-playing-view').closest('[data-player-stage]')!;

    expect(surface).toHaveAttribute('data-docked');
    expect(document.documentElement).toHaveAttribute('data-player-docked');
    expect(screen.getByRole('separator', { name: 'nowPlaying.resizeDock' })).toBeInTheDocument();

    // Full screen is the other presentation, chosen from the header and kept.
    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.fillScreen' }));
    expect(surface).not.toHaveAttribute('data-docked');
    expect(document.documentElement).not.toHaveAttribute('data-player-docked');
    expect(localStorage.getItem('player:presentation:v1')).toBe('full');
    fireEvent.click(screen.getByRole('button', { name: 'nowPlaying.dockBeside' }));
    expect(surface).toHaveAttribute('data-docked');
  });

  it('resizes the docked column from the keyboard, within its bounds', () => {
    harness.desktop = true;
    render(() => <PlayerSurface />);
    const edge = screen.getByRole('separator', { name: 'nowPlaying.resizeDock' });
    const before = Number(edge.getAttribute('aria-valuenow'));

    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(Number(edge.getAttribute('aria-valuenow'))).toBe(before + 24);
    for (let step = 0; step < 40; step += 1) fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(Number(edge.getAttribute('aria-valuenow'))).toBe(360);
  });

  it('is not dragged off when docked: the header closes it', () => {
    harness.desktop = true;
    render(() => <PlayerSurface />);
    const target = screen.getByRole('button', { name: 'simulate swipe' });

    swipeDown(target);

    expect(target.closest('[data-player-stage]')).toHaveAttribute('data-player-surface-open');
  });

  it('never offers the docked or full-screen choice on a phone', () => {
    render(() => <PlayerSurface />);
    expect(screen.queryByRole('button', { name: 'nowPlaying.fillScreen' })).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });
});
