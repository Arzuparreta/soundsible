import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { actions, state } = vi.hoisted(() => ({
  actions: {
    setAutoProfile: vi.fn(),
    setAutoDjProfile: vi.fn(),
    setAutoDirection: vi.fn(),
    requestAutoTrack: vi.fn(),
    cancelAutoRequest: vi.fn(),
    exitAutoMode: vi.fn(),
    setVolume: vi.fn(),
    autoSkip: vi.fn().mockResolvedValue(undefined),
    prev: vi.fn(),
    togglePlay: vi.fn(),
    downloadTrack: vi.fn(),
    toggleFavourite: vi.fn(),
    jumpTo: vi.fn(),
    promoteInAutoRoute: vi.fn(),
  },
  state: {
    favorites: [],
    playback: {
      currentTrack: { id: 'current', title: 'Current song', artist: 'Artist', cover: '/current.jpg' },
      queue: [
        { id: 'current', queueId: 'q-current', title: 'Current song', artist: 'Artist', cover: '/current.jpg' },
        { id: 'next', queueId: 'q-next', title: 'Next song', artist: 'Next artist', cover: '/next.jpg', source: 'preview' as const },
      ],
      index: 0,
      currentTime: 30,
      duration: 180,
      isPlaying: true,
      volume: 1,
    },
    autoMode: {
      active: true,
      profile: 'balanced' as const,
      djProfile: 'adaptive' as const,
      direction: { energy: 0, familiarity: 0, prompt: '', include: [], exclude: [] },
      requests: [],
      transition: { status: 'idle' as const } as { status: string; technique?: string; nextTrackId?: string },
      pendingDirection: false,
      phase: 'ready' as const,
      activity: {
        id: 1,
        status: 'done' as const,
        key: 'autoMode.agent.queued',
        values: { tracks: 'Next song', count: 1, related: 4, node: 3, local: 20 },
      },
      plan: {
        next: { trackId: 'next', fromKey: 'current', source: 'related' as const, reasonKey: 'autoMode.reason.related', reasonValues: { title: 'Current song' } },
      } as Record<string, { trackId: string; fromKey: string; source: string; reasonKey: string; bpm?: number; key?: string }>,
    },
  },
}));

