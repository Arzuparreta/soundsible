import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socket = {
  connected: true,
  on: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
  io: { on: vi.fn() },
};

vi.mock('socket.io-client', () => ({ io: () => socket }));

import {
  communityConfig,
  communityError,
  createHostSession,
  joinLiveSession,
  leaveLiveSession,
  listenerState,
  loadCommunityConfig,
  publisherState,
  resetCommunityStateForTests,
  startHostPublisher,
  startListening,
  type HostLiveSession,
} from './community';

class FakeMediaStream {
  tracks: unknown[] = [];
  addTrack(track: unknown) {
    this.tracks.push(track);
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.length ? this.tracks : [{ kind: 'audio' }];
  }
}

class FakePeerConnection {
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: RTCSessionDescriptionInit | null = null;
  listeners = new Map<string, Array<() => void>>();
  addTrack() {
    return {
      getParameters: () => ({ encodings: [] as RTCRtpEncodingParameters[] }),
      setParameters: async () => undefined,
    };
  }
  addTransceiver() {
    return {};
  }
  addEventListener(name: string, callback: () => void) {
    const current = this.listeners.get(name) ?? [];
    current.push(callback);
    this.listeners.set(name, current);
  }
  removeEventListener() {}
  async createOffer() {
    return { type: 'offer' as const, sdp: 'a=rtpmap:111 opus/48000/2\r\n' };
  }
  async setLocalDescription(value: RTCSessionDescriptionInit) {
    this.localDescription = value;
  }
  async setRemoteDescription() {
    this.connectionState = 'connected';
    for (const callback of this.listeners.get('connectionstatechange') ?? []) callback();
  }
  async getStats() {
    return new Map();
  }
  close() {
    this.connectionState = 'closed';
    for (const callback of this.listeners.get('connectionstatechange') ?? []) callback();
  }
}

const session: HostLiveSession = {
  id: 'session-test-123',
  status: 'waiting',
  title: 'Saturday',
  host: { id: 'host', display_name: 'DJ' },
  created_at: 1,
  updated_at: 1,
  listener_count: 0,
  whep_url: 'https://relay.test/media/live/whep',
  whip_url: 'https://relay.test/media/live/whip',
  socket_url: 'https://relay.test',
  stream_path: 'live_test',
  host_token: 'host-token',
  publish_token: 'publish-token',
  reconnect_grace_seconds: 90,
};

function json(payload: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  localStorage.clear();
  socket.on.mockClear();
  socket.io.on.mockClear();
  socket.disconnect.mockClear();
  await resetCommunityStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Community client state', () => {
  it('loads the official ready-to-use service contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      enabled: true,
      api_url: 'https://live.84-247-161-82.sslip.io',
      source: 'official',
      state: 'available',
      error: null,
      identity: { community_id: 'public-id' },
    })));

    await loadCommunityConfig(true);

    expect(communityConfig()?.source).toBe('official');
    expect(communityConfig()?.state).toBe('available');
    expect(communityError()).toBeNull();
  });

  it('turns relay capacity into an actionable UI state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: 'The live directory is at capacity',
      code: 'session_capacity',
    }, 503)));

    await expect(createHostSession('Full room')).rejects.toMatchObject({ status: 503 });
    expect(communityError()).toBe('capacity');
  });

  it('recovers WHIP with bounded backoff and reports the connection', async () => {
    let whipCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/community/sessions')) return json({ session }, 201);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      whipCalls += 1;
      if (whipCalls === 1) return new Response('busy', { status: 503 });
      return new Response('answer', {
        status: 201,
        headers: { Location: '/live/resource' },
      });
    }));
    await createHostSession('Saturday');
    const stream = new FakeMediaStream() as unknown as MediaStream;

    await expect(startHostPublisher(stream)).rejects.toThrow('whip_503');
    expect(publisherState()).toBe('recovering');
    await vi.advanceTimersByTimeAsync(1000);

    expect(whipCalls).toBe(2);
    expect(publisherState()).toBe('connected');
    expect(communityError()).toBeNull();
  });

  it('rebuilds an authorised WHEP listener and leaves no retry behind', async () => {
    let whepCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      whepCalls += 1;
      if (whepCalls === 1) return new Response('offline', { status: 502 });
      return new Response('answer', { status: 201, headers: { Location: '/live/read' } });
    }));
    joinLiveSession(session);

    await expect(startListening()).rejects.toThrow('whep_502');
    expect(listenerState()).toBe('recovering');
    await vi.advanceTimersByTimeAsync(1000);
    expect(whepCalls).toBe(2);
    expect(listenerState()).toBe('connected');

    await leaveLiveSession();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(whepCalls).toBe(2);
    expect(listenerState()).toBe('idle');
  });
});
