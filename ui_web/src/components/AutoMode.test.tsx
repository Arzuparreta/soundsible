import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { actions, openContextMenu, state } = vi.hoisted(() => ({
  actions: {
    setAutoSourceBoundary: vi.fn(), removeAutoSource: vi.fn(), feedbackAutoTrack: vi.fn(),
    removeQueueEntry: vi.fn(), moveAutoRoute: vi.fn(), playNow: vi.fn(),
  },
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
      plan: { next: { trackId: 'next', fromKey: 'current', source: 'related' as const, reasonKey: '', sourceSetLabel: 'Warehouse techno', branchId: 'branch-1', lineage: ['root', 'next'] } },
    },
  },
}));

vi.mock('../stores', () => ({ actions, state }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu }));
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

  it('shows lineage and offers session-local route feedback', () => {
    renderAuto('route');
    expect(screen.getAllByText(/Warehouse techno/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.route.moreLike:Next song' }));
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.route.lessLike:Next song' }));
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.route.remove:Next song' }));
    expect(actions.feedbackAutoTrack).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'next' }), 'more');
    expect(actions.feedbackAutoTrack).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'next' }), 'less');
    expect(actions.removeQueueEntry).toHaveBeenCalledWith('q-next');
  });

  it('keeps exact title-fit tiers exported for Stage', () => {
    expect(titleFit('Redbone')).toBe('lg');
    expect(titleFit('Ain’t No Mountain High Enough')).toBe('md');
  });
});
