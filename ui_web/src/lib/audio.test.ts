import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const created: FakeAudio[] = [];
const automatedCurves: Float32Array[] = [];

class FakeAudioParam {
  value = 0;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn((value: number) => { this.value = value; });
  linearRampToValueAtTime = vi.fn((value: number) => { this.value = value; });
  setValueCurveAtTime = vi.fn((values: Float32Array) => {
    automatedCurves.push(values);
    this.value = values[values.length - 1];
  });
}

class FakeAudioNode {
  connect<T>(target: T): T {
    return target;
  }
  disconnect = vi.fn();
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeAnalyserNode extends FakeAudioNode {
  frequencyBinCount = 128;
  fftSize = 256;
  /** 128 is digital silence for 8-bit time-domain data. */
  level = 200;
  getByteTimeDomainData = vi.fn((target: Uint8Array) => target.fill(this.level));
}

const contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  constructor() {
    contexts.push(this);
  }

  /** A context that is really rendering advances its own clock; the liveness
   * probe reads exactly this. */
  get currentTime() {
    return this.state === 'running' ? Date.now() / 1000 : this.frozenAt;
  }
  frozenAt = 10;
  state = 'running';
  destination = new FakeAudioNode();
  analyser = new FakeAnalyserNode();
  gains: FakeGainNode[] = [];
  broadcastTrack = { contentHint: '', stop: vi.fn() };
  resume = vi.fn(async () => { this.state = 'running'; });
  suspend = vi.fn(async () => { this.state = 'suspended'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  addEventListener = vi.fn();
  createGain = () => {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  };
  createMediaElementSource = () => new FakeAudioNode();
  createAnalyser = () => this.analyser;
  sampleRate = 44100;
  createBuffer = () => ({});
  createBufferSource = () => ({ buffer: null, connect: () => {}, start: () => {} });
  createMediaStreamDestination = () => ({
    connect: <T>(target: T) => target,
    disconnect: vi.fn(),
    stream: {
      getAudioTracks: () => [this.broadcastTrack],
      getTracks: () => [this.broadcastTrack],
    },
  });
}

/** A context whose clock never moves: `running` in name only, which is how an
 * interrupted iOS session presents itself. */
class DeadAudioContext extends FakeAudioContext {
  override get currentTime() {
    return 10;
  }
}

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
    this.dispatchEvent(new Event('play'));
  });

  pause = vi.fn(() => {
    const wasPlaying = !this.paused;
    this.paused = true;
    if (wasPlaying) this.dispatchEvent(new Event('pause'));
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

/**
 * Move a deck's own clock, then let the mixer observe it.
 *
 * Long enough to cover the coarse rate the supervisor drops to during the long
 * `armed` wait — these tests jump the clock in whole seconds, which real
 * playback never does, so they skip straight past the window where it tightens
 * back up. The cadence itself is covered separately.
 */
async function play(deck: FakeAudio, position: number) {
  deck.currentTime = position;
  await vi.advanceTimersByTimeAsync(300);
}

beforeEach(() => {
  created.length = 0;
  contexts.length = 0;
  automatedCurves.length = 0;
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
  it('keeps local mute and volume downstream from the live program tap', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');

    expect(module.audioService.unlockAudio()).toBe(true);
    const stream = module.audioService.broadcastStream();
    expect(stream).not.toBeNull();
    const context = contexts[0];

    module.audioService.setVolume(0.35);
    expect(context.gains[0].gain.value).toBe(1);
    expect(context.gains[1].gain.value).toBe(0.35);
    module.audioService.setMuted(true);
    expect(context.gains[1].gain.value).toBe(0);
    expect(created.every((deck) => !deck.muted)).toBe(true);
    expect(context.broadcastTrack.stop).not.toHaveBeenCalled();

    module.audioService.releaseBroadcastStream();
    expect(context.broadcastTrack.stop).toHaveBeenCalledOnce();
    module.audioService.setMuted(false);
    module.audioService.setVolume(1);
  });

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

  it('watches the armed runway coarsely and tightens up before the cue', async () => {
    const { audioService, outgoing } = await armed();

    // A transition is armed 45s ahead of the out-cue. Supervising that wait at
    // mix resolution is ~1100 timer wakeups a track for a comparison that
    // cannot come true yet, and it is enough on its own to keep a low-power CPU
    // out of its deeper idle states. Far out, one tick does not fire in 40ms.
    outgoing.currentTime = 101;
    await vi.advanceTimersByTimeAsync(40);
    expect(audioService.mixPhase()).toBe('armed');

    // Inside the last couple of seconds of runway it is back to mix resolution,
    // so the preroll still opens within a tick of the right moment. The cue is
    // at 108: out_cue 110 less the 2s head start in_cue asks for.
    await vi.advanceTimersByTimeAsync(300);
    outgoing.currentTime = 107;
    await vi.advanceTimersByTimeAsync(300);
    outgoing.currentTime = 108.1;
    await vi.advanceTimersByTimeAsync(40);
    expect(audioService.mixPhase()).toBe('prerolling');
  });

  it('does not open both decks while their beat cues are still out of phase', async () => {
    const { audioService, outgoing, incoming } = await armed();
    await play(outgoing, 108.5);

    // Twenty milliseconds is enough to create the audible doubled attack the
    // phase guard exists to prevent.
    incoming.currentTime = 1.98;
    await play(outgoing, 110);
    expect(audioService.mixPhase()).toBe('prerolling');
    expect(incoming.volume).toBe(0);

    await play(incoming, 2);
    expect(audioService.mixPhase()).toBe('crossfading');
  });

  it('schedules one continuous equal-power curve on the audio graph', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    // The graph is built from a gesture now, never from the mixer's ticker.
    expect(module.audioService.unlockAudio()).toBe(true);
    const { audioService, outgoing, incoming } = await armed();
    await play(outgoing, 108.5);
    incoming.currentTime = 2;
    await play(outgoing, 110);

    expect(audioService.mixPhase()).toBe('crossfading');
    expect(automatedCurves).toHaveLength(2);
    expect(automatedCurves.every((curve) => curve.length === 96)).toBe(true);
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

  it('spends a silent sample on every deck so a later start needs no gesture', async () => {
    const module = await import('./audio');
    module.audioService.unlockAudio();

    // Playback permission is per element. The deck that will carry the *next*
    // track is asked to play from an `ended` handler, which is not a gesture —
    // so both decks have to have played once by the time that happens.
    expect(created).toHaveLength(2);
    for (const deck of created) {
      expect(deck.play).toHaveBeenCalledOnce();
      expect(deck.src).toMatch(/^data:audio\/wav/);
    }

    await vi.advanceTimersByTimeAsync(0);
    // …and each gives its stream straight back, unmuted and empty.
    for (const deck of created) {
      expect(deck.src).toBe('');
      expect(deck.muted).toBe(false);
    }
  });

  it('never lets the unlock clip disturb a track that claimed the deck', async () => {
    const module = await import('./audio');
    module.audioService.unlockAudio();
    await module.audioService.load('/current');

    await vi.advanceTimersByTimeAsync(0);
    const active = module.audioEl() as unknown as FakeAudio;
    expect(active.src).toBe('/current');
    expect(active.paused).toBe(false);
  });

  it('keeps a staged deck so the next track starts without a request', async () => {
    const module = await import('./audio');
    const first = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/one');

    module.audioService.stage('/two');
    const idle = created.find((deck) => deck !== first)!;
    expect(idle.src).toBe('/two');
    expect(idle.load).toHaveBeenCalledTimes(1);
    expect(idle.play).not.toHaveBeenCalled();

    // The handover touches neither `src` nor the network: it is a deck swap.
    const taken = module.audioService.takeStaged('/two');
    expect(taken).not.toBeNull();
    await taken;
    expect(module.audioEl()).toBe(idle as unknown as HTMLAudioElement);
    expect(idle.play).toHaveBeenCalledOnce();
    expect(idle.load).toHaveBeenCalledTimes(1);
    // The deck that finished released its stream instead of holding it open.
    expect(first.src).toBe('');
  });

  it('refuses a staged deck that is holding a different track', async () => {
    const module = await import('./audio');
    await module.audioService.load('/one');
    module.audioService.stage('/two');
    expect(module.audioService.takeStaged('/three')).toBeNull();
  });

  it('abandons a graph that stops sounding and keeps the music going', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    const failures: unknown[] = [];
    module.setGraphReporter((failure) => failures.push(failure));
    expect(module.audioService.unlockAudio()).toBe(true);
    expect(module.audioService.graphReady()).toBe(true);

    const deck = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/current');
    deck.currentTime = 10;
    // Silence on the master bus while the media clock advances: the samples are
    // not reaching the speakers, whatever the element and the context claim.
    contexts.at(-1)!.analyser.level = 128;
    for (let step = 0; step < 8; step += 1) {
      deck.currentTime += 1;
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(module.audioService.graphReady()).toBe(false);
    expect(failures).toHaveLength(1);
    // New, unrouted decks, cued back to where the music was and playing again.
    const rebuilt = module.audioEl() as unknown as FakeAudio;
    expect(rebuilt).not.toBe(deck);
    expect(rebuilt.src).toBe('/current');
    expect(rebuilt.play).toHaveBeenCalled();
  });

  it('gives up on a context whose clock never starts, before routing anything', async () => {
    vi.stubGlobal('AudioContext', DeadAudioContext);
    const module = await import('./audio');
    module.audioService.unlockAudio();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(module.audioService.graphReady()).toBe(false);
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
