import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  communityResourceLocation,
  openCommunityListener,
  openCommunityPublisher,
  parseIceServerLinks,
} from './communityWebrtc';

const offer = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=ice-ufrag:local-user',
  'a=ice-pwd:local-password',
  'a=rtpmap:111 opus/48000/2',
  '',
].join('\r\n');

class FakePeerConnection {
  static configurations: RTCConfiguration[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  listeners = new Map<string, Array<(event: any) => void>>();
  transceiverAdded = false;

  constructor(configuration: RTCConfiguration) {
    FakePeerConnection.configurations.push(configuration);
  }

  addEventListener(name: string, callback: (event: any) => void) {
    const current = this.listeners.get(name) ?? [];
    current.push(callback);
    this.listeners.set(name, current);
  }

  addTrack() {
    return {
      getParameters: () => ({ encodings: [] as RTCRtpEncodingParameters[] }),
      setParameters: async () => undefined,
    };
  }

  addTransceiver() {
    this.transceiverAdded = true;
    return {};
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: offer };
  }

  async setLocalDescription(value: RTCSessionDescriptionInit) {
    this.localDescription = value;
    const candidate = {
      candidate: 'candidate:1 1 UDP 2122260223 192.0.2.10 50000 typ host',
      sdpMLineIndex: 0,
    };
    for (const callback of this.listeners.get('icecandidate') ?? []) callback({ candidate });
  }

  async setRemoteDescription() {
    this.connectionState = 'connected';
  }

  close() {
    this.connectionState = 'closed';
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakePeerConnection.configurations = [];
});

describe('Community WebRTC transport', () => {
  it('parses usable RFC 9725 ICE links and skips malformed entries', () => {
    expect(parseIceServerLinks([
      '<https://not-ice.example>; rel="alternate"',
      '<turn:relay.example:3478?transport=tcp>; rel="ice-server"; username="user\\"name"; credential="secret"; credential-type="password"',
      'broken',
      '<stun:stun.example:3478>; rel="ice-server"',
    ].join(', '))).toEqual([
      {
        urls: ['turn:relay.example:3478?transport=tcp'],
        username: 'user"name',
        credential: 'secret',
      },
      { urls: ['stun:stun.example:3478'] },
    ]);
  });

  it('discovers TURN, trickles queued candidates, and cleans up the WHIP resource', async () => {
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            Link: '<turn:relay.example:3478?transport=tcp>; rel="ice-server"; username="u"; credential="p"; credential-type="password"',
          },
        });
      }
      if (init?.method === 'POST') {
        return new Response('answer', { status: 201, headers: { Location: '/live/resource' } });
      }
      return new Response(null, { status: 204 });
    }));
    const stream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;

    const handle = await openCommunityPublisher({
      endpoint: 'https://relay.example/media/live/whip',
      token: 'publish-token',
      stream,
    });

    expect(FakePeerConnection.configurations[0]).toMatchObject({
      iceServers: [{ urls: ['turn:relay.example:3478?transport=tcp'], username: 'u', credential: 'p' }],
    });
    expect(calls[0].init?.headers).toEqual({ Authorization: 'Bearer publish-token' });
    const patch = calls.find((call) => call.init?.method === 'PATCH');
    expect(patch?.url).toBe('https://relay.example/media/live/resource');
    expect(patch?.init?.headers).toMatchObject({
      'Content-Type': 'application/trickle-ice-sdpfrag',
      'If-Match': '*',
    });
    expect(patch?.init?.body).toContain('a=ice-ufrag:local-user\r\n');
    expect(patch?.init?.body).toContain('a=candidate:1 1 UDP');

    handle.close();
    await vi.waitFor(() => expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(true));
  });

  it('uses the same discovery and trickle path for WHEP listeners', async () => {
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
      if (init?.method === 'POST') {
        return new Response('answer', { status: 201, headers: { Location: '/read/resource' } });
      }
      return new Response(null, { status: 204 });
    }));

    const handle = await openCommunityListener({ endpoint: 'https://relay.example/media/live/whep' });

    expect((handle.pc as unknown as FakePeerConnection).transceiverAdded).toBe(true);
    handle.close();
  });

  it('keeps MediaMTX resource URLs behind the public media prefix', () => {
    const response = new Response('', { status: 201, headers: { Location: '/live/resource' } });
    expect(communityResourceLocation('https://relay.example/media/live/whip', response))
      .toBe('https://relay.example/media/live/resource');
  });
});
