import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { actions, openActionMenu, openContextMenu, state } = vi.hoisted(() => ({
  actions: {
    removeAutoSource: vi.fn(), useAutoTrackAsSource: vi.fn(), placeAutoTrack: vi.fn(),
    removeAutoRouteOccurrence: vi.fn(), avoidAutoTrackForSession: vi.fn(), moveAutoRoute: vi.fn(),
    repairAutoRoute: vi.fn(),
  },
  openActionMenu: vi.fn(),
  openContextMenu: vi.fn(),
  state: {
    playback: {
      currentTrack: { id: 'current', title: 'Current song', artist: 'Artist' },
      queue: [
        { id: 'current', queueId: 'q-current', title: 'Current song', artist: 'Artist' },
        { id: 'next', queueId: 'q-next', title: 'Next song', artist: 'Next artist', source: 'preview' as const },
      ], index: 0, isPlaying: true,
    },
    autoMode: {
      active: true,
      sources: [{ id: 'source-1', label: 'Warehouse techno', activation: 1, tracks: [{ id: 'root', title: 'Root', artist: 'DJ' }] }],
      transition: { status: 'idle' as 'idle' | 'armed' },
      repairing: false,
      pendingDirection: false,
      staleSeams: [] as string[],
      plan: { 'q-next': { trackId: 'next', fromKey: 'current', source: 'related' as const, reasonKey: '', sourceSetLabel: 'Warehouse techno', lineage: ['root', 'next'] } },
    },
  },
}));

vi.mock('../stores', () => ({ actions, state }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu }));
vi.mock('./ActionMenu', () => ({ openActionMenu }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/i18n', () => ({ t: (key: string, params?: Record<string, string | number>) => params ? `${key}:${Object.values(params).join(',')}` : key }));
vi.mock('./PlayerStage', () => ({ PlayerStage: (props: { mode: string }) => <div data-testid="shared-stage" data-mode={props.mode} /> }));
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
    expect(screen.getAllByText('Warehouse techno')).toHaveLength(2);
    // The Sources ＋ armed a mode whose whole payload was deferred until you
    // navigated into a collection, so pressing it looked like pressing nothing.
    expect(screen.queryByRole('button', { name: 'autoMode.source.title' })).not.toBeInTheDocument();
  });

  it('shows lineage and puts both route actions one press away, with no menu', () => {
    renderAuto('route');
    expect(screen.getAllByText(/Warehouse techno/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'autoMode.route.insertBefore:Next song' })).toBeInTheDocument();
    expect(screen.queryByText('···')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'autoMode.route.actions:Next song' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'autoMode.route.useAsSource' }));
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.route.remove' }));
    expect(openActionMenu).not.toHaveBeenCalled();
    expect(actions.useAutoTrackAsSource).toHaveBeenCalledWith(expect.objectContaining({ id: 'next' }));
    expect(actions.removeAutoRouteOccurrence).toHaveBeenCalledWith('q-next');
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
