import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const community = vi.hoisted(() => ({
  config: { enabled: true, source: 'official', state: 'available', api_url: 'https://relay.test' },
  error: null as string | null,
  host: null as Record<string, unknown> | null,
  publisherState: 'idle',
  end: vi.fn(),
  retry: vi.fn(),
  init: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../stores', () => ({
  state: { playback: { isPlaying: false } },
  actions: { togglePlay: vi.fn() },
}));
vi.mock('../lib/session', () => ({
  user: () => ({ display_name: 'Local DJ' }),
}));
vi.mock('../components/LiveRoomPanel', () => ({
  LiveRoomPanel: () => <div>{String(community.host?.listener_count ?? 0)} listeners</div>,
}));
vi.mock('../lib/community', () => ({
  communityConfig: () => community.config,
  communityError: () => community.error,
  createHostSession: community.create,
  endHostSession: community.end,
  hostSession: () => community.host,
  initCommunity: community.init,
  joinedSession: () => null,
  joinLiveSession: vi.fn(),
  leaveLiveSession: vi.fn(),
  listenerState: () => 'idle',
  listenerStream: () => null,
  liveProgram: () => null,
  liveSessions: () => [],
  publisherConnected: () => community.publisherState === 'connected',
  publisherState: () => community.publisherState,
  refreshLiveSessions: vi.fn(),
  retryCommunity: community.retry,
  retryHostPublisher: vi.fn(),
  retryListening: vi.fn(),
  startListening: vi.fn(),
  updateHostTitle: vi.fn(),
}));

import Live from './Live';

beforeEach(() => {
  community.config = {
    enabled: true,
    source: 'official',
    state: 'available',
    api_url: 'https://relay.test',
  };
  community.error = null;
  community.host = null;
  community.publisherState = 'idle';
  community.end.mockReset();
  community.retry.mockReset();
  community.init.mockReset();
  community.create.mockReset().mockResolvedValue({});
});

describe('Live operational UI', () => {
  it('enables broadcasting with the official service and creates a room', async () => {
    render(() => <Live />);
    const button = screen.getByRole('button', { name: 'Go live' });

    expect(button).toBeEnabled();
    await fireEvent.click(button);
    expect(community.create).toHaveBeenCalledWith('Session by Local DJ');
  });

  it('shows capacity with a manual retry', async () => {
    community.error = 'capacity';
    render(() => <Live />);

    expect(screen.getByText('The live directory is currently at capacity.')).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(community.retry).toHaveBeenCalledOnce();
  });

  it('shows audio recovery and lets the DJ end the broadcast', async () => {
    community.host = {
      id: 'session-test',
      title: 'Saturday',
      listener_count: 3,
      host: { display_name: 'Local DJ' },
    };
    community.publisherState = 'recovering';
    render(() => <Live />);

    expect(screen.getByText('Recovering audio')).toBeVisible();
    expect(screen.getByText('3 listeners')).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(community.end).toHaveBeenCalledOnce();
  });

  it('shows the real connection phase after playback starts', () => {
    community.host = {
      id: 'session-test',
      title: 'Saturday',
      listener_count: 0,
      host: { display_name: 'Local DJ' },
    };
    community.publisherState = 'connecting';

    render(() => <Live />);

    expect(screen.getByText('Connecting audio')).toBeVisible();
    expect(screen.queryByText('About to start')).not.toBeInTheDocument();
  });
});
