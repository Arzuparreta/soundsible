import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const community = vi.hoisted(() => ({
  config: {
    enabled: true,
    source: 'official',
    state: 'available',
    api_url: 'https://relay.test',
    secure_url: 'https://station.tail.test',
  },
  error: null as string | null,
  host: null as Record<string, unknown> | null,
  publisherState: 'idle',
  program: null as Record<string, unknown> | null,
  sessions: [] as Array<Record<string, unknown>>,
  secure: true,
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
  liveMediaSecure: () => community.secure,
  liveProgram: () => community.program,
  liveRoomLink: (id: string) => `https://hub.test/live/?session=${id}`,
  liveSessions: () => community.sessions,
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
    secure_url: 'https://station.tail.test',
  };
  community.error = null;
  community.host = null;
  community.publisherState = 'idle';
  community.program = null;
  community.sessions = [];
  community.secure = true;
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

  it('hands out a public hub link that needs no station of its own', async () => {
    community.host = {
      id: 'session-test',
      title: 'Saturday',
      listener_count: 0,
      host: { display_name: 'Local DJ' },
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    render(() => <Live />);
    await fireEvent.click(screen.getByRole('button', { name: 'Share room' }));

    expect(writeText).toHaveBeenCalledWith('https://hub.test/live/?session=session-test');
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeVisible();
    vi.unstubAllGlobals();
  });

  it('tells the DJ how long the air has been silent', () => {
    community.host = {
      id: 'session-test',
      title: 'Saturday',
      listener_count: 2,
      host: { display_name: 'Local DJ' },
    };
    community.publisherState = 'connected';
    const since = Date.now();
    community.program = {
      transport: 'paused',
      paused_since: since,
      emitted_at: since + 95_000,
      primary: { title: 'Hyperballad', artist: 'Björk' },
    };

    render(() => <Live />);

    expect(screen.getByText('You have been silent on air for 1:35.')).toBeVisible();
    expect(screen.queryByText('Your Soundsible master is live.')).not.toBeInTheDocument();
  });

  it('keeps a short gap between songs out of the host card', () => {
    community.host = {
      id: 'session-test',
      title: 'Saturday',
      listener_count: 2,
      host: { display_name: 'Local DJ' },
    };
    community.publisherState = 'connected';
    const since = Date.now();
    community.program = {
      transport: 'paused',
      paused_since: since,
      emitted_at: since + 4000,
      primary: { title: 'Hyperballad', artist: 'Björk' },
    };

    render(() => <Live />);

    expect(screen.getByText('Your Soundsible master is live.')).toBeVisible();
  });

  it('refuses to let the DJ join their own room and cut their own broadcast', () => {
    community.host = {
      id: 'session-test',
      title: 'Saturday',
      listener_count: 1,
      host: { display_name: 'Local DJ' },
    };
    community.sessions = [{
      id: 'session-test',
      status: 'live',
      title: 'Saturday',
      listener_count: 1,
      host: { id: 'me', display_name: 'Local DJ' },
      created_at: 1,
      updated_at: 1,
      whep_url: 'https://relay.test/media/whep',
    }];

    render(() => <Live />);

    expect(screen.getByText(/Your room/)).toBeVisible();
    expect(screen.getByRole('button', { name: /Your room/ })).toBeDisabled();
  });

  it('marks a resting room in the directory instead of pretending it is playing', () => {
    community.sessions = [{
      id: 'other-session',
      status: 'live',
      title: 'Late shift',
      listener_count: 8,
      host: { id: 'dj', display_name: 'Remote DJ' },
      created_at: 1,
      updated_at: 1,
      whep_url: 'https://relay.test/media/whep',
      program: {
        transport: 'paused',
        paused_since: 1,
        emitted_at: 2,
        primary: { title: 'Hyperballad', artist: 'Björk' },
      },
    }];

    render(() => <Live />);

    expect(screen.getByText('On a break')).toHaveAttribute('data-status', 'paused');
  });

  it('blocks broadcasting from an insecure IP origin and offers localhost', () => {
    community.secure = false;

    render(() => <Live />);

    expect(screen.getByRole('button', { name: 'Go live' })).toBeDisabled();
    expect(screen.getByText(/Live broadcasting needs HTTPS/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the secure station' }))
      .toHaveAttribute('href', 'https://station.tail.test/player/#/live');
  });

  it('gives an insecure station without a secure address the command that makes one', () => {
    community.secure = false;
    community.config = { ...community.config, secure_url: undefined as unknown as string };

    render(() => <Live />);

    expect(screen.getByRole('button', { name: 'Go live' })).toBeDisabled();
    expect(screen.getByText('tailscale serve --bg --yes 5005')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open the secure station' })).not.toBeInTheDocument();
  });
});
