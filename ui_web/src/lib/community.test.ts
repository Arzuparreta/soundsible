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
  endHostSession,
  joinLiveSession,
  leaveLiveSession,
  listenerState,
  loadCommunityConfig,
  publisherConnected,
  publisherState,
  replaceHostPublisherTrack,
  reportBroadcastLost,
  resetCommunityStateForTests,
  startHostPublisher,
  startListening,
  type HostLiveSession,
} from './community';

class FakeMediaStream {
  tracks: unknown[] = [];
  fallbackTrack = { kind: 'audio' };
  addTrack(track: unknown) {
    this.tracks.push(track);
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.length ? this.tracks : [this.fallbackTrack];
  }
}

class FakePeerConnection {
  static last: FakePeerConnection | null = null;
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: RTCSessionDescriptionInit | null = null;
  listeners = new Map<string, Array<() => void>>();
  senders: Array<{ track: { kind: string }; replaceTrack: ReturnType<typeof vi.fn> }> = [];
  constructor() {
    FakePeerConnection.last = this;
  }
  addTrack(track: { kind: string }) {
    const sender = {
      track,
      getParameters: () => ({ encodings: [] as RTCRtpEncodingParameters[] }),
      setParameters: async () => undefined,
      replaceTrack: vi.fn(async (track: { kind: string }) => { sender.track = track; }),
    };
    this.senders.push(sender);
    return sender;
  }
  getSenders() { return this.senders; }
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
    return {
      type: 'offer' as const,
      sdp: [
        'v=0',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111',
        'a=ice-ufrag:test-ufrag',
        'a=ice-pwd:test-password',
        'a=rtpmap:111 opus/48000/2',
        '',
      ].join('\r\n'),
    };
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
  reconnect_grace_seconds: 15,
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

  it('resumes the DJ session when the browser origin has no local host state', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/community/sessions')) {
        return json({
          error: 'This DJ already has an active session',
          code: 'session_already_active',
          session_id: session.id,
        }, 409);
      }
      return json({ session });
    }));

    const resumed = await createHostSession('Saturday');

    expect(resumed.id).toBe(session.id);
    expect(calls).toEqual([
      'http://localhost:3000/api/community/sessions',
      `http://localhost:3000/api/community/sessions/${session.id}/resume`,
    ]);
  });

  it('disconnects the local publisher before requesting remote session deletion', async () => {
    const order: string[] = [];
    socket.disconnect.mockImplementationOnce(() => { order.push('disconnect'); });
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        order.push('delete');
        return new Response(null, { status: 204 });
      }
      return json({ session }, 201);
    }));
    await createHostSession('Saturday');

    await endHostSession();

    expect(order).toEqual(['disconnect', 'delete']);
  });

  it('recovers WHIP with bounded backoff and reports the connection', async () => {
    let whipCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/community/sessions')) return json({ session }, 201);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
      whipCalls += 1;
      if (whipCalls === 1) return new Response('busy', { status: 503 });
      return new Response('answer', {
        status: 201,
        headers: { Location: '/live/resource' },
      });
    }));
    await createHostSession('Saturday');
    const stream = new FakeMediaStream() as unknown as MediaStream;

    await expect(startHostPublisher(stream)).rejects.toThrow('webrtc_offer_503');
    expect(publisherState()).toBe('recovering');
    await vi.advanceTimersByTimeAsync(1000);

    expect(whipCalls).toBe(2);
    expect(publisherState()).toBe('connected');
    expect(communityError()).toBeNull();
  });

  it('restarts from a replacement capture when the mixing graph dies under the broadcast', async () => {
    let whipCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/community/sessions')) return json({ session }, 201);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
      whipCalls += 1;
      return new Response('answer', { status: 201, headers: { Location: '/live/resource' } });
    }));
    await createHostSession('Saturday');
    await startHostPublisher(new FakeMediaStream() as unknown as MediaStream);
    expect(publisherState()).toBe('connected');

    reportBroadcastLost();

    expect(publisherState()).toBe('failed');
    expect(publisherConnected()).toBe(false);
    expect(communityError()).toBe('graph_lost');
    // The bridge can now hand over the restored direct-deck capture.
    await startHostPublisher(new FakeMediaStream() as unknown as MediaStream);
    expect(whipCalls).toBe(2);
    expect(publisherState()).toBe('connected');
    expect(communityError()).toBeNull();
  });

  it('replaces an element-capture track without reopening the room', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/community/sessions')) return json({ session }, 201);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
      return new Response('answer', { status: 201, headers: { Location: '/live/resource' } });
    }));
    await createHostSession('Saturday');
    await startHostPublisher(new FakeMediaStream() as unknown as MediaStream);

    await replaceHostPublisherTrack(new FakeMediaStream() as unknown as MediaStream);

    expect(publisherState()).toBe('connected');
    expect(FakePeerConnection.last?.senders[0].replaceTrack).toHaveBeenCalledOnce();
  });

  it('rebuilds an authorised WHEP listener and leaves no retry behind', async () => {
    let whepCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
      whepCalls += 1;
      if (whepCalls === 1) return new Response('offline', { status: 502 });
      return new Response('answer', { status: 201, headers: { Location: '/live/read' } });
    }));
    joinLiveSession(session);

    await expect(startListening()).rejects.toThrow('webrtc_offer_502');
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
