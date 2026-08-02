import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { actions, openActionMenu, openContextMenu, state } = vi.hoisted(() => ({
  actions: {
    setAutoSourceBoundary: vi.fn(), removeAutoSource: vi.fn(), useAutoTrackAsSource: vi.fn(),
    removeAutoRouteOccurrence: vi.fn(), avoidAutoTrackForSession: vi.fn(), moveAutoRoute: vi.fn(), playNow: vi.fn(),
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
      sources: [{ id: 'source-1', label: 'Warehouse techno', boundary: 'from' as const, tracks: [{ id: 'root', title: 'Root', artist: 'DJ' }] }],
      requests: [],
      transition: { status: 'idle' as const },
      plan: { next: { trackId: 'next', fromKey: 'current', source: 'related' as const, reasonKey: '', sourceSetLabel: 'Warehouse techno', lineage: ['root', 'next'] } },
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

afterEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('AutoMode workspace', () => {
  it('composes Search/Library, Stage and Route and exposes the source boundary', () => {
    renderAuto('browser');
    expect(screen.getByTestId('shared-stage')).toHaveAttribute('data-mode', 'auto');
    expect(screen.getByRole('complementary', { name: 'source-browser' })).toHaveAttribute('data-purpose', 'auto-source');
    expect(screen.getByText('Warehouse techno')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.source.toggle:Warehouse techno' }));
    expect(actions.setAutoSourceBoundary).toHaveBeenCalledWith('source-1', 'inside');
  });

  it('shows lineage and exposes explicit actions through one route menu', () => {
    renderAuto('route');
    expect(screen.getAllByText(/Warehouse techno/)).toHaveLength(2);
    expect(screen.queryByText('＋')).not.toBeInTheDocument();
    expect(screen.queryByText('−')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.route.actions:Next song' }));
    const menu = openActionMenu.mock.calls[0][0];
    expect(menu.actions.map((action: { label: string }) => action.label)).toEqual([
      'autoMode.route.useAsSource', 'autoMode.route.remove', 'autoMode.route.avoidSession',
    ]);
    menu.actions[0].onSelect();
    menu.actions[1].onSelect();
    menu.actions[2].onSelect();
    expect(actions.useAutoTrackAsSource).toHaveBeenCalledWith(expect.objectContaining({ id: 'next' }));
    expect(actions.removeAutoRouteOccurrence).toHaveBeenCalledWith('q-next');
    expect(actions.avoidAutoTrackForSession).toHaveBeenCalledWith('q-next');
  });

  it('keeps exact title-fit tiers exported for Stage', () => {
    expect(titleFit('Redbone')).toBe('lg');
    expect(titleFit('Ain’t No Mountain High Enough')).toBe('md');
  });
});
