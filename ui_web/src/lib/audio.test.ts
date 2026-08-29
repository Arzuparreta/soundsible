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
  mediaTracks: Array<{ contentHint: string; stop: ReturnType<typeof vi.fn> }> = [];
  get broadcastTrack() {
    return this.mediaTracks.at(-1)!;
  }
  resume = vi.fn(async () => { this.state = 'running'; });
  suspend = vi.fn(async () => { this.state = 'suspended'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  addEventListener = vi.fn();
  createGain = () => {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  };
  createMediaElementSource = (_element: HTMLAudioElement) => new FakeAudioNode();
  createAnalyser = () => this.analyser;
  sampleRate = 44100;
  createBuffer = () => ({});
  createBufferSource = () => ({ buffer: null, connect: () => {}, start: () => {} });
  createMediaStreamDestination = () => {
    const track = { contentHint: '', stop: vi.fn() };
    this.mediaTracks.push(track);
    return {
      connect: <T>(target: T) => target,
      disconnect: vi.fn(),
      stream: {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      },
    };
  };
}

/** A context whose clock never moves: `running` in name only, which is how an
 * interrupted iOS session presents itself. */
class DeadAudioContext extends FakeAudioContext {
  override get currentTime() {
    return 10;
  }
}

/** What each deck was doing at the instant it was routed. WebKit refuses the
 * audio session to a context that is handed an element which is already
 * sounding, and the refusal is permanent: the routing cannot be undone. */
const routedDecks: Array<{ src: string; paused: boolean }> = [];

class RoutingAudioContext extends FakeAudioContext {
  override createMediaElementSource = (element: HTMLAudioElement) => {
    routedDecks.push({ src: element.src, paused: element.paused });
    return new FakeAudioNode();
  };
}

class FakeCapturedStream extends EventTarget {
  constructor(readonly tracks: Array<{ kind: string; readyState: string; contentHint: string; stop: ReturnType<typeof vi.fn> }>) {
    super();
  }

  getAudioTracks() {
    return this.tracks;
  }

  getTracks() {
    return this.tracks;
  }

  replaceAudioTrack(track: { kind: string; readyState: string; contentHint: string; stop: ReturnType<typeof vi.fn> }) {
    this.tracks.splice(0, this.tracks.length, track);
    this.dispatchEvent(new Event('removetrack'));
    this.dispatchEvent(new Event('addtrack'));
  }
}

class FakeAudio extends EventTarget {
  src = '';
  currentSrc = '';
  currentTime = 0;
  duration = 240;
  readyState = 4;
  /** `NETWORK_LOADING`. A deck holding nothing reports `NETWORK_NO_SOURCE` (3). */
  networkState = 2;
  paused = true;
  ended = false;
  volume = 1;
  muted = false;
  playbackRate = 1;
  preservesPitch = true;
  preload = '';
  crossOrigin: string | null = null;
  srcObject: MediaStream | null = null;
  captureTrack = { kind: 'audio', readyState: 'live', contentHint: '', stop: vi.fn() };
  capturedStream = new FakeCapturedStream([this.captureTrack]);

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
  captureStream = vi.fn(() => this.capturedStream as unknown as MediaStream);

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
  module.audioService.armTransition('/next', plan, handlers, { level: 1 });
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

/** Put the page in the background, the way a phone going into a pocket does. */
function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

const hide = () => setVisibility('hidden');
const reveal = () => setVisibility('visible');

beforeEach(() => {
  created.length = 0;
  contexts.length = 0;
  automatedCurves.length = 0;
  routedDecks.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('AudioContext', undefined);
  reveal();
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
    const carrierTrack = contexts[0].mediaTracks[0];
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
    expect(carrierTrack.stop).not.toHaveBeenCalled();
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

  it('rejects an unready incoming deck at the boundary without giving it ownership', async () => {
    const { audioEl, audioService, outgoing, incoming, handlers } = await armed();
    incoming.readyState = 1;
    outgoing.currentTime = outgoing.duration;
    outgoing.ended = true;

    await vi.advanceTimersByTimeAsync(300);

    expect(handlers.onError).toHaveBeenCalledOnce();
    expect(handlers.onDominant).not.toHaveBeenCalled();
    expect(incoming.play).not.toHaveBeenCalled();
    expect(audioService.mixPhase()).toBe('idle');
    expect(audioEl()).toBe(outgoing as unknown as HTMLAudioElement);
  });

  it('closes an interrupted blend on its current owner', async () => {
    const { audioEl, audioService, outgoing, incoming, handlers } = await armed();
    await play(outgoing, 108.5);
    incoming.currentTime = 2;
    await play(outgoing, 110);
    await play(incoming, 3);
    expect(audioService.mixPhase()).toBe('crossfading');
    expect(audioEl()).toBe(outgoing as unknown as HTMLAudioElement);

    audioService.pause();
    expect(audioService.mixPhase()).toBe('idle');
    expect(outgoing.paused).toBe(true);
    expect(incoming.paused).toBe(true);
    expect(incoming.src).toBe('');
    expect(handlers.onCancel).toHaveBeenCalledWith('transport_pause');
    expect(audioEl()).toBe(outgoing as unknown as HTMLAudioElement);

    const incomingStarts = incoming.play.mock.calls.length;
    await audioService.resume();
    expect(outgoing.paused).toBe(false);
    expect(incoming.play).toHaveBeenCalledTimes(incomingStarts);
  });

  it('keeps a handoff prepared when only the outgoing deck has started', async () => {
    const { audioService, outgoing, incoming, handlers } = await armed();

    audioService.pause('media_session');
    expect(audioService.mixPhase()).toBe('armed');
    expect(outgoing.paused).toBe(true);
    expect(incoming.src).toBe('/next');
    expect(incoming.play).not.toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();

    await audioService.resume('media_session');
    expect(outgoing.paused).toBe(false);
    expect(audioService.mixPhase()).toBe('armed');
  });

  it('pauses on the incoming deck after dominance and never revives the old song', async () => {
    const { audioEl, audioService, outgoing, incoming } = await armed();
    await play(outgoing, 108.5);
    incoming.currentTime = 2;
    await play(outgoing, 110);
    await play(incoming, 4);
    expect(audioEl()).toBe(incoming as unknown as HTMLAudioElement);

    audioService.pause('media_session');
    expect(audioService.mixPhase()).toBe('idle');
    expect(audioEl()).toBe(incoming as unknown as HTMLAudioElement);
    expect(outgoing.src).toBe('');
    expect(incoming.paused).toBe(true);

    const outgoingStarts = outgoing.play.mock.calls.length;
    await audioService.resume('media_session');
    expect(incoming.paused).toBe(false);
    expect(outgoing.play).toHaveBeenCalledTimes(outgoingStarts);
  });

  it('stops a non-active deck that WebKit revives after the handoff', async () => {
    const reports: Array<{ kind: string; deck0Playing: boolean; deck1Playing: boolean }> = [];
    const { audioService, outgoing, incoming, setProgramTransportReporter } = await armed();
    setProgramTransportReporter((event) => reports.push(event));
    await play(outgoing, 108.5);
    incoming.currentTime = 2;
    await play(outgoing, 110);
    await play(incoming, 4);
    audioService.pause('media_session');
    await audioService.resume('media_session');

    // Model iOS selecting the old element as its media session and issuing a
    // native play even though Soundsible's programme already belongs to B.
    outgoing.src = '/old';
    outgoing.currentSrc = '/old';
    await outgoing.play();

    expect(outgoing.paused).toBe(true);
    expect(outgoing.src).toBe('');
    expect(incoming.paused).toBe(false);
    expect(reports.at(-1)).toEqual(expect.objectContaining({
      kind: 'inactive_deck_play',
      deck0Playing: false,
      deck1Playing: true,
    }));
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
    await module.audioService.load('/current', 1);

    await vi.advanceTimersByTimeAsync(0);
    const active = module.audioEl() as unknown as FakeAudio;
    expect(active.src).toBe('/current');
    expect(active.paused).toBe(false);
  });

  it('keeps a staged deck so the next track starts without a request', async () => {
    const module = await import('./audio');
    const first = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/one', 1);

    module.audioService.stage('/two', 1);
    const idle = created.find((deck) => deck !== first)!;
    expect(idle.src).toBe('/two');
    expect(idle.load).toHaveBeenCalledTimes(1);
    expect(idle.play).not.toHaveBeenCalled();

    // The handover touches neither `src` nor the network: it is a deck swap.
    const taken = module.audioService.takeStaged('/two', 1);
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
    await module.audioService.load('/one', 1);
    module.audioService.stage('/two', 1);
    expect(module.audioService.takeStaged('/three', 1)).toBeNull();
  });

  it('takes a staged deck that has not finished buffering', async () => {
    // Safari downgrades `preload="auto"` to metadata-only, so an iPhone's staged
    // deck sits at HAVE_METADATA however long it has been cued. Refusing it
    // there sent every track change back to the network — which is the one thing
    // a locked phone will not do.
    const module = await import('./audio');
    const first = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/one', 1);
    module.audioService.stage('/two', 1);
    const idle = created.find((deck) => deck !== first)!;
    idle.readyState = 1;

    const taken = module.audioService.takeStaged('/two', 1);
    expect(taken).not.toBeNull();
    await taken;
    expect(module.audioEl()).toBe(idle as unknown as HTMLAudioElement);
    expect(idle.play).toHaveBeenCalledOnce();
    // Still one load: the deck kept whatever it had rather than re-requesting.
    expect(idle.load).toHaveBeenCalledTimes(1);
  });

  it('refuses a staged deck that is holding nothing at all', async () => {
    const module = await import('./audio');
    const first = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/one', 1);
    module.audioService.stage('/two', 1);
    const idle = created.find((deck) => deck !== first)!;
    idle.networkState = 3; // NETWORK_NO_SOURCE

    expect(module.audioService.takeStaged('/two', 1)).toBeNull();
  });

  it('keeps the outgoing stream while the page is hidden', async () => {
    // `load()` resets a media element, and on iOS that hands the audio session
    // back. Doing it the instant a handoff completes — before the incoming deck
    // has produced a sample — is how a locked phone goes quiet between songs.
    const module = await import('./audio');
    const first = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/one', 1);
    module.audioService.stage('/two', 1);
    const idle = created.find((deck) => deck !== first)!;

    hide();
    await module.audioService.takeStaged('/two', 1);
    expect(first.src).toBe('/one');
    expect(module.audioEl()).toBe(idle as unknown as HTMLAudioElement);

    reveal();
    expect(first.src).toBe('');
  });

  it('recovers on the other deck and makes late errors from the failed deck stale', async () => {
    const module = await import('./audio');
    const failed = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/current', 1);
    failed.currentTime = 42;
    let activeErrors = 0;
    module.onDeckEvent('error', (event) => {
      if (module.isActiveDeck(event.currentTarget)) activeErrors += 1;
    });

    await module.audioService.recover('/current', 42, 1);
    const replacement = module.audioEl() as unknown as FakeAudio;
    expect(replacement).not.toBe(failed);
    expect(replacement.src).toBe('/current');
    expect(replacement.currentTime).toBe(42);

    failed.dispatchEvent(new Event('error'));
    expect(activeErrors).toBe(0);
  });

  it('rejects a recovery whose replacement deck never receives metadata', async () => {
    const module = await import('./audio');
    await module.audioService.load('/current', 1);
    const active = module.audioEl() as unknown as FakeAudio;
    const replacement = created.find((deck) => deck !== active)!;
    replacement.readyState = 0;

    const recovery = module.audioService.recover('/current', 20, 1);
    const verdict = expect(recovery).rejects.toThrow('metadata timeout');
    await vi.advanceTimersByTimeAsync(12_000);
    await verdict;
  });

  it('never treats silence as permission to rebuild the decks', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    expect(module.audioService.unlockAudio()).toBe(true);

    const deck = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/current', 1);
    deck.currentTime = 10;
    contexts.at(-1)!.analyser.level = 128;

    hide();
    const before = created.length;
    for (let step = 0; step < 8; step += 1) {
      deck.currentTime += 1;
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(created).toHaveLength(before);
    expect(module.audioEl()).toBe(deck);
    expect(module.audioService.graphReady()).toBe(true);

    // The same invariant holds in the foreground. A quiet master bus may be a
    // fade or silence in the recording; it cannot diagnose speaker output.
    reveal();
    for (let step = 0; step < 8; step += 1) {
      deck.currentTime += 1;
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(created).toHaveLength(before);
    expect(module.audioEl()).toBe(deck);
    expect(module.audioService.graphReady()).toBe(true);
  });

  it('drives a blend from the media clock when timers are throttled', async () => {
    // A blend is normally supervised by a chain of timeouts. iOS throttles those
    // in the background and stops them once the page is frozen, so the handoff
    // has to be reachable from `timeupdate` and `ended` — which keep arriving
    // for as long as the element is sounding.
    const { audioService, outgoing, incoming } = await armed();
    vi.clearAllTimers();

    outgoing.currentTime = 118;
    outgoing.dispatchEvent(new Event('timeupdate'));
    expect(incoming.play).toHaveBeenCalled();

    outgoing.ended = true;
    outgoing.dispatchEvent(new Event('ended'));
    incoming.paused = false;
    for (let step = 0; step < 8; step += 1) {
      incoming.currentTime += 1;
      incoming.dispatchEvent(new Event('timeupdate'));
    }
    expect(audioService.mixPhase()).toBe('idle');
  });

  it('keeps a silent ending on the original graph so the normal handoff can finish it', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    expect(module.audioService.unlockAudio()).toBe(true);
    expect(module.audioService.graphReady()).toBe(true);

    const deck = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/current', 1);
    deck.currentTime = 10;
    contexts.at(-1)!.analyser.level = 128;
    const before = [...created];
    for (let step = 0; step < 8; step += 1) {
      deck.currentTime += 1;
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(module.audioService.graphReady()).toBe(true);
    expect(module.audioEl()).toBe(deck);
    expect(created).toEqual(before);
  });

  it('keeps the Live program tap attached through a silent passage', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    let lost = 0;
    module.setBroadcastLostReporter(() => { lost += 1; });
    expect(module.audioService.unlockAudio()).toBe(true);
    const capture = module.audioService.acquireBroadcastCapture();
    expect(capture?.kind).toBe('program');
    const context = contexts.at(-1)!;

    const deck = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/current', 1);
    deck.currentTime = 10;
    context.analyser.level = 128;
    for (let step = 0; step < 8; step += 1) {
      deck.currentTime += 1;
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(module.audioService.graphReady()).toBe(true);
    expect(module.audioEl()).toBe(deck);
    expect(context.broadcastTrack.stop).not.toHaveBeenCalled();
    expect(lost).toBe(0);
  });

  it('routes decks that have never played, and only then spends their unlock sample', async () => {
    // The order this function documents, and the one iOS grants an audio
    // session for. Unlocking first put both decks mid-`play()` at the moment
    // `createMediaElementSource` claimed them — the punished sequence reached
    // from the other side, and an irreversible one: the context stayed
    // suspended and the installed app spent the session without its mixer.
    vi.stubGlobal('AudioContext', RoutingAudioContext);
    const module = await import('./audio');

    expect(module.audioService.unlockAudio()).toBe(true);

    expect(routedDecks).toEqual([
      { src: '', paused: true },
      { src: '', paused: true },
    ]);
    // And the sample is still spent — from the same gesture, which is what
    // makes a later gestureless start legal on a locked phone.
    expect(created).toHaveLength(3);
    expect(created.slice(0, 2).every((deck) => deck.play.mock.calls.length === 1)).toBe(true);
    expect(created[2].play).not.toHaveBeenCalled();
  });

  it('does not replace decks merely because a context clock is temporarily still', async () => {
    vi.stubGlobal('AudioContext', DeadAudioContext);
    const module = await import('./audio');
    module.audioService.unlockAudio();
    const before = [...created];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(module.audioService.graphReady()).toBe(true);
    expect(created).toEqual(before);
  });

  it('resumes an interrupted context without replacing its graph or decks', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    expect(module.audioService.unlockAudio()).toBe(true);
    const context = contexts.at(-1)!;
    const before = [...created];
    const stateHandler = context.addEventListener.mock.calls.find(([type]) => type === 'statechange')?.[1];
    expect(stateHandler).toBeTypeOf('function');

    context.state = 'suspended';
    stateHandler();
    await Promise.resolve();

    expect(context.resume).toHaveBeenCalled();
    expect(module.audioService.graphReady()).toBe(true);
    expect(created).toEqual(before);
  });

  it('never carries a deck unlock over into the track it primes', async () => {
    // `unlockDecks` spends a silent sample on every empty deck, from any
    // gesture. A restore landing while that play is in flight used to inherit
    // it — the paused song the listener came back to started on its own.
    const module = await import('./audio');
    const deck = module.audioEl() as unknown as FakeAudio;
    deck.paused = false;

    module.audioService.prime('/restored', 42, 1);

    expect(deck.pause).toHaveBeenCalled();
    expect(deck.paused).toBe(true);
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

/**
 * Volume levelling.
 *
 * The graph builds master and monitor before it walks the decks, then for each
 * deck a mix gain followed by a levelling gain — so `context.gains` is
 * [master, monitor, deck0 mix, deck0 level, deck1 mix, deck1 level]. Reading
 * the level nodes by that layout also pins the master/monitor indices the
 * broadcast tests above depend on.
 */
function levelNode(context: FakeAudioContext, deckIndex: number): FakeGainNode {
  return context.gains[3 + deckIndex * 2];
}

function levelValue(context: FakeAudioContext, deckIndex: number): number {
  return levelNode(context, deckIndex).gain.value;
}

describe('volume levelling', () => {
  it('inserts one levelling gain per deck without moving the master bus', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    expect(module.audioService.unlockAudio()).toBe(true);
    const context = contexts[0];

    // Two decks, each with a mix gain and a levelling gain, behind the
    // unity-gain master and the downstream monitor.
    expect(context.gains).toHaveLength(6);
    expect(context.gains[0].gain.value).toBe(1);
    expect(levelValue(context, 0)).toBe(1);
    expect(levelValue(context, 1)).toBe(1);
  });

  it('carries a level set before the first gesture into the graph', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    // A track can be cued before anything has been tapped, so the shadow has to
    // survive into the nodes the gesture eventually builds.
    await module.audioService.load('/quiet', 1.8);
    expect(module.audioService.unlockAudio()).toBe(true);

    expect(levelValue(contexts[0], 0)).toBeCloseTo(1.8, 5);
  });

  it('leaves the level on the deck that was promoted, and resets the one released', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    module.audioService.unlockAudio();
    const context = contexts[0];

    await module.audioService.load('/one', 0.6);
    module.audioService.stage('/two', 1.7);
    expect(levelValue(context, 0)).toBeCloseTo(0.6, 5);
    expect(levelValue(context, 1)).toBeCloseTo(1.7, 5);

    await module.audioService.takeStaged('/two', 1.7);
    // Nothing moved between nodes: only which deck is active changed.
    expect(levelValue(context, 1)).toBeCloseTo(1.7, 5);
    // And the deck that finished is back at unity, so it cannot lend its gain
    // to whatever it is handed next.
    expect(levelValue(context, 0)).toBe(1);
  });

  it('never lets one track inherit the previous track\'s level', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    module.audioService.unlockAudio();
    const context = contexts[0];

    // `load` reassigns `src` on the same deck without detaching, so this is the
    // path where a leak would actually happen: a boosted song followed by an
    // unmeasured podcast.
    await module.audioService.load('/music', 1.9);
    await module.audioService.load('/podcast', 1);
    expect(levelValue(context, 0)).toBe(1);
  });

  it('levels only the incoming deck of a blend', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    module.audioService.unlockAudio();
    const context = contexts[0];

    await module.audioService.load('/current', 0.7);
    module.audioService.armTransition('/next', plan, callbacks(), { level: 1.5 });

    // The outgoing deck is still playing its own track at its own level.
    expect(levelValue(context, 0)).toBeCloseTo(0.7, 5);
    expect(levelValue(context, 1)).toBeCloseTo(1.5, 5);
  });

  it('returns a cancelled blend\'s dropped deck to unity', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    module.audioService.unlockAudio();
    const context = contexts[0];

    await module.audioService.load('/current', 0.7);
    module.audioService.armTransition('/next', plan, callbacks(), { level: 1.5 });
    module.audioService.cancelMix('superseded');

    // Cancelled before the handoff, so the outgoing deck keeps playing and
    // keeps its level; the incoming one is released.
    expect(levelValue(context, 0)).toBeCloseTo(0.7, 5);
    expect(levelValue(context, 1)).toBe(1);
  });

  it('returns both decks to unity on stop', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    module.audioService.unlockAudio();
    const context = contexts[0];

    await module.audioService.load('/one', 0.5);
    module.audioService.stage('/two', 1.6);
    module.audioService.stop();

    expect(levelValue(context, 0)).toBe(1);
    expect(levelValue(context, 1)).toBe(1);
  });

  it('ramps rather than steps when the listener toggles it mid-track', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    module.audioService.unlockAudio();
    const context = contexts[0];

    await module.audioService.load('/loud', 0.5);
    const node = levelNode(context, 0);
    node.gain.linearRampToValueAtTime.mockClear();

    module.audioService.setLevelingEnabled(false);
    // Turning it off restores unity exactly — not approximately — so the output
    // is what it was before the feature existed.
    expect(node.gain.value).toBe(1);
    expect(node.gain.linearRampToValueAtTime).toHaveBeenCalled();

    module.audioService.setLevelingEnabled(true);
    // And switching back restores what the deck was already meant to be at,
    // because the desired level was never thrown away.
    expect(node.gain.value).toBeCloseTo(0.5, 5);
  });

  it('can never drive a deck to silence', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    module.audioService.unlockAudio();
    const context = contexts[0];

    // An invalid or zero loudness analysis must not mute the programme.
    await module.audioService.load('/broken', 0);
    expect(levelValue(context, 0)).toBeGreaterThan(0);

    await module.audioService.load('/broken', Number.NaN);
    expect(levelValue(context, 0)).toBe(1);
  });

  it('only ever attenuates when there is no audio graph', async () => {
    const module = await import('./audio');
    expect(module.audioService.unlockAudio()).toBe(false);

    await module.audioService.load('/quiet', 0.5);
    const deck = module.audioEl() as unknown as FakeAudio;
    expect(deck.volume).toBeCloseTo(0.5, 5);

    // An element's volume cannot amplify, so a boost is dropped rather than
    // clipped at the top of the range.
    await module.audioService.load('/loud', 1.8);
    expect(deck.volume).toBe(1);
  });

  it('combines levelling with device volume on the no-graph path', async () => {
    const module = await import('./audio');
    module.audioService.unlockAudio();
    module.audioService.setVolume(0.5);

    await module.audioService.load('/quiet', 0.5);
    const deck = module.audioEl() as unknown as FakeAudio;
    expect(deck.volume).toBeCloseTo(0.25, 5);
    module.audioService.setVolume(1);
  });

  it('keeps the level and original deck through a silent passage', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const module = await import('./audio');
    expect(module.audioService.unlockAudio()).toBe(true);

    const deck = module.audioEl() as unknown as FakeAudio;
    await module.audioService.load('/current', 0.5);
    deck.currentTime = 10;
    contexts.at(-1)!.analyser.level = 128;
    for (let step = 0; step < 8; step += 1) {
      deck.currentTime += 1;
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(module.audioService.graphReady()).toBe(true);
    expect(module.audioEl()).toBe(deck);
    expect(levelValue(contexts.at(-1)!, 0)).toBeCloseTo(0.5, 5);
  });
});
