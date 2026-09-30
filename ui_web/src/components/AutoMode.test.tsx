import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { actions, buildTrackMenu, openActionMenu, openContextMenu, openPlaylistPicker, openMetadataEditor, state } = vi.hoisted(() => ({
  buildTrackMenu: vi.fn(() => [{ label: 'trackMenu', onSelect: () => {} }]),
  openPlaylistPicker: vi.fn(),
  openMetadataEditor: vi.fn(),
  actions: {
    removeAutoSource: vi.fn(), useAutoTrackAsSource: vi.fn(), placeAutoTrack: vi.fn(),
    removeAutoRouteOccurrence: vi.fn(), avoidAutoTrackForSession: vi.fn(), moveAutoRoute: vi.fn(),
    retryAutoRoute: vi.fn(), retryAutoSessionChange: vi.fn(), repairAutoRoute: vi.fn(), changeAutoSession: vi.fn(), startDjFromTrack: vi.fn(), cancelAutoSessionChange: vi.fn(),
  },
  openActionMenu: vi.fn(),
  openContextMenu: vi.fn(),
  state: {
    playback: {
      currentTrack: { id: 'current', title: 'Current song', artist: 'Artist' } as null | { id: string; title: string; artist: string },
      queue: [
        { id: 'current', queueId: 'q-current', title: 'Current song', artist: 'Artist' },
        { id: 'next', queueId: 'q-next', title: 'Next song', artist: 'Next artist', source: 'preview' as const },
      ], index: 0, isPlaying: true, djMixing: true,
    },
    autoMode: {
      active: true,
      sessionChange: undefined as undefined | { label: string; status: 'working' | 'error'; reason?: 'timeout' | 'exhausted' | 'failed' },
      sources: [{ id: 'source-1', label: 'Warehouse techno', activation: 1, tracks: [{ id: 'root', title: 'Root', artist: 'DJ' }] }],
      transition: { status: 'idle' as 'idle' | 'armed' },
      repairing: false,
      pendingDirection: false,
      phase: 'ready' as 'idle' | 'following_queue' | 'planning' | 'ready' | 'exhausted' | 'warming' | 'degraded',
      activity: null as null | { id: number; status: 'working' | 'done' | 'error'; key: string },
      staleSeams: [] as string[],
      plan: { 'q-next': { trackId: 'next', fromKey: 'current', source: 'related' as const, reasonKey: '', sourceSetLabel: 'Warehouse techno', lineage: ['root', 'next'] } },
    },
  },
}));

vi.mock('../stores', () => ({ actions, state }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu }));
vi.mock('./ActionMenu', () => ({ openActionMenu }));
// What the track menu offers is `trackActions.test.ts`'s business. Here it is
// one entry, so the route's own composition and order stay readable.
vi.mock('./trackActions', () => ({ buildTrackMenu }));
vi.mock('./MetadataEditor', () => ({ openMetadataEditor }));
vi.mock('./PlaylistPicker', () => ({ openPlaylistPicker }));
vi.mock('../lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/media')>()),
  coverUrl: (id: string) => `/cover/${id}`,
}));
vi.mock('../lib/i18n', () => ({ t: (key: string, params?: Record<string, string | number>) => params ? `${key}:${Object.values(params).join(',')}` : key }));
vi.mock('./PlayerStage', () => ({ PlayerStage: (props: { mode: string; empty?: unknown }) => (
  <div data-testid="shared-stage" data-mode={props.mode}>{state.playback.currentTrack ? null : props.empty as never}</div>
) }));
vi.mock('./NowPlayingBrowser', () => ({ NowPlayingBrowser: (props: { purpose?: string }) => <aside aria-label="source-browser" data-purpose={props.purpose} /> }));

import { AutoMode, titleFit } from './AutoMode';

function renderAuto(panel: 'browser' | 'stage' | 'route' = 'stage') {
  return render(() => <AutoMode panel={panel} onPanelChange={vi.fn()} surfaceOpen />);
}

