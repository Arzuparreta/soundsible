import { render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveProgram } from '../lib/community';

const { audio, community, state } = vi.hoisted(() => ({
  audio: {
    stream: { id: 'broadcast' } as unknown as MediaStream | null,
    lost: null as (() => void) | null,
    release: vi.fn(),
    mix: {
      contextTime: 0,
      activeIndex: 0,
      phase: 'idle' as const,
      progress: 0,
      dominant: false,
      decks: [{ index: 0, position: 12, duration: 200, gain: 1 }],
    },
  },
  community: {
    host: { id: 'session-test' } as Record<string, unknown> | null,
    connected: true,
    sent: [] as LiveProgram[],
    publish: vi.fn(),
    reportLost: vi.fn(),
  },
  state: {
    playback: {
      currentTrack: { id: 'track-1', title: 'Hyperballad', artist: 'Björk', duration: 200 },
      queue: [] as unknown[],
      index: 0,
      currentTime: 12,
      duration: 200,
      isPlaying: true,
    },
  },
}));

vi.mock('../stores', () => ({ state }));
vi.mock('../lib/media', () => ({ coverUrl: () => '/cover.jpg' }));
vi.mock('../lib/audio', () => ({
  broadcastStream: () => audio.stream,
  programMixSnapshot: () => audio.mix,
  releaseBroadcastStream: audio.release,
  setBroadcastLostReporter: (fn: (() => void) | null) => { audio.lost = fn; },
}));
vi.mock('../lib/community', () => ({
  hostSession: () => community.host,
  publisherConnected: () => community.connected,
  reportBroadcastLost: community.reportLost,
  resumeCommunityIfActive: vi.fn(),
  sendProgramEvent: (payload: LiveProgram) => { community.sent.push(payload); },
  startHostPublisher: community.publish,
  uploadHostArtwork: vi.fn().mockResolvedValue(null),
}));

import { CommunityBridge } from './CommunityBridge';

beforeEach(() => {
  vi.useFakeTimers();
  audio.stream = { id: 'broadcast' } as unknown as MediaStream;
  audio.lost = null;
  community.host = { id: 'session-test' };
  community.connected = true;
  community.sent = [];
  community.publish.mockReset().mockResolvedValue(undefined);
  community.reportLost.mockReset();
  state.playback.isPlaying = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CommunityBridge', () => {
  it('slows to a heartbeat while the DJ is paused and dates the break', async () => {
    render(() => <CommunityBridge />);
    await vi.advanceTimersByTimeAsync(250);
    expect(community.sent.at(-1)?.transport).toBe('playing');

    state.playback.isPlaying = false;
    await vi.advanceTimersByTimeAsync(250);

    const paused = community.sent.at(-1)!;
    expect(paused.transport).toBe('paused');
    expect(paused.paused_since).toBeTypeOf('number');
    const beats = community.sent.length;

    // Four seconds of silence must not become sixteen program events.
    await vi.advanceTimersByTimeAsync(4000);
    expect(community.sent.length).toBe(beats);

    await vi.advanceTimersByTimeAsync(1500);
    expect(community.sent.length).toBe(beats + 1);
    // The break is dated from where it started, not from the latest beat.
    expect(community.sent.at(-1)!.paused_since).toBe(paused.paused_since);
    expect(community.sent.at(-1)!.emitted_at).toBeGreaterThan(paused.emitted_at);
  });

  it('resumes tick-rate reporting as soon as the music comes back', async () => {
    render(() => <CommunityBridge />);
    state.playback.isPlaying = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(community.sent.at(-1)!.transport).toBe('paused');

    state.playback.isPlaying = true;
    await vi.advanceTimersByTimeAsync(500);

    expect(community.sent.at(-1)!.transport).toBe('playing');
    expect(community.sent.at(-1)!.paused_since).toBeNull();
  });

  it('stops claiming to publish when the mixing graph takes the tap down', async () => {
    render(() => <CommunityBridge />);
    await vi.advanceTimersByTimeAsync(250);
    expect(community.publish).toHaveBeenCalledOnce();

    // The graph died: the tap is gone and will not come back this page load.
    audio.stream = null;
    audio.lost?.();
    expect(community.reportLost).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1000);
    expect(community.publish).toHaveBeenCalledOnce();
  });
});
