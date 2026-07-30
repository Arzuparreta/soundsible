import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const created: FakeAudio[] = [];

class FakeAudio extends EventTarget {
  src = '';
  currentSrc = '';
  currentTime = 0;
  duration = 240;
  readyState = 4;
  paused = true;
  ended = false;
  volume = 1;
  muted = false;
  playbackRate = 1;
  preservesPitch = true;
  preload = '';
  crossOrigin: string | null = null;

  constructor() {
    super();
    created.push(this);
  }

  play = vi.fn(async () => {
    this.paused = false;
    this.currentSrc = this.src;
  });

  pause = vi.fn(() => {
    this.paused = true;
  });

  load = vi.fn();

  removeAttribute(name: string) {
    if (name === 'src') {
      this.src = '';
      this.currentSrc = '';
    }
  }

  getAttribute(name: string) {
    return name === 'src' && this.src ? this.src : null;
  }
}

const plan = {
  technique: 'filter_blend' as const,
  out_cue: 110,
  in_cue: 2,
  overlap_seconds: 4,
  overlap_bars: 8,
  playback_rate: 1,
  confidence: 0.8,
};

function callbacks() {
  return {
    onDominant: vi.fn(),
    onComplete: vi.fn(),
    onCancel: vi.fn(),
    onError: vi.fn(),
  };
}

/** An armed mixer: one deck playing, one loaded and cued behind it. */
async function armed() {
  const module = await import('./audio');
  const outgoing = module.audioEl() as unknown as FakeAudio;
  outgoing.src = '/current';
  outgoing.currentSrc = '/current';
  outgoing.paused = false;
  outgoing.currentTime = 100;
  const handlers = callbacks();
  module.audioService.armTransition('/next', plan, handlers);
  const incoming = created.find((deck) => deck !== outgoing)!;
  return { ...module, outgoing, incoming, handlers };
}

/** Move a deck's own clock, then let the mixer observe it. */
async function play(deck: FakeAudio, position: number) {
  deck.currentTime = position;
  await vi.advanceTimersByTimeAsync(50);
}

beforeEach(() => {
  created.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('AudioContext', undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('two-deck mixer', () => {
  it('hands playback over at the cue without reloading the incoming deck', async () => {
    const { audioEl, audioService, outgoing, incoming, handlers } = await armed();

    expect(audioService.mixPhase()).toBe('armed');
    expect(audioEl()).toBe(outgoing as unknown as HTMLAudioElement);
    // Loaded once, cued two seconds ahead of its intro, and silent.
    expect(incoming.src).toBe('/next');
    expect(incoming.load).toHaveBeenCalledTimes(1);
    expect(incoming.volume).toBe(0);

    // Nothing happens until the outgoing deck's own clock reaches the cue.
    await play(outgoing, 105);
    expect(audioService.mixPhase()).toBe('armed');

    await play(outgoing, 108.5);
    expect(audioService.mixPhase()).toBe('prerolling');
    expect(incoming.play).toHaveBeenCalled();
    expect(incoming.volume).toBe(0);

    incoming.currentTime = 2;
    await play(outgoing, 110);
    expect(audioService.mixPhase()).toBe('crossfading');
    expect(handlers.onDominant).not.toHaveBeenCalled();

    await play(incoming, 4);
    expect(handlers.onDominant).toHaveBeenCalledOnce();
    expect(audioEl()).toBe(incoming as unknown as HTMLAudioElement);

    await play(incoming, 6.1);
    expect(handlers.onComplete).toHaveBeenCalledOnce();
    expect(audioService.mixPhase()).toBe('idle');
    // The point of two decks: the track now playing was never re-assigned or
    // re-fetched, and the one that finished released its stream.
    expect(incoming.load).toHaveBeenCalledTimes(1);
    expect(incoming.src).toBe('/next');
    expect(outgoing.src).toBe('');
  });

  it('freezes the blend while playback is paused', async () => {
    const { audioEl, audioService, outgoing, incoming } = await armed();
    await play(outgoing, 108.5);
    incoming.currentTime = 2;
    await play(outgoing, 110);
    await play(incoming, 3);
    const held = incoming.volume;
    expect(held).toBeGreaterThan(0);

    audioService.pause();
    expect(outgoing.paused).toBe(true);
    expect(incoming.paused).toBe(true);
    // The crossfade advances on the media clock, so a pause holds it exactly
    // where it stood instead of running away on wall time — which is what used
    // to leave the incoming deck playing alone over a paused player.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(incoming.volume).toBe(held);
    expect(audioEl()).toBe(outgoing as unknown as HTMLAudioElement);
  });

  it('cancels a prepared transition without disturbing what is playing', async () => {
    const { audioService, outgoing, incoming, handlers } = await armed();

    audioService.cancelMix('seek');
    await vi.advanceTimersByTimeAsync(25_000);

    expect(handlers.onDominant).not.toHaveBeenCalled();
    expect(handlers.onCancel).toHaveBeenCalledWith('seek');
    expect(audioService.mixPhase()).toBe('idle');
    expect(outgoing.src).toBe('/current');
    expect(outgoing.volume).toBe(1);
    expect(incoming.src).toBe('');
  });

  it('lets a listener skip straight into the blend that was already prepared', async () => {
    const { audioEl, audioService, incoming, handlers } = await armed();

    expect(audioService.startMixNow()).toBe(true);
    // A requested skip hands over at once — the listener already knows the
    // track changed — and keeps whatever the incoming deck had buffered.
    expect(handlers.onDominant).toHaveBeenCalledOnce();
    expect(audioEl()).toBe(incoming as unknown as HTMLAudioElement);
    expect(incoming.load).toHaveBeenCalledTimes(1);
  });
});
