import { fireEvent, render, screen } from '@solidjs/testing-library';
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
      transition: { status: 'idle' as const },
      repairing: false,
      pendingDirection: false,
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

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); localStorage.clear(); });

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

  it('keeps exact title-fit tiers exported for Stage', () => {
    expect(titleFit('Redbone')).toBe('lg');
    expect(titleFit('Ain’t No Mountain High Enough')).toBe('md');
  });
});
