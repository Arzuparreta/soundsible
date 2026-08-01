import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { actions, apiMock, state } = vi.hoisted(() => ({
  actions: {
    setAutoDjProfile: vi.fn(),
    setAutoDirection: vi.fn(),
    requestAutoTrack: vi.fn(),
    requestAutoArtist: vi.fn(),
    cancelAutoRequest: vi.fn(),
    promoteInAutoRoute: vi.fn(),
    reportAutoActivity: vi.fn(),
  },
  apiMock: {
    getArtistProfile: vi.fn(),
    searchCatalog: vi.fn(),
    resolveCatalogItem: vi.fn(),
    interpretDjCommand: vi.fn(),
  },
  state: {
    library: [],
    playback: {
      currentTrack: { id: 'current', title: 'Current song', artist: 'Artist', cover: '/current.jpg' },
      queue: [
        { id: 'current', queueId: 'q-current', title: 'Current song', artist: 'Artist', cover: '/current.jpg' },
        { id: 'next', queueId: 'q-next', title: 'Next song', artist: 'Next artist', cover: '/next.jpg', source: 'preview' as const },
      ],
      index: 0,
      isPlaying: true,
    },
    autoMode: {
      active: true,
      djProfile: 'adaptive' as const,
      direction: { energy: 0, familiarity: 0, prompt: '', include: [], exclude: [] },
      requests: [],
      transition: { status: 'idle' as const } as { status: 'idle' | 'armed' | 'mixing'; technique?: string; nextTrackId?: string },
      pendingDirection: false,
      activity: null as null | { id: number; status: 'working' | 'done' | 'error'; key: string; values?: Record<string, string | number> },
      plan: {
        next: {
          trackId: 'next',
          fromKey: 'current',
          source: 'related' as const,
          reasonKey: 'autoMode.reason.related',
          reasonValues: { title: 'Current song' },
          transition: { technique: 'long_blend' },
          bpm: 128,
          key: 'Am',
        },
      },
    },
  },
}));