// `autoTrackDragging` is module state shared by every drop target, so a test
// that starts a drag has to end it or the next one renders mid-gesture.
afterEach(() => {
  fireEvent(window, new Event('dragend'));
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

/** A `DataTransfer` good enough for a round trip through the real payload. */
function stubTransfer() {
  const data: Record<string, string> = {};
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => { data[type] = value; },
    getData: (type: string) => data[type] ?? '',
  };
}

function routeRow(gapIndex = 0) {
  const gaps = screen.getAllByRole('button', { name: /autoMode\.route\.insertBefore/ });
  return gaps[gapIndex].nextElementSibling as HTMLElement;
}

describe('AutoMode workspace', () => {
  it('browses without arming a mode, and offers no button that only highlights a tray', () => {
    renderAuto('browser');
    expect(screen.getByTestId('shared-stage')).toHaveAttribute('data-mode', 'auto');
    expect(screen.getByRole('complementary', { name: 'source-browser' })).toHaveAttribute('data-purpose', 'auto-neutral');
    // Once, in the references tray. The route rows used to repeat it under every
    // song, which on a 280px panel cost the artist its name.
    expect(screen.getAllByText('Warehouse techno')).toHaveLength(1);
    // The Sources ＋ armed a mode whose whole payload was deferred until you
    // navigated into a collection, so pressing it looked like pressing nothing.
    expect(screen.queryByRole('button', { name: 'autoMode.source.title' })).not.toBeInTheDocument();
  });

  it('starts a new direction from the sounding song in the Session header', () => {
    renderAuto('route');
    const section = screen.getByRole('region', { name: 'musicExplorer.references' });
    const header = within(section.querySelector('header')!);
    expect(header.getAllByRole('button')).toHaveLength(3);
    fireEvent.click(header.getByRole('button', { name: 'musicExplorer.startFromCurrent' }));
    expect(actions.startDjFromTrack).toHaveBeenCalledWith(state.playback.currentTrack);
  });

  it('disables the current-song start when there is no playback', () => {
    const previous = state.playback.currentTrack;
    state.playback.currentTrack = null;
    try {
      renderAuto('route');
      expect(screen.getByRole('button', { name: 'musicExplorer.startFromCurrent' })).toBeDisabled();
    } finally { state.playback.currentTrack = previous; }
  });

  it('offers Cancel while preparing and reserves Retry for the terminal error', () => {
    state.autoMode.sessionChange = { label: 'New direction', status: 'working' };
    try {
      const view = renderAuto('route');
      expect(screen.getByRole('status')).toHaveTextContent('musicExplorer.changing:New direction');
      expect(screen.queryByRole('button', { name: 'musicExplorer.retryChange' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
      expect(actions.cancelAutoSessionChange).toHaveBeenCalledOnce();
      view.unmount();
      state.autoMode.sessionChange = { label: 'New direction', status: 'error', reason: 'timeout' };
      renderAuto('route');
      expect(screen.getByRole('status')).toHaveTextContent('musicExplorer.changeTimedOut');
      fireEvent.click(screen.getByRole('button', { name: 'musicExplorer.retryChange' }));
      expect(actions.retryAutoSessionChange).toHaveBeenCalledOnce();
    } finally { state.autoMode.sessionChange = undefined; }
  });

  /* Visible row menus expose collection and session actions together. */
  it('keeps session actions in one route menu, reached from the visible button', () => {
    const { container } = renderAuto('route');
    expect(screen.queryByRole('button', { name: /^autoMode.route.actions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'autoMode.route.useAsSource' })).not.toBeInTheDocument();

    fireEvent.click(container.querySelector('[data-drag-row="q-next"] [data-row-menu]')!);
    const options = openContextMenu.mock.calls.at(-1)![0];
    expect(options.actions.map((action: { label: string }) => action.label)).toEqual([
      'musicList.move', 'musicExplorer.reference', 'musicExplorer.startDjFromCurrent', 'trackMenu', 'autoMode.route.remove',
    ]);
    options.actions[1].onSelect();
    options.actions[2].onSelect();
    expect(actions.startDjFromTrack).toHaveBeenCalledWith(expect.objectContaining({ id: 'next' }));
    options.actions[4].onSelect();
    expect(actions.useAutoTrackAsSource).toHaveBeenCalledWith(expect.objectContaining({ id: 'next' }));
    expect(actions.removeAutoRouteOccurrence).toHaveBeenCalledWith('q-next');
  });

  /* Keeping what the DJ found used to mean waiting for it to play and reaching
   * for the stage's menu. The row offers it, as the route's own occurrence. */
  it('lets a route row be saved, downloaded or put in a playlist where it stands', () => {
    const { container } = renderAuto('route');
    fireEvent.contextMenu(container.querySelector('[data-drag-row="q-next"]')!);
    expect(buildTrackMenu).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'next', queueId: 'q-next' }),
      { inRoute: true, onAddToPlaylist: openPlaylistPicker, onEditMetadata: openMetadataEditor },
    );
  });

  it('offers the route repair beside Add once there is more than one seam', () => {
    state.playback.queue.push({
      id: 'later', queueId: 'q-later', title: 'Later song', artist: 'Later artist', source: 'preview' as const,
    });
    try {
      renderAuto('route');
      const fix = screen.getByRole('button', { name: 'autoMode.route.fix' });
      expect(fix).toBeEnabled();
      fireEvent.click(fix);
      expect(actions.repairAutoRoute).toHaveBeenCalledTimes(1);
    } finally {
      state.playback.queue.pop();
    }
  });

  it('names the repair as running and refuses a second press while it is', () => {
    state.playback.queue.push({
      id: 'later', queueId: 'q-later', title: 'Later song', artist: 'Later artist', source: 'preview' as const,
    });
    state.autoMode.repairing = true;
    try {
      renderAuto('route');
      expect(screen.queryByRole('button', { name: 'autoMode.route.fix' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'autoMode.route.fixing' })).toBeDisabled();
    } finally {
      state.autoMode.repairing = false;
      state.playback.queue.pop();
    }
  });

  it('offers no repair when the route is a single song', () => {
    renderAuto('route');
    expect(screen.getByRole('button', { name: 'autoMode.route.fix' })).toBeDisabled();
  });

  it('shows route-building feedback instead of asking to start playback while music is already playing', () => {
    const next = state.playback.queue.pop()!;
    state.autoMode.sources = [];
    state.autoMode.phase = 'planning';
    try {
      const { container } = renderAuto('route');
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('autoMode.route.preparingFrom:Current song');
      expect(status).toHaveTextContent('autoMode.route.preparingWhilePlaying');
      expect(status).not.toHaveTextContent('autoMode.source.routeEmpty');
      expect(container.querySelector('[data-route-loading="planning"]')).toBe(status);
    } finally {
      state.autoMode.phase = 'ready';
      state.autoMode.sources = [{ id: 'source-1', label: 'Warehouse techno', activation: 1, tracks: [{ id: 'root', title: 'Root', artist: 'DJ' }] }];
      state.playback.queue.push(next);
    }
  });

  it('says the DJ is trying another route after a planner miss', () => {
    const next = state.playback.queue.pop()!;
    state.autoMode.phase = 'degraded';
    try {
      renderAuto('route');
      expect(screen.getByRole('status')).toHaveTextContent('autoMode.route.retrying');
      expect(screen.getByRole('status')).toHaveTextContent('autoMode.route.retryingHint');
    } finally {
      state.autoMode.phase = 'ready';
      state.playback.queue.push(next);
    }
  });

  it('moves a carried route occurrence instead of inserting a duplicate', () => {
    vi.useFakeTimers();
    state.playback.queue.push({
      id: 'later', queueId: 'q-later', title: 'Later song', artist: 'Later artist', source: 'preview' as const,
    });
    try {
      renderAuto('route');
      const targets = screen.getAllByRole('button', { name: /autoMode\.route\.insertBefore/ });
      const firstRow = targets[0].nextElementSibling as HTMLElement;
      fireEvent.pointerDown(firstRow, { pointerType: 'touch', isPrimary: true });
      vi.advanceTimersByTime(460);

      expect(targets[1]).toHaveAttribute('data-placement-active', '');
      fireEvent.click(targets[1]);
      expect(actions.moveAutoRoute).toHaveBeenCalledWith('q-next', 'q-later');
      expect(actions.placeAutoTrack).not.toHaveBeenCalled();
    } finally {
      state.playback.queue.pop();
    }
  });

  it('lights the Sources tray the moment anything is picked up, not only when carried', () => {
    const { container } = renderAuto('route');
    expect(container.querySelector('[data-target]')).toBeNull();

    fireEvent.dragStart(routeRow(), { dataTransfer: stubTransfer() });
    expect(container.querySelector('[data-target]')).not.toBeNull();

    fireEvent(window, new Event('dragend'));
    expect(container.querySelector('[data-target]')).toBeNull();
  });

  it('drops a route song into Sources without taking it out of the route', () => {
    const { container } = renderAuto('route');
    const dataTransfer = stubTransfer();

    fireEvent.dragStart(routeRow(), { dataTransfer });
    fireEvent.drop(container.querySelector('[data-target]')!, { dataTransfer });

    expect(actions.useAutoTrackAsSource).toHaveBeenCalledWith(expect.objectContaining({ id: 'next' }));
    expect(actions.removeAutoRouteOccurrence).not.toHaveBeenCalled();
    expect(actions.moveAutoRoute).not.toHaveBeenCalled();
  });

  it('sends a route row dropped on the header to the end, not into a second copy', () => {
    const dataTransfer = stubTransfer();
    renderAuto('route');

    fireEvent.dragStart(routeRow(), { dataTransfer });
    fireEvent.drop(screen.getByRole('heading', { name: 'autoMode.dj.route' }).parentElement!, { dataTransfer });

    expect(actions.moveAutoRoute).toHaveBeenCalledWith('q-next');
    expect(actions.placeAutoTrack).not.toHaveBeenCalled();
  });

  it('shows which joins lost their transition and puts the repair forward', () => {
    state.playback.queue.push({
      id: 'later', queueId: 'q-later', title: 'Later song', artist: 'Later artist', source: 'preview' as const,
    });
    state.autoMode.staleSeams = ['q-later'];
    try {
      const { container } = renderAuto('route');
      const fix = screen.getByRole('button', { name: 'autoMode.route.fix' });
      expect(fix).toHaveAttribute('data-pending', '');
      expect(fix).toHaveAttribute('title', 'autoMode.route.mixPending');
      expect(container.querySelector('[data-drag-row="q-later"]')).toHaveAttribute('data-stale', '');
      expect(container.querySelector('[data-drag-row="q-next"]')).not.toHaveAttribute('data-stale');
    } finally {
      state.autoMode.staleSeams = [];
      state.playback.queue.pop();
    }
  });

  /* With the mixing off every join is a cut. A join that lost its transition
   * sounds like any other, and a repair of transitions has nothing to do. */
  it('neither flags joins nor offers the repair when the DJ does not mix', () => {
    state.playback.queue.push({
      id: 'later', queueId: 'q-later', title: 'Later song', artist: 'Later artist', source: 'preview' as const,
    });
    state.autoMode.staleSeams = ['q-later'];
    state.playback.djMixing = false;
    try {
      const { container } = renderAuto('route');
      expect(screen.queryByRole('button', { name: 'autoMode.route.fix' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'autoMode.route.add' })).toBeInTheDocument();
      expect(container.querySelector('[data-drag-row="q-later"]')).not.toHaveAttribute('data-stale');
    } finally {
      state.playback.djMixing = true;
      state.autoMode.staleSeams = [];
      state.playback.queue.pop();
    }
  });

  /* The cued row used to be the only one without a ⋯, and so the only one with
   * room for a full artist name — a layout difference nobody chose, produced by
   * withholding a menu. It keeps the actions that still apply instead. */
  it('gives a cued handoff the same menu, minus the actions it cannot take', () => {
    state.autoMode.transition.status = 'armed';
    try {
      const { container } = renderAuto('route');
      fireEvent.contextMenu(container.querySelector('[data-drag-row="q-next"]')!);
      const options = openContextMenu.mock.calls.at(-1)![0];
      // Loaded and mixing: it cannot be moved, and taking it out of the route
      // no longer means anything. Everything else still applies.
      expect(options.actions.map((action: { label: string }) => action.label)).toEqual([
        'musicExplorer.reference', 'musicExplorer.startDjFromCurrent', 'trackMenu',
      ]);
      options.actions[0].onSelect();
      expect(actions.useAutoTrackAsSource).toHaveBeenCalledWith(expect.objectContaining({ id: 'next' }));
      expect(actions.removeAutoRouteOccurrence).not.toHaveBeenCalled();
    } finally {
      state.autoMode.transition.status = 'idle';
    }
  });

  it('never offers to insert in front of a handoff that is already cued', () => {
    state.autoMode.transition.status = 'armed';
    try {
      const { container } = renderAuto('route');
      const cued = container.querySelector('[data-drag-row="q-next"]')!;
      expect(cued).toHaveAttribute('data-drag-fixed', '');
      // Nor is it something the listener can pick up and drop elsewhere.
      expect(cued).not.toHaveAttribute('draggable', 'true');
    } finally {
      state.autoMode.transition.status = 'idle';
    }
  });

  it('reaches Sources from the transport chip, where a phone cannot drag across panels', () => {
    vi.useFakeTimers();
    renderAuto('route');
    fireEvent.pointerDown(routeRow(), { pointerType: 'touch', isPrimary: true });
    vi.advanceTimersByTime(460);

    const chip = screen.getByRole('status');
    fireEvent.click(within(chip).getByRole('button', { name: 'autoMode.route.useAsSource' }));
    expect(actions.useAutoTrackAsSource).toHaveBeenCalledWith(expect.objectContaining({ id: 'next' }));
  });

  it('keeps exact title-fit tiers exported for Stage', () => {
    expect(titleFit('Redbone')).toBe('lg');
    expect(titleFit('Ain’t No Mountain High Enough')).toBe('md');
  });
});


it('offers a manual retry without an endless loading indicator when candidates are exhausted', () => {
  const next = state.playback.queue.pop()!;
  state.autoMode.phase = 'exhausted';
  try {
    const { container } = renderAuto('route');
    expect(screen.getByRole('status')).toHaveTextContent('autoMode.route.exhausted');
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(actions.retryAutoRoute).toHaveBeenCalledTimes(1);
  } finally {
    state.autoMode.phase = 'ready';
    state.playback.queue.push(next);
  }
});


it('shows warming feedback without a terminal retry button', () => {
  const next = state.playback.queue.pop()!;
  state.autoMode.phase = 'warming';
  try {
    const { container } = renderAuto('route');
    expect(screen.getByRole('status')).toHaveTextContent('autoMode.route.warming:Current song');
    expect(screen.getByRole('status')).toHaveTextContent('autoMode.route.warmingHint');
    expect(container.querySelector('[data-route-loading="warming"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'common.retry' })).not.toBeInTheDocument();
  } finally {
    state.autoMode.phase = 'ready';
    state.playback.queue.push(next);
  }
});

/* Nothing is playing yet: the stage is where the listener who pressed "Start a
 * DJ session" looks, so it tells them what the DJ is doing about the first song. */
describe('the stage before the first song', () => {
  const withoutTrack = (phase: typeof state.autoMode.phase, run: () => void) => {
    const current = state.playback.currentTrack;
    state.playback.currentTrack = null;
    state.autoMode.phase = phase;
    try {
      run();
    } finally {
      state.playback.currentTrack = current;
      state.autoMode.phase = 'ready';
      state.autoMode.activity = null;
    }
  };

  it('says the DJ is choosing the opening, and from what', () => withoutTrack('planning', () => {
    renderAuto('stage');
    const stage = within(screen.getByTestId('shared-stage'));
    expect(stage.getByRole('status')).toHaveTextContent('autoMode.booth.opening');
    expect(stage.getByRole('status')).toHaveTextContent('autoMode.source.added:Warehouse techno');
    expect(stage.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(stage.queryByRole('button')).not.toBeInTheDocument();
  }));

  it('offers to retry an opening that failed rather than waiting on the backoff', () => withoutTrack('degraded', () => {
    renderAuto('stage');
    const stage = within(screen.getByTestId('shared-stage'));
    expect(stage.getByRole('status')).toHaveTextContent('autoMode.agent.openingFailed');
    fireEvent.click(stage.getByRole('button', { name: 'common.retry' }));
    expect(actions.retryAutoRoute).toHaveBeenCalledOnce();
  }));

  it('asks for music when there was nothing to open from', () => withoutTrack('idle', () => {
    state.autoMode.activity = { id: 1, status: 'error', key: 'autoMode.noSeed' };
    const onPanelChange = vi.fn();
    render(() => <AutoMode panel="stage" onPanelChange={onPanelChange} surfaceOpen />);
    const stage = within(screen.getByTestId('shared-stage'));
    expect(stage.getByText('autoMode.noSeed')).toBeInTheDocument();
    fireEvent.click(stage.getByRole('button', { name: 'musicExplorer.referenceEmpty' }));
    expect(onPanelChange).toHaveBeenCalledWith('browser');
    expect(screen.getByRole('complementary', { name: 'source-browser' })).toHaveAttribute('data-purpose', 'auto-reference');
  }));
});