vi.mock('../stores', () => ({
  actions,
  state,
  isFavouriteKeys: () => false,
  isSavedTrack: () => true,
  isSavedKeys: () => true,
  isDownloadingKeys: () => false,
  ownedTrackForKeys: () => null,
}));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${Object.values(params).join(',')}` : key,
}));
vi.mock('./LyricsPanel', () => ({
  LyricsPanel: () => <div data-testid="lyrics-panel" data-lyrics-scroll="">Lyrics content</div>,
}));

import { AutoMode, titleFit } from './AutoMode';

const initialViewportWidth = window.innerWidth;

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  state.autoMode.transition = { status: 'idle' };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialViewportWidth });
});

describe('AutoMode environment', () => {
  it('renders playback, a concrete live action and a horizontally navigable queue', () => {
    render(() => <AutoMode />);

    expect(screen.getByRole('heading', { name: 'Current song' })).toBeInTheDocument();
    expect(screen.getByText('autoMode.agent.queued:Next song,1,4,3,20')).toBeInTheDocument();
    expect(screen.getByText('Next song')).toBeInTheDocument();

    const queue = screen.getByRole('button', { name: /Next song/ }).parentElement!;
    fireEvent.wheel(queue, { deltaY: 80, deltaX: 0 });
    expect(queue.scrollLeft).toBe(80);

    fireEvent.click(screen.getByRole('button', { name: /autoMode\.dj\.changeCurrent/ }));
    fireEvent.click(screen.getByRole('option', { name: /autoMode\.dj\.cutsDrops/ }));
    expect(actions.setAutoDjProfile).toHaveBeenCalledWith('cuts_drops');
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.exit' }));
    expect(actions.exitAutoMode).toHaveBeenCalledOnce();
  });

  it('keeps DJ technique separate from musical direction and opens requests in place', () => {
    render(() => <AutoMode />);

    const command = screen.getByRole('textbox', { name: 'autoMode.dj.commandAria' });
    fireEvent.input(command, { target: { value: 'Más energía y sorpréndeme' } });
    fireEvent.submit(command.closest('form')!);
    // The booth repeats the listener's own words back on the status line
    // instead of naming an internal profile they never touched.
    expect(actions.setAutoDirection).toHaveBeenCalledWith(
      expect.objectContaining({
        energy: 0.35,
        familiarity: -0.35,
        prompt: 'Más energía y sorpréndeme',
      }),
      'autoMode.note.quoted:Más energía y sorpréndeme',
    );

    fireEvent.click(screen.getByRole('button', { name: /autoMode\.dj\.request/ }));
    expect(screen.getByRole('complementary', { name: 'autoMode.dj.requestPanelAria' })).toBeInTheDocument();
    expect(screen.getByText('autoMode.dj.requestPromise')).toBeInTheDocument();
  });

  it('reads the two direction switches as settings, not as a menu', () => {
    render(() => <AutoMode />);

    const held = screen.getAllByRole('button', { name: 'autoMode.booth.hold' });
    expect(held).toHaveLength(2);
    expect(held[0]).toHaveAttribute('aria-pressed', 'true');
    expect(held[1]).toHaveAttribute('aria-pressed', 'true');
    // The thumb's position is the setting, so it has to track the value.
    for (const track of document.querySelectorAll('fieldset > div')) {
      expect((track as HTMLElement).style.getPropertyValue('--switch-pos')).toBe('1');
    }

    fireEvent.click(screen.getByRole('button', { name: 'autoMode.booth.energyUp' }));
    expect(actions.setAutoDirection).toHaveBeenCalledWith(
      { energy: 0.65, prompt: '' },
      'autoMode.note.energy.up',
    );

    fireEvent.click(screen.getByRole('button', { name: 'autoMode.booth.crateDeep' }));
    expect(actions.setAutoDirection).toHaveBeenCalledWith(
      { familiarity: -0.65, prompt: '' },
      'autoMode.note.crate.deep',
    );
  });

  it('shows both decks in the booth’s own units, and never invents a reading', () => {
    state.autoMode.plan.current = {
      trackId: 'current', fromKey: '', source: 'local', reasonKey: 'autoMode.reason.library', bpm: 128.4, key: 'Am',
    };
    render(() => <AutoMode />);

    const readout = screen.getByText('autoMode.booth.now').parentElement!;
    expect(readout).toHaveTextContent('128');
    expect(readout).toHaveTextContent('Am');
    // The next track has no analysis in this fixture: a dash, not a guess.
    const next = screen.getByText('autoMode.booth.next').parentElement!;
    expect(next).toHaveTextContent('—');

    delete state.autoMode.plan.current;
  });

  it('leaves the shortcuts alone while the listener is typing to the DJ', () => {
    // Keydown is delegated, so everything typed into the command bar reaches
    // the environment's handler too. Writing "no pongas reggaeton" used to skip
    // a track on every "n" and ride the volume with the arrow keys.
    render(() => <AutoMode />);
    const command = screen.getByRole('textbox', { name: 'autoMode.dj.commandAria' });

    for (const key of ['n', 'N', 'ArrowUp', 'ArrowDown']) {
      fireEvent.keyDown(command, { key });
    }
    expect(actions.autoSkip).not.toHaveBeenCalled();
    expect(actions.setVolume).not.toHaveBeenCalled();

    // Outside a field the same keys are still the shortcuts they always were.
    fireEvent.keyDown(screen.getByRole('region', { name: 'autoMode.aria' }), { key: 'n' });
    expect(actions.autoSkip).toHaveBeenCalledOnce();
  });

  it('presents the cued track as settled rather than as another destination', () => {
    // Once a handoff is loaded and cued there is nothing to jump to: promoting
    // something past it would throw away a mix that is already prepared.
    state.autoMode.transition = { status: 'armed', technique: 'long_blend', nextTrackId: 'next' };
    render(() => <AutoMode />);

    const card = screen.getByRole('button', { name: /Next song/ });
    expect(card).toBeDisabled();
    fireEvent.click(card);
    expect(actions.promoteInAutoRoute).not.toHaveBeenCalled();
    // The rail header and the card itself both say it, which is the point.
    expect(screen.getAllByText(/autoMode\.dj\.cued/)).toHaveLength(2);
    // And a direction change is honest about when it lands.
    expect(screen.getByText('autoMode.dj.appliesNext')).toBeInTheDocument();
  });

  it('brings a route card forward instead of hard-loading it', () => {
    render(() => <AutoMode />);

    fireEvent.click(screen.getByRole('button', { name: /autoMode\.dj\.promote/ }));
    expect(actions.promoteInAutoRoute).toHaveBeenCalledWith('q-next');
    expect(actions.jumpTo).not.toHaveBeenCalled();
  });

  it('exits on a swipe down over the backdrop, but not on one that scrolls the queue', () => {
    render(() => <AutoMode />);
    const root = screen.getByRole('region', { name: 'autoMode.aria' });
    const rail = screen.getByRole('button', { name: /Next song/ }).parentElement!;

    // Dragging the queue rail is scrolling, not leaving.
    fireEvent.pointerDown(rail, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(rail, { clientX: 200, clientY: 320 });
    expect(actions.exitAutoMode).not.toHaveBeenCalled();

    fireEvent.pointerDown(root, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(root, { clientX: 200, clientY: 320 });
    expect(actions.exitAutoMode).toHaveBeenCalledOnce();
  });

  it('enters the ambient state after twelve idle seconds and wakes on input', async () => {
    vi.useFakeTimers();
    render(() => <AutoMode />);
    const root = screen.getByRole('region', { name: 'autoMode.aria' });
    const initialClass = root.className;

    await vi.advanceTimersByTimeAsync(12_000);
    expect(root.className).not.toBe(initialClass);

    fireEvent.pointerMove(root);
    expect(root.className).toBe(initialClass);
  });

  it('shrinks long titles instead of letting them grow the metadata block', () => {
    // The artwork is sized from the space the metadata leaves over, so a title
    // that grows a third line clips the composition. Length picks the type size;
    // the two-line well never changes height.
    expect(titleFit('Redbone')).toBe('lg');
    expect(titleFit('Ain’t No Mountain High Enough')).toBe('md');
    expect(titleFit('Ain’t No Mountain High Enough (Remastered 2019)')).toBe('sm');
    expect(titleFit('Ain’t No Mountain High Enough (Remastered 2019 Deluxe Edition Version)')).toBe('xs');

    render(() => <AutoMode />);
    expect(screen.getByRole('heading', { name: 'Current song' }).parentElement).toBeInTheDocument();
    expect(document.querySelector('[data-fit="lg"]')).toBeTruthy();
  });

  it('removes a completed agent report instead of keeping a status panel on screen', async () => {
    vi.useFakeTimers();
    render(() => <AutoMode />);
    expect(screen.getByText('autoMode.agent.queued:Next song,1,4,3,20')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(6_000);
    expect(screen.queryByText('autoMode.agent.queued:Next song,1,4,3,20')).not.toBeInTheDocument();
  });

  it('anchors the mobile Auto cover to the live Now Playing cover slot', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const source = document.createElement('div');
    source.dataset.nowPlayingCoverSlot = '';
    source.getBoundingClientRect = vi.fn(() => rect({ top: 92, left: 16, width: 358, height: 358 }));
    document.body.append(source);

    render(() => <AutoMode />);
    const root = screen.getByRole('region', { name: 'autoMode.aria' });
    expect(root).toHaveAttribute('data-mobile-cover-anchor');
    expect(root.style.getPropertyValue('--auto-mobile-cover-left')).toBe('16px');
    expect(root.style.getPropertyValue('--auto-mobile-cover-top')).toBe('92px');
    expect(root.style.getPropertyValue('--auto-mobile-cover-width')).toBe('358px');
    expect(root.style.getPropertyValue('--auto-mobile-cover-height')).toBe('358px');
    source.remove();
  });

  it('opens Lyrics inside the anchored cover without changing handoff geometry or swipe ownership', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const source = document.createElement('div');
    source.dataset.nowPlayingCoverSlot = '';
    source.getBoundingClientRect = vi.fn(() => rect({ top: 92, left: 16, width: 358, height: 358 }));
    document.body.append(source);

    render(() => <AutoMode />);
    const root = screen.getByRole('region', { name: 'autoMode.aria' });
    const showLyrics = screen.getByRole('button', { name: 'nowPlaying.showLyrics' });
    fireEvent.click(showLyrics);

    expect(screen.getByTestId('lyrics-panel')).toBeInTheDocument();
    expect(showLyrics).toHaveAttribute('aria-pressed', 'true');
    expect(showLyrics).toHaveAccessibleName('nowPlaying.showCover');
    expect(root.style.getPropertyValue('--auto-mobile-cover-left')).toBe('16px');
    expect(root.style.getPropertyValue('--auto-mobile-cover-top')).toBe('92px');
    expect(root.style.getPropertyValue('--auto-mobile-cover-width')).toBe('358px');
    expect(root.style.getPropertyValue('--auto-mobile-cover-height')).toBe('358px');

    const lyrics = screen.getByTestId('lyrics-panel');
    fireEvent.pointerDown(lyrics, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(lyrics, { clientX: 200, clientY: 320 });
    expect(actions.exitAutoMode).not.toHaveBeenCalled();
    source.remove();
  });

  it('names the song on the artwork, without saying it twice to a screen reader', () => {
    // Mobile puts the metadata on the cover (CSS decides where it shows). The
    // panel's block stays as the live region, so the caption is decoration.
    render(() => <AutoMode />);
    const caption = screen.getByRole('img', { name: 'Current song' }).nextElementSibling!;

    expect(caption).toHaveTextContent('Current song');
    expect(caption).toHaveTextContent('Artist');
    expect(caption).toHaveAttribute('aria-hidden', 'true');
    expect(caption).toHaveAttribute('data-fit', 'lg');
    expect(screen.getByRole('heading', { name: 'Current song' }).closest('[aria-live]')).toBeTruthy();
  });

  it('lifts the Auto Mode status into the band above the pinned cover, and only when it fits', () => {
    // The pinned cover is not where the panel below it was laid out, so in flow
    // the status line lands on the artwork. It belongs in the empty band between
    // the top bar and the cover — but never on top of the top bar.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    let coverTop = 300;
    const source = document.createElement('div');
    source.dataset.nowPlayingCoverSlot = '';
    source.getBoundingClientRect = vi.fn(() => rect({ top: coverTop, left: 16, width: 358, height: 358 }));
    document.body.append(source);

    render(() => <AutoMode />);
    const root = screen.getByRole('region', { name: 'autoMode.aria' });
    const status = screen.getByText('autoMode.agent.queued:Next song,1,4,3,20').parentElement!.parentElement!;
    root.querySelector('header')!.getBoundingClientRect = vi.fn(() => rect({ top: 20, left: 0, width: 390, height: 80 }));
    status.getBoundingClientRect = vi.fn(() => rect({ top: 0, left: 16, width: 358, height: 18 }));

    fireEvent(window, new Event('resize'));
    expect(root).toHaveAttribute('data-mobile-status-above');
    // 12px clear of the artwork, well below the top bar's 100px bottom edge.
    expect(root.style.getPropertyValue('--auto-mobile-status-top')).toBe('270px');

    // A band too short for the line: it stays in the panel's reserved slot.
    coverTop = 118;
    fireEvent(window, new Event('resize'));
    expect(root).not.toHaveAttribute('data-mobile-status-above');
    expect(root.style.getPropertyValue('--auto-mobile-status-top')).toBe('');
    source.remove();
  });
});

function rect({ top, left, width, height }: { top: number; left: number; width: number; height: number }): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}