vi.mock('../stores', () => ({ actions, state }));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${Object.values(params).join(',')}` : key,
}));
vi.mock('./PlayerStage', () => ({
  PlayerStage: (props: { mode: string }) => <div data-testid="shared-stage" data-mode={props.mode} />,
}));
vi.mock('./NowPlayingBrowser', () => ({
  NowPlayingBrowser: (props: { purpose?: string; onClose: () => void }) => (
    <aside aria-label="shared-request-search" data-purpose={props.purpose}>
      <button type="button" onClick={props.onClose}>close request</button>
    </aside>
  ),
}));

import { AutoMode, titleFit } from './AutoMode';

function renderAuto(panel: 'booth' | 'stage' | 'route' = 'stage') {
  const onPanelChange = vi.fn();
  const result = render(() => (
    <AutoMode
      panel={panel}
      onPanelChange={onPanelChange}
      surfaceOpen
    />
  ));
  return { ...result, onPanelChange };
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.autoMode.transition = { status: 'idle' };
  state.autoMode.requests = [];
  state.autoMode.activity = null;
  state.playback.queue = [
    { id: 'current', queueId: 'q-current', title: 'Current song', artist: 'Artist', cover: '/current.jpg' },
    { id: 'next', queueId: 'q-next', title: 'Next song', artist: 'Next artist', cover: '/next.jpg', source: 'preview' as const },
  ];
});

describe('AutoMode workspace', () => {
  it('composes Booth, the shared Stage and the full Route in one workspace', () => {
    renderAuto();

    expect(screen.getByRole('region', { name: 'autoMode.workspace.aria' })).toBeInTheDocument();
    expect(screen.getByTestId('shared-stage')).toHaveAttribute('data-mode', 'auto');
    expect(screen.getByRole('heading', { name: 'autoMode.dj.route' })).toBeInTheDocument();
    expect(screen.getByText('Next song')).toBeInTheDocument();
    expect(screen.getAllByText(/128 BPM/)).toHaveLength(2);
  });

  it('expands DJ profiles inline and never creates a dialog', () => {
    renderAuto('booth');

    fireEvent.click(screen.getByRole('button', { name: /autoMode\.dj\.changeCurrent/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /autoMode\.dj\.cutsDrops/ }));
    expect(actions.setAutoDjProfile).toHaveBeenCalledWith('cuts_drops');
  });

  it('closes the inline DJ expander when the player-owned panel changes', () => {
    function Harness() {
      const [panel, setPanel] = createSignal<'booth' | 'stage' | 'route'>('booth');
      return (
        <>
          <button type="button" onClick={() => setPanel('stage')}>change panel</button>
          <AutoMode panel={panel()} onPanelChange={setPanel} surfaceOpen />
        </>
      );
    }
    render(() => <Harness />);
    fireEvent.click(screen.getByRole('button', { name: /autoMode\.dj\.changeCurrent/ }));
    expect(screen.getAllByRole('option')).toHaveLength(4);

    fireEvent.click(screen.getByRole('button', { name: 'change panel' }));
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('keeps both direction switches visible and applies their settings', () => {
    renderAuto('booth');

    expect(screen.getAllByRole('button', { name: 'autoMode.booth.hold' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.booth.energyUp' }));
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.booth.crateDeep' }));
    expect(actions.setAutoDirection).toHaveBeenCalledWith({ energy: 0.65, prompt: '' }, 'autoMode.note.energy.up');
    expect(actions.setAutoDirection).toHaveBeenCalledWith({ familiarity: -0.65, prompt: '' }, 'autoMode.note.crate.deep');
  });

  it('opens the shared global search inside Booth with request as its purpose', () => {
    renderAuto('booth');

    fireEvent.click(screen.getByRole('button', { name: /autoMode\.dj\.request/ }));
    expect(screen.getByRole('complementary', { name: 'shared-request-search' })).toHaveAttribute('data-purpose', 'auto-request');
  });

  it('shows pending requests with ETA and cancellation', () => {
    (state.autoMode.requests as Array<{
      id: string;
      label: string;
      etaTracks: number | null;
    }>).push({ id: 'request-1', label: 'Requested Song', etaTracks: 2 });
    renderAuto('booth');

    expect(screen.getByText('Requested Song')).toBeInTheDocument();
    expect(screen.getByText('autoMode.dj.withinTracks:2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.dj.cancelRequest:Requested Song' }));
    expect(actions.cancelAutoRequest).toHaveBeenCalledWith('request-1');
  });

  it('preserves spoken artist requests as planner destinations', async () => {
    apiMock.interpretDjCommand.mockResolvedValue({
      v: 1,
      understood: true,
      direction_patch: {},
      request: { kind: 'artist', label: 'Oliver Heldens', artist: { name: 'Oliver Heldens' } },
    });
    renderAuto('booth');

    const command = screen.getByRole('textbox', { name: 'autoMode.dj.commandAria' });
    fireEvent.input(command, { target: { value: 'pon oliver heldens' } });
    fireEvent.submit(command.closest('form')!);

    await waitFor(() => expect(actions.requestAutoArtist).toHaveBeenCalledWith('Oliver Heldens'));
    expect(actions.requestAutoTrack).not.toHaveBeenCalled();
  });

  it('locks a committed handoff but promotes later route entries', () => {
    state.autoMode.transition = { status: 'armed', nextTrackId: 'next', technique: 'long_blend' };
    renderAuto('route');

    expect(screen.getByRole('button', { name: /Next song/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /autoMode\.dj\.promote/ })).not.toBeInTheDocument();
  });

  it('designs an empty route instead of leaving a clipped blank panel', () => {
    state.playback.queue = [state.playback.queue[0]];
    renderAuto('route');

    expect(screen.getAllByText('autoMode.mobile.routeEmpty')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'autoMode.dj.route' })).toBeInTheDocument();
  });

  it('persists an independent desktop layout and the stage-only preference', () => {
    const { onPanelChange } = renderAuto();
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.workspace.stageOnly' }));

    expect(onPanelChange).toHaveBeenCalledWith('stage');
    expect(JSON.parse(localStorage.getItem('auto:desktopLayout:v1')!)).toMatchObject({
      order: ['booth', 'stage', 'route'],
      stageOnly: true,
    });
    expect(localStorage.getItem('np:desktopLayout:v1')).toBeNull();
  });

  it('retains stable title tiers for callers while Stage owns actual overflow', () => {
    expect(titleFit('Redbone')).toBe('lg');
    expect(titleFit('Ain’t No Mountain High Enough')).toBe('md');
    expect(titleFit('Ain’t No Mountain High Enough (Remastered 2019)')).toBe('sm');
    expect(titleFit('Ain’t No Mountain High Enough (Remastered 2019 Deluxe Edition Version)')).toBe('xs');
  });
});
