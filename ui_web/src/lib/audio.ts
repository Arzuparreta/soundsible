import { MAX_LINEAR as MAX_LEVEL, MIN_LINEAR as MIN_LEVEL } from './loudness';

const VOLUME_KEY = 'volume';

/** Media-clock supervision. Audio gain itself is sample-accurate automation. */
const TICK_MS = 40;
/** How often the output is checked for digital silence while a deck plays. */
const AUDIBILITY_TICK_MS = 500;
/** Silence this long, with the media clock advancing, means the graph is dead
 * rather than the music being quiet. */
const DEAD_GRAPH_MS = 2_500;
/** 8-bit samples centre on 128; anything this close to it is not sound. */
const SILENCE_EPSILON = 2;
/** How long the context clock is given to prove it is running. */
const PROBE_MS = 300;
/** Supervision rate during the long `armed` wait, where a tick only compares
 * the media clock against the preroll point. See `tickInterval`. */
const ARMED_TICK_MS = 250;
/** Runway left, in seconds, at which `armed` goes back to watching at TICK_MS. */
const ARMED_FINE_LEAD = 2;
/** Longest silent head start given to the incoming deck. */
const MAX_PREROLL = 4;
const MIN_OVERLAP = 1.2;
/** After a beatmatched blend the incoming deck drifts back to its own tempo. */
const RATE_RETURN_MS = 8_000;
/** `HTMLMediaElement.NETWORK_NO_SOURCE`, named rather than read off the global:
 * the constant is missing under jsdom, and a deck holding nothing is exactly
 * the case this has to recognise. */
const NETWORK_NO_SOURCE = 3;

/** True while the page is in the background — a locked phone, another app, a
 * different tab. Everything that would reset a media element, rebuild the audio
 * graph, or trust a throttled timer has to know: iOS keeps a backgrounded page
 * alive only while an element is actually sounding, so those are the moments
 * they are most likely to run and least able to survive. */
function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

let elements: HTMLAudioElement[] | null = null;
let activeIndex = 0;
/** Shadow of each deck's mix gain, so volume changes can be reapplied without
 * an AudioContext. */
const mixGains = [1, 0];
/**
 * Per-deck volume levelling, as a linear multiplier.
 *
 * Shadowed here rather than read back off the nodes, for the same reason as
 * `mixGains`: a level can be set before the graph exists and has to survive the
 * graph being rebuilt. The gain belongs to the *deck*, never to the track — so
 * a handoff that swaps which deck is active never has to move a gain anywhere.
 */
const levelGains = [1, 1];
let levelNodes: GainNode[] | null = null;
/** Whether levelling is applied at all. Off means literally unity, so the
 * output is what it was before this feature existed. */
let levelingEnabled = true;
/** Long enough not to click, short enough to feel immediate. */
const LEVEL_RAMP_SEC = 0.15;
let audioContext: AudioContext | null = null;
let deckGains: GainNode[] | null = null;
interface DeckEffects {
  low?: BiquadFilterNode;
  filter?: BiquadFilterNode;
  /** Where the echo send taps the deck, kept so it can be built on demand. */
  source?: MediaElementAudioSourceNode;
  /** This deck's levelling gain. The echo send taps it rather than `source`,
   * so an echo tail is levelled like the programme it came from. */
  level?: GainNode;
  delay?: DelayNode;
  echoWet?: GainNode;
  echoFeedback?: GainNode;
}
let deckEffects: DeckEffects[] | null = null;
/** Unity-gain program bus. Local volume is deliberately downstream. */
let masterGain: GainNode | null = null;
/** Device-only monitor gain: volume and mute never alter the broadcast bus. */
let monitorGain: GainNode | null = null;
let masterVolume = storedVolume();
let allMuted = false;
/** Peak limiter on the master bus, transparent until a blend needs it. */
let limiter: DynamicsCompressorNode | null = null;
/** The post-limiter node shared by the local monitor and an optional live tap. */
let programOutput: AudioNode | null = null;
let broadcastDestination: MediaStreamAudioDestinationNode | null = null;
let broadcastCapture: BroadcastCapture | null = null;
let broadcastElement: HTMLAudioElement | null = null;
let broadcastCaptureCleanup: (() => void) | null = null;
/** Master-bus tap used to tell "quiet music" from "no output at all". */
let analyser: AnalyserNode | null = null;

/**
 * Whether the decks are routed through the mixing graph.
 *
 * `unavailable` is always a decision about *this* page load and is never
 * persisted: a context that could not run once — an iOS audio session that was
 * interrupted, a device that had just switched to Bluetooth — says nothing about
 * the next launch, and writing that verdict down would quietly leave a device
 * without the real mixer for good.
 */
type GraphState = 'untested' | 'ready' | 'unavailable';
let graphState: GraphState = 'untested';

export interface GraphFailure {
  reason: 'context_stalled' | 'silent_output';
  /** Whether the decks were sounding when the graph was taken down. A paused
   * player has nothing to restore, so `resumed: false` there is the expected
   * outcome rather than a failure anybody has to be told about. */
  wasPlaying: boolean;
  /** Whether playback was restored on the replacement decks by itself. */
  resumed: boolean;
  contextState: string;
  positionSec: number;
}
let graphReporter: ((failure: GraphFailure) => void) | null = null;

/** Register the store's handler for a mixing graph that had to be abandoned. */
export function setGraphReporter(fn: (failure: GraphFailure) => void): void {
  graphReporter = fn;
}

/**
 * Register the live bridge's handler for a tap that died with its graph.
 *
 * Playback survives a failed graph on replacement elements, but the broadcast
 * does not: the tap needs a context that this page load will not build again.
 * Without this the publisher keeps a sender that will never carry a sample
 * while the room still reads "on air".
 */
let broadcastLostReporter: (() => void) | null = null;

export function setBroadcastLostReporter(fn: (() => void) | null): void {
  broadcastLostReporter = fn;
}

export type BroadcastCaptureKind = 'program' | 'element';

/**
 * The one audio source Live is allowed to publish.
 *
 * Normally this is the post-limiter program tap, which preserves the DJ mix.
 * If a browser forces this page load into the deliberately safe, direct-deck
 * playback mode, `element` keeps Live usable without trying to resurrect the
 * failed AudioContext. Its track can change whenever the element changes URL,
 * so the bridge subscribes and replaces the WebRTC sender in place.
 */
export interface BroadcastCapture {
  kind: BroadcastCaptureKind;
  stream: MediaStream;
  onTrackChange: (listener: (track: MediaStreamTrack | null) => void) => () => void;
}

/** Read the persisted volume without forcing the lazy elements into existence. */
export function storedVolume(): number {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VOLUME_KEY) : null;
  const v = raw == null ? 1 : Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/**
 * Deck-level listeners, kept so replacement decks inherit them.
 *
 * The store binds playback events once, at startup. Recovering from a dead
 * mixing graph means throwing both elements away and building new ones (their
 * output only exists inside a graph that has stopped sounding), and listeners
 * bound directly to the old elements would not follow. Registering them here
 * makes deck replacement an operation the rest of the app never has to know
 * about.
 */
interface DeckBinding {
  type: string;
  handler: (event: Event) => void;
}
const deckBindings: DeckBinding[] = [];

/** Bind `handler` to every deck, now and after any replacement. */
export function onDeckEvent(type: string, handler: (event: Event) => void): void {
  deckBindings.push({ type, handler });
  if (elements) for (const deck of elements) deck.addEventListener(type, handler);
}

function createDeck(): HTMLAudioElement {
  const deck = new Audio();
  deck.preload = 'auto';
  if ('preservesPitch' in deck) deck.preservesPitch = true;
  for (const binding of deckBindings) deck.addEventListener(binding.type, binding.handler);
  return deck;
}

/**
 * The two decks.
 *
 * They are symmetric on purpose: a DJ handoff makes the incoming deck the
 * active one and simply releases the other. The previous single-canonical-deck
 * arrangement had to copy the incoming position back into the canonical element
 * at the end of every transition, which meant re-assigning `src` and
 * re-buffering a stream that was already playing.
 */
function decks(): HTMLAudioElement[] {
  if (!elements) {
    elements = [createDeck(), createDeck()];
    applyDeckVolume();
    bindLifecycle();
  }
  return elements;
}

/** The deck that currently owns playback. Everything outside this module talks
 * to Soundsible's playback through this one element. */
export function audioEl(): HTMLAudioElement {
  return decks()[activeIndex];
}

/** Run `fn` for both decks — for binding listeners that have to survive a
 * handoff. Pair it with `isActiveDeck` to ignore the deck that is only being
 * prepared. */
export function eachDeck(fn: (deck: HTMLAudioElement, index: number) => void): void {
  decks().forEach(fn);
}

/** True when `target` is the deck that currently owns playback. */
export function isActiveDeck(target: EventTarget | null): boolean {
  return target === decks()[activeIndex];
}

function applyDeckVolume(): void {
  if (!elements) return;
  if (monitorGain && audioContext) {
    monitorGain.gain.value = allMuted ? 0 : masterVolume;
    for (const deck of elements) {
      deck.volume = 1;
      deck.muted = false;
    }
    return;
  }
  elements.forEach((deck, index) => {
    deck.volume = Math.min(1, Math.max(0, mixGains[index] * masterVolume * fallbackLevel(index)));
    deck.muted = allMuted;
  });
}

/** The applied level for one deck: unity whenever levelling is switched off. */
function appliedLevel(index: number): number {
  return levelingEnabled ? levelGains[index] : 1;
}

/**
 * Levelling on the no-graph path, where the only control is `deck.volume`.
 *
 * An element's volume can attenuate but cannot amplify, so a boost is silently
 * dropped and only cuts survive. That is a partial job, but a strictly closer
 * one than doing nothing — and it can never distort, which matters more.
 */
function fallbackLevel(index: number): number {
  return Math.min(1, appliedLevel(index));
}

/**
 * Set one deck's mix gain.
 *
 * This is for discrete deck state changes. Audible crossfades bypass it and use
 * one scheduled AudioParam curve, because repeatedly cancelling short ramps is
 * exactly what made the old mixer crackle when a timer arrived late.
 */
function setDeckGain(index: number, value: number): void {
  const clamped = Math.min(1, Math.max(0, value));
  mixGains[index] = clamped;
  if (deckGains && audioContext) {
    const param = deckGains[index].gain;
    const now = audioContext.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(clamped, now);
    return;
  }
  const deck = decks()[index];
  deck.volume = Math.min(1, Math.max(0, clamped * masterVolume * fallbackLevel(index)));
}

/**
 * Set one deck's volume levelling.
 *
 * Deliberately a node of its own rather than folded into `deckGains`: that
 * parameter is driven by scheduled equal-power curves during a crossfade, and
 * multiplying a second thing into an automated `AudioParam` is exactly what
 * used to make the mixer crackle when a timer arrived late.
 *
 * The floor is the important part. A gain of zero is silence, and silence on a
 * deck whose clock is advancing is what `checkAudible` reads as a dead graph —
 * it would tear the graph down and take the live tap with it. Clamping here
 * makes levelling-induced silence impossible by construction.
 */
function setDeckLevel(index: number, linear: number, ramp = false): void {
  const safe = Number.isFinite(linear) ? Math.min(Math.max(linear, MIN_LEVEL), MAX_LEVEL) : 1;
  levelGains[index] = safe;
  const node = levelNodes?.[index];
  if (node && audioContext) {
    const target = appliedLevel(index);
    const now = audioContext.currentTime;
    const param = node.gain;
    param.cancelScheduledValues(now);
    if (ramp && typeof param.linearRampToValueAtTime === 'function') {
      // Never a step: this is the one path that can run while a deck is
      // already sounding, when the listener toggles the setting mid-track.
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(target, now + LEVEL_RAMP_SEC);
    } else {
      param.setValueAtTime(target, now);
    }
    return;
  }
  applyDeckVolume();
}

/** Release a deck's stream and return it to unity.
 *
 * Pairing the two is what stops a levelled track leaking its gain onto whatever
 * the deck is handed next. */
function releaseDeck(index: number): void {
  detach(decks()[index]);
  setDeckLevel(index, 1);
}

/**
 * Wake the audio session, from the first user gesture of the session.
 *
 * Order is everything here, and getting it wrong is what silenced Auto Mode in
 * the installed iOS app. Routing an element that is *already playing* into a
 * freshly created context, with a `resume()` nobody waited for, is the one
 * sequence WebKit punishes — and `createMediaElementSource` is irreversible, so
 * the punishment is total silence with the transport still claiming to play.
 *
 * So: create and unlock the context in the gesture, prime the session with a
 * silent buffer (what actually flips WebKit's audio session into a playback
 * category), and route the decks *before either has ever played*. That is the
 * sequence that works, and it is why this runs at the first tap rather than at
 * the tap that opens Auto Mode.
 *
 * The deck unlock is part of that order, not a preamble to it. Spending the
 * silent sample first is what makes `createMediaElementSource` route two decks
 * that are sounding at that instant — the punished sequence, arrived at from the
 * other side — so it happens once the decks are routed and still untouched.
 *
 * Idempotent and safe to call from anywhere. `probeContext` and the audibility
 * watch behind it are the proof that it worked; neither is trusted on faith.
 */
export function unlockAudio(): boolean {
  if (graphState !== 'untested') {
    resumeContext();
    unlockDecks();
    return graphState === 'ready';
  }
  const Context = globalThis.AudioContext
    ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) {
    graphState = 'unavailable';
    unlockDecks();
    return false;
  }
  try {
    const list = decks();
    const context = new Context();
    void context.resume?.().catch(() => {});
    primeAudioSession(context);
    const master = context.createGain();
    master.gain.value = 1;
    const monitor = context.createGain();
    monitor.gain.value = allMuted ? 0 : masterVolume;
    // Reach the speakers before anything is routed in: a graph that throws
    // halfway would otherwise leave a deck connected to nothing audible.
    if (typeof context.createDynamicsCompressor === 'function') {
      const peak = context.createDynamicsCompressor();
      // Idle threshold is 0 dBFS — nothing below full scale is touched, so
      // ordinary playback sounds exactly as it does with no graph at all. Only
      // a blend, where two tracks sum, pulls it down to catch the overshoot.
      peak.threshold.value = 0;
      peak.knee.value = 8;
      peak.ratio.value = 6;
      peak.attack.value = 0.003;
      peak.release.value = 0.18;
      master.connect(peak);
      peak.connect(monitor);
      limiter = peak;
      programOutput = peak;
    } else {
      master.connect(monitor);
      programOutput = master;
    }
    monitor.connect(context.destination);
    if (typeof context.createAnalyser === 'function') {
      const tap = context.createAnalyser();
      tap.fftSize = 256;
      programOutput.connect(tap);
      analyser = tap;
    }
    const effects: DeckEffects[] = [];
    const levels: GainNode[] = [];
    const gains = list.map((deck, index) => {
      const gain = context.createGain();
      gain.gain.value = mixGains[index];
      // Volume levelling sits upstream of `master`, so it reaches the broadcast
      // tap as well as the speakers — a Live listener hears the same levelled
      // programme the broadcaster does. Seeded from the shadow so a level set
      // before the first gesture survives into the graph.
      const level = context.createGain();
      level.gain.value = appliedLevel(index);
      levels.push(level);
      const source = context.createMediaElementSource(deck);
      if (typeof context.createBiquadFilter === 'function') {
        const low = context.createBiquadFilter();
        low.type = 'lowshelf';
        low.frequency.value = 220;
        low.gain.value = 0;
        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 22000;
        filter.Q.value = 0.7;
        source.connect(low).connect(filter).connect(level).connect(gain).connect(master);
        // No echo send here: see `ensureEcho`.
        effects.push({ low, filter, source, level });
      } else {
        source.connect(level).connect(gain).connect(master);
        effects.push({ source, level });
      }
      return gain;
    });
    for (const deck of list) deck.volume = 1;
    audioContext = context;
    deckGains = gains;
    levelNodes = levels;
    deckEffects = effects;
    masterGain = master;
    monitorGain = monitor;
    graphState = 'ready';
    bindAudibilityTriggers();
    watchContextState(context);
    // Routed and never played: now the sample can be spent, still inside the
    // gesture that owes the decks their playback permission.
    unlockDecks();
    probeContext(context);
    if (deckIsPlaying(decks()[activeIndex])) startAudibilityWatch();
    return true;
  } catch {
    discardGraph();
    graphState = 'unavailable';
    applyDeckVolume();
    unlockDecks();
    return false;
  }
}

/** A 44-byte WAV holding one silent sample. */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

/**
 * Let each deck play once, from inside the gesture.
 *
 * Playback permission is granted per element, not per page: a deck that has
 * never sounded is still locked, and the first thing it is ever asked to do is
 * start the next track — from an `ended` handler or the mixer's ticker, neither
 * of which carries a gesture. Spending one silent sample on each deck here is
 * what makes those later, gestureless starts legal.
 *
 * Only ever touches an empty deck, and re-checks before cleaning up, so it can
 * never interfere with a real track that started in the same gesture.
 */
const unlockedDecks = new WeakSet<HTMLAudioElement>();

/**
 * Whether this deck is spending its unlock sample rather than playing music.
 *
 * `play()` clears `paused` the moment it is called and the platform answers when
 * it feels like it — on a cold iOS launch that can be hundreds of milliseconds.
 * For that whole window an empty deck is indistinguishable from a sounding one
 * unless the sample is recognised for what it is, and everything that asks "is
 * this playing?" gets the wrong answer: the graph watchdog, and Live's view of
 * whether the broadcaster has anything to send.
 */
function holdsUnlockSample(deck: HTMLAudioElement): boolean {
  return (deck.currentSrc || deck.getAttribute('src') || '') === SILENT_WAV;
}

function unlockDecks(): void {
  for (const deck of decks()) {
    // Once per element, and never over a deck that is holding a track: this is
    // called from every gesture, including typing in a search field. A deck only
    // counts as unlocked once a play actually succeeded, so a call that was not
    // really a gesture leaves it to be retried by the next one.
    if (unlockedDecks.has(deck)) continue;
    if (deck.getAttribute('src') !== null || deck.currentSrc) continue;
    deck.muted = true;
    deck.src = SILENT_WAV;
    const release = () => {
      deck.muted = graphState === 'ready' ? false : allMuted;
      if (deck.src !== SILENT_WAV) return; // a real track claimed this deck
      deck.pause();
      deck.removeAttribute('src');
      deck.load();
    };
    void deck.play().then(
      () => {
        unlockedDecks.add(deck);
        release();
      },
      release,
    );
  }
}

/**
 * Start and immediately end one silent sample.
 *
 * A context can report `running` while the platform has not actually given the
 * page an audio session; pushing a real buffer through it is what claims one.
 */
function primeAudioSession(context: AudioContext): void {
  if (typeof context.createBuffer !== 'function' || typeof context.createBufferSource !== 'function') return;
  try {
    const buffer = context.createBuffer(1, 1, context.sampleRate || 44100);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
  } catch {
    /* a context that refuses a one-sample buffer is caught by the probe */
  }
}

/** True once `resume()` has been asked for; the answer is the probe's job. */
function resumeContext(): void {
  if (audioContext && audioContext.state !== 'running') {
    void audioContext.resume?.().catch(() => {});
  }
}

/**
 * Confirm the context is really rendering.
 *
 * `state === 'running'` is a claim, not evidence: an interrupted iOS context can
 * report it while its clock stands still. A clock that advances is the only
 * proof that samples are being produced, and by the time this runs the decks are
 * already routed — so a failure here has to be recovered from, not just noted.
 */
function probeContext(context: AudioContext): void {
  const startedAt = context.currentTime;
  setTimeout(() => {
    if (audioContext !== context || graphState !== 'ready') return;
    if (context.state === 'running' && context.currentTime > startedAt) return;
    void context.resume?.().catch(() => {});
    setTimeout(() => {
      if (audioContext !== context || graphState !== 'ready') return;
      if (context.state === 'running' && context.currentTime > startedAt) return;
      abandonGraph('context_stalled');
    }, PROBE_MS);
  }, PROBE_MS);
}

/** A context can be interrupted behind our back — a call, Siri, a Bluetooth
 * route change on the way into a car. None of those resume on their own. */
function watchContextState(context: AudioContext): void {
  if (typeof context.addEventListener !== 'function') return;
  context.addEventListener('statechange', () => {
    if (audioContext !== context || graphState !== 'ready') return;
    if (context.state !== 'running') void context.resume?.().catch(() => {});
  });
}

let audibilityTimer: ReturnType<typeof setInterval> | null = null;
let silenceSince: number | null = null;
let lastAudiblePosition = -1;
let silenceProbe: Uint8Array<ArrayBuffer> | null = null;
let audibilityBound = false;

/** Watch only while something is playing: a paused player is silent on purpose,
 * and a timer that runs anyway is exactly the kind of idle wakeup the player
 * just finished getting rid of. */
function bindAudibilityTriggers(): void {
  if (audibilityBound) return;
  audibilityBound = true;
  onDeckEvent('play', (event) => {
    if (isActiveDeck(event.currentTarget)) startAudibilityWatch();
  });
  onDeckEvent('pause', (event) => {
    if (isActiveDeck(event.currentTarget)) stopAudibilityWatch();
  });
}

function startAudibilityWatch(): void {
  if (audibilityTimer || graphState !== 'ready' || !analyser) return;
  silenceSince = null;
  lastAudiblePosition = -1;
  audibilityTimer = setInterval(checkAudible, AUDIBILITY_TICK_MS);
}

function stopAudibilityWatch(): void {
  if (audibilityTimer) clearInterval(audibilityTimer);
  audibilityTimer = null;
  silenceSince = null;
}

/**
 * Catch a graph that has stopped sounding.
 *
 * Only a deck whose media clock is advancing can be judged: a buffering or
 * paused deck is legitimately silent. Against that, digital silence on the
 * master bus means the samples are not reaching the speakers, whatever the
 * element and the context claim.
 */
function checkAudible(): void {
  if (graphState !== 'ready' || !analyser) {
    stopAudibilityWatch();
    return;
  }
  // A backgrounded page cannot be judged. Its `setInterval` is throttled to
  // whatever the platform feels like, so the elapsed time this verdict rests on
  // is not the elapsed time it thinks it is — and the verdict tears down the
  // audio graph. Reset the clock and wait until the page is real again.
  if (pageHidden()) {
    silenceSince = null;
    lastAudiblePosition = -1;
    return;
  }
  const deck = decks()[activeIndex];
  if (deck.paused || deck.ended) {
    silenceSince = null;
    return;
  }
  const position = deck.currentTime || 0;
  const advancing = position > lastAudiblePosition + 0.05;
  lastAudiblePosition = position;
  if (!advancing) {
    // Buffering, not silence. The store's own stall recovery owns this case.
    silenceSince = null;
    return;
  }
  if (audioContext && audioContext.state !== 'running') void audioContext.resume?.().catch(() => {});
  if (!silenceProbe || silenceProbe.length !== analyser.frequencyBinCount) {
    silenceProbe = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.getByteTimeDomainData(silenceProbe);
  let peak = 0;
  for (const sample of silenceProbe) peak = Math.max(peak, Math.abs(sample - 128));
  if (peak > SILENCE_EPSILON) {
    silenceSince = null;
    return;
  }
  if (silenceSince === null) {
    silenceSince = Date.now();
    return;
  }
  if (Date.now() - silenceSince >= DEAD_GRAPH_MS) abandonGraph('silent_output');
}

function discardGraph(): void {
  stopAudibilityWatch();
  const context = audioContext;
  const lostBroadcast = broadcastCapture?.kind === 'program';
  releaseBroadcastCapture();
  audioContext = null;
  deckGains = null;
  // The nodes go; `levelGains` stays, so the levels survive into whatever
  // replaces the graph.
  levelNodes = null;
  deckEffects = null;
  masterGain = null;
  monitorGain = null;
  limiter = null;
  programOutput = null;
  analyser = null;
  silenceProbe = null;
  if (context && typeof context.close === 'function') void context.close().catch(() => {});
  if (lostBroadcast) broadcastLostReporter?.();
}

/**
 * Give up on a graph that is not sounding, without giving up on the music.
 *
 * There is no way to unroute an element, so the elements go too: new decks are
 * built, the listeners registered through `onDeckEvent` follow them, and what
 * was playing is restored where it left off. The mixer keeps working on element
 * volume for the rest of this page load, and the next one tries the real graph
 * again — a device is never written off.
 */
function abandonGraph(reason: GraphFailure['reason']): void {
  if (graphState !== 'ready') return;
  // This replaces both media elements. In the background that is not a recovery
  // but the failure itself: the elements that hold iOS's audio session are
  // destroyed and the new ones cannot claim it back without a gesture, so a
  // graph that was merely quiet becomes a drive that ends in silence. Whatever
  // is wrong will still be wrong when the listener is looking.
  if (pageHidden()) {
    pendingAbandon = reason;
    return;
  }
  const contextState = audioContext?.state ?? 'closed';
  const previous = decks()[activeIndex];
  // A deck holding the unlock sample is holding nothing: restoring it would hand
  // the replacement deck a silent WAV as the track it is meant to be playing,
  // and reporting it as music that failed to come back tells the listener their
  // audio was interrupted when the only thing that happened was a tap on a page
  // with nothing playing.
  const unlocking = holdsUnlockSample(previous);
  const restore = {
    url: unlocking ? '' : previous.currentSrc || previous.getAttribute('src') || '',
    position: unlocking ? 0 : previous.currentTime || 0,
    rate: previous.playbackRate || 1,
    wasPlaying: !unlocking && !previous.paused && !previous.ended,
  };
  graphState = 'unavailable';
  cancelMix('failed');
  stopRateReturn();
  for (const deck of decks()) deck.pause();
  discardGraph();

  loadSeq += 1;
  elements = [createDeck(), createDeck()];
  // The track being restored moves to deck 0, so its level moves with it.
  // Without this a levelled track would come back at the wrong volume on top of
  // whatever else just went wrong.
  const restoredLevel = levelGains[activeIndex];
  activeIndex = 0;
  mixGains[0] = 1;
  mixGains[1] = 0;
  levelGains[0] = restoredLevel;
  levelGains[1] = 1;
  stagedUrl = '';
  applyDeckVolume();
  for (const deck of elements) deck.muted = allMuted;

  let resumed = false;
  if (restore.url) {
    const deck = elements[0];
    const token = loadSeq;
    deck.src = restore.url;
    deck.playbackRate = restore.rate;
    const cue = () => {
      if (token !== loadSeq) return;
      const duration = deck.duration;
      deck.currentTime = Number.isFinite(duration) && duration > 0
        ? Math.min(restore.position, Math.max(0, duration - 0.05))
        : restore.position;
    };
    if (deck.readyState >= 1) cue();
    else deck.addEventListener('loadedmetadata', cue, { once: true });
    if (restore.wasPlaying) {
      resumed = true;
      void deck.play().catch(() => {
        // Some platforms want a fresh gesture for an element that has never
        // played. The store turns this into a visible "tap to resume".
        graphReporter?.({
          reason,
          wasPlaying: restore.wasPlaying,
          resumed: false,
          contextState,
          positionSec: restore.position,
        });
      });
    }
  }
  // Whichever deck is still empty is locked again; unlock it now so the track
  // after this one can start without a gesture the listener will not be there
  // to give. Best effort — this does not run from one.
  unlockDecks();
  graphReporter?.({
    reason,
    wasPlaying: restore.wasPlaying,
    resumed,
    contextState,
    positionSec: restore.position,
  });
}

/** Whether the decks are routed through a graph that is believed to be sounding. */
export function graphReady(): boolean {
  return graphState === 'ready' && Boolean(audioContext && deckGains && masterGain && monitorGain);
}

function activeAudioTrack(stream: MediaStream): MediaStreamTrack | null {
  return stream.getAudioTracks().find((track) => track.readyState !== 'ended') ?? null;
}

function deckIsPlaying(deck: HTMLAudioElement): boolean {
  return !deck.paused
    && !deck.ended
    && Boolean(deck.currentSrc || deck.getAttribute('src'))
    && !holdsUnlockSample(deck);
}

/** The element is the source of truth across Music, Auto and Now Playing. */
export function broadcastPlaybackActive(): boolean {
  return deckIsPlaying(audioEl());
}

function releaseBroadcastCapture(): void {
  const capture = broadcastCapture;
  broadcastCapture = null;
  broadcastElement = null;
  const cleanup = broadcastCaptureCleanup;
  broadcastCaptureCleanup = null;
  cleanup?.();
  if (!capture) return;
  if (capture.kind === 'program' && broadcastDestination) {
    try {
      programOutput?.disconnect(broadcastDestination);
    } catch {
      /* the graph was already torn down */
    }
    broadcastDestination = null;
  }
  for (const track of capture.stream.getTracks()) track.stop();
}

function programBroadcastCapture(): BroadcastCapture | null {
  if (!graphReady() || !audioContext || !programOutput) return null;
  if (broadcastCapture?.kind === 'program') return broadcastCapture;
  releaseBroadcastCapture();
  if (typeof audioContext.createMediaStreamDestination !== 'function') return null;
  broadcastDestination = audioContext.createMediaStreamDestination();
  programOutput.connect(broadcastDestination);
  const track = activeAudioTrack(broadcastDestination.stream);
  if (track && 'contentHint' in track) track.contentHint = 'music';
  const stream = broadcastDestination.stream;
  broadcastCapture = {
    kind: 'program',
    stream,
    onTrackChange: () => () => {},
  };
  return broadcastCapture;
}

interface CapturableAudioElement extends HTMLAudioElement {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
}

function elementBroadcastCapture(element: HTMLAudioElement): BroadcastCapture | null {
  if (broadcastCapture?.kind === 'element' && broadcastElement === element) return broadcastCapture;
  releaseBroadcastCapture();
  const capture = (element as CapturableAudioElement).captureStream
    ?? (element as CapturableAudioElement).mozCaptureStream;
  if (!capture) return null;
  let stream: MediaStream;
  try {
    stream = capture.call(element);
  } catch {
    return null;
  }
  const listeners = new Set<(track: MediaStreamTrack | null) => void>();
  let observedTrack: MediaStreamTrack | null = null;
  const observeTrack = () => {
    const next = activeAudioTrack(stream);
    if (next === observedTrack) return;
    if (observedTrack && typeof observedTrack.removeEventListener === 'function') {
      observedTrack.removeEventListener('ended', notify);
    }
    observedTrack = next;
    if (observedTrack && typeof observedTrack.addEventListener === 'function') {
      observedTrack.addEventListener('ended', notify);
    }
  };
  const notify = () => {
    observeTrack();
    const track = activeAudioTrack(stream);
    for (const listener of listeners) listener(track);
  };
  stream.addEventListener('addtrack', notify);
  stream.addEventListener('removetrack', notify);
  observeTrack();
  broadcastCaptureCleanup = () => {
    stream.removeEventListener('addtrack', notify);
    stream.removeEventListener('removetrack', notify);
    if (observedTrack && typeof observedTrack.removeEventListener === 'function') {
      observedTrack.removeEventListener('ended', notify);
    }
    listeners.clear();
  };
  broadcastElement = element;
  broadcastCapture = {
    kind: 'element',
    stream,
    onTrackChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return broadcastCapture;
}

/**
 * Acquire a Live source without changing local playback. The normal route is
 * the post-limiter program. Direct element capture is only used after the
 * graph's own recovery has chosen its safe, graphless mode for this page load.
 */
export function acquireBroadcastCapture(): BroadcastCapture | null {
  const program = programBroadcastCapture();
  if (program) return program;
  const element = audioEl();
  if (!element.currentSrc && !element.getAttribute('src')) return null;
  const fallback = elementBroadcastCapture(element);
  return fallback && activeAudioTrack(fallback.stream) ? fallback : null;
}

/** Backwards-compatible stream-only access for consumers that do not need swaps. */
export function broadcastStream(): MediaStream | null {
  return acquireBroadcastCapture()?.stream ?? null;
}

/** Release the live tap without disturbing the local monitor graph. */
export function releaseBroadcastStream(): void {
  releaseBroadcastCapture();
}

export interface ProgramMixSnapshot {
  contextTime: number;
  activeIndex: number;
  phase: MixPhase;
  technique?: LiveTransitionPlan['technique'];
  progress: number;
  dominant: boolean;
  decks: Array<{ index: number; position: number; duration: number; gain: number }>;
}

/** Read-only sample of the exact graph state used for live metadata. */
export function programMixSnapshot(): ProgramMixSnapshot {
  const list = decks();
  let progress = 0;
  if (mix?.mixStart != null) {
    const incoming = list[mix.toIndex];
    progress = Math.min(1, Math.max(0, (incoming.currentTime - mix.mixStart) / Math.max(0.001, mix.overlap * mix.rate)));
  }
  const liveGains = mix?.phase === 'crossfading'
    ? [
        mix.fromIndex === 0 ? Math.cos(progress * Math.PI * 0.5) : Math.sin(progress * Math.PI * 0.5),
        mix.fromIndex === 1 ? Math.cos(progress * Math.PI * 0.5) : Math.sin(progress * Math.PI * 0.5),
      ]
    : mixGains;
  return {
    contextTime: audioContext?.currentTime ?? 0,
    activeIndex,
    phase: mix?.phase ?? 'idle',
    technique: mix?.technique,
    progress,
    dominant: mix?.dominant ?? false,
    decks: list.map((deck, index) => ({
      index,
      position: Number.isFinite(deck.currentTime) ? deck.currentTime : 0,
      duration: Number.isFinite(deck.duration) ? deck.duration : 0,
      gain: liveGains[index],
    })),
  };
}

/**
 * Arm or release the master limiter.
 *
 * Two decks summing can overshoot; one deck cannot. Keeping the threshold at
 * full scale outside a blend is what lets every listener stay routed through the
 * graph without the mixer colouring ordinary playback.
 */
function setBlendLimiter(active: boolean): void {
  if (!limiter || !audioContext) return;
  const now = audioContext.currentTime;
  const target = active ? -6 : 0;
  const param = limiter.threshold;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  if (typeof param.linearRampToValueAtTime === 'function') {
    param.linearRampToValueAtTime(target, now + 0.25);
  } else {
    param.value = target;
  }
}

export interface LiveTransitionPlan {
  technique: 'long_blend' | 'bass_swap' | 'filter_blend' | 'echo_cut' | 'structural_fade' | 'safe_fade';
  /** Position in the *outgoing* deck at which the blend begins. */
  out_cue: number;
  in_cue: number;
  overlap_seconds: number;
  overlap_bars: number;
  playback_rate: number;
  confidence: number;
  sync?: { phase_tolerance_ms?: number };
  automation?: { eq?: 'bass_swap' | 'neutral'; filter?: boolean; echo_out?: boolean };
}

export type MixPhase = 'idle' | 'armed' | 'prerolling' | 'crossfading';
export type MixCancelReason = 'superseded' | 'load' | 'seek' | 'stop' | 'exit' | 'failed' | 'transport_pause';
export type ProgramTransportOrigin = 'ui' | 'media_session';

export interface ProgramTransportEvent {
  kind: 'pause' | 'resume' | 'inactive_deck_play';
  origin: ProgramTransportOrigin;
  mixPhase: MixPhase;
  dominant: boolean;
  activeIndex: number;
  hidden: boolean;
  deck0Playing: boolean;
  deck1Playing: boolean;
}

let programTransportReporter: ((event: ProgramTransportEvent) => void) | null = null;

/** Let the store publish local-only evidence about whole-program transport. */
export function setProgramTransportReporter(
  reporter: ((event: ProgramTransportEvent) => void) | null,
): void {
  programTransportReporter = reporter;
}

function reportProgramTransport(
  kind: ProgramTransportEvent['kind'],
  origin: ProgramTransportOrigin,
  phase: MixPhase,
  dominant: boolean,
): void {
  const list = decks();
  programTransportReporter?.({
    kind,
    origin,
    mixPhase: phase,
    dominant,
    activeIndex,
    hidden: pageHidden(),
    deck0Playing: deckIsPlaying(list[0]),
    deck1Playing: deckIsPlaying(list[1]),
  });
}

export interface MixCallbacks {
  /** The incoming deck is loaded and cued; the handoff is now committed. */
  onArmed?(): void;
  /** The incoming deck owns playback from this moment. */
  onDominant(): void;
  onComplete(position: number): void;
  onCancel(reason: MixCancelReason): void;
  onError(error: unknown): void;
}

interface ActiveMix {
  phase: Exclude<MixPhase, 'idle'>;
  fromIndex: number;
  toIndex: number;
  outCue: number;
  inCue: number;
  /** Overlap in wall seconds. */
  overlap: number;
  rate: number;
  preroll: number;
  /** Incoming media position at which the crossfade started. */
  mixStart: number | null;
  technique: LiveTransitionPlan['technique'];
  phaseTolerance: number;
  phaseCorrected: boolean;
  dominant: boolean;
  /** A listener-requested skip: hand over as soon as the blend begins. */
  manual: boolean;
  callbacks: MixCallbacks;
}

let mix: ActiveMix | null = null;
let mixGeneration = 0;
let mixTimer: ReturnType<typeof setTimeout> | null = null;
let rateTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Build the echo send for a deck, if it does not have one.
 *
 * Only `echo_cut` ever uses this, and only on the outgoing deck — but a delay
 * line inside a feedback loop can never be proved silent, so Web Audio has to
 * render it regardless of the send being at zero. Built up front, that was two
 * permanently running delay lines for every session that so much as opened Auto
 * Mode. Built here and torn down in `resetDeckEffects`, it only costs the audio
 * thread anything during the blend that asked for it.
 */
function ensureEcho(index: number): void {
  const effect = deckEffects?.[index];
  if (!effect || effect.echoWet || !audioContext || !masterGain) return;
  // Tapped after levelling, not at the raw element: an echo tail returns
  // straight into `masterGain`, so tapping `source` would put an un-levelled
  // copy of the track under a levelled programme.
  const source = effect.level ?? effect.source;
  if (!source || typeof audioContext.createDelay !== 'function') return;
  const delay = audioContext.createDelay(1);
  delay.delayTime.value = 0.28;
  const wet = audioContext.createGain();
  wet.gain.value = 0;
  const feedback = audioContext.createGain();
  feedback.gain.value = 0.32;
  source.connect(delay).connect(wet).connect(masterGain);
  delay.connect(feedback).connect(delay);
  effect.delay = delay;
  effect.echoWet = wet;
  effect.echoFeedback = feedback;
}

/** Break the feedback loop so the graph can drop it. The send is already at
 * zero by the time this runs, so nothing audible is being cut. */
function disposeEcho(effect: DeckEffects): void {
  if (!effect.echoWet) return;
  effect.echoFeedback?.disconnect();
  effect.echoWet.disconnect();
  effect.delay?.disconnect();
  effect.delay = undefined;
  effect.echoWet = undefined;
  effect.echoFeedback = undefined;
}

function resetDeckEffects(index: number): void {
  const effect = deckEffects?.[index];
  if (!effect || !audioContext) return;
  const now = audioContext.currentTime;
  const params = [
    effect.low?.gain,
    effect.filter?.frequency,
    effect.echoWet?.gain,
    effect.echoFeedback?.gain,
  ];
  for (const param of params) param?.cancelScheduledValues(now);
  effect.low?.gain.setValueAtTime(0, now);
  effect.filter?.frequency.setValueAtTime(22000, now);
  effect.echoWet?.gain.setValueAtTime(0, now);
  disposeEcho(effect);
}

function scheduleCurve(param: AudioParam | undefined, values: number[], duration: number): void {
  if (!param || !audioContext) return;
  const now = audioContext.currentTime;
  const span = Math.max(0.05, duration);
  param.cancelScheduledValues(now);
  param.setValueAtTime(values[0], now);
  if (typeof param.setValueCurveAtTime === 'function') {
    param.setValueCurveAtTime(Float32Array.from(values), now, span);
  } else {
    param.linearRampToValueAtTime(values[values.length - 1], now + span);
  }
}

/** Schedule one continuous curve; the supervisory timer never rewrites it. */
function scheduleCrossfade(current: ActiveMix): void {
  if (!deckGains || !audioContext) return;
  setBlendLimiter(true);
  const points = 96;
  const incoming = Array.from(
    { length: points },
    (_, index) => Math.sin((index / (points - 1)) * Math.PI * 0.5),
  );
  const outgoing = Array.from(
    { length: points },
    (_, index) => Math.cos((index / (points - 1)) * Math.PI * 0.5),
  );
  scheduleCurve(deckGains[current.toIndex].gain, incoming, current.overlap);
  scheduleCurve(deckGains[current.fromIndex].gain, outgoing, current.overlap);

  const outEffect = deckEffects?.[current.fromIndex];
  const inEffect = deckEffects?.[current.toIndex];
  if (current.technique === 'bass_swap' || current.technique === 'long_blend') {
    scheduleCurve(outEffect?.low?.gain, [0, 0, -4, -12, -18, -18], current.overlap);
    scheduleCurve(inEffect?.low?.gain, [-18, -18, -12, -4, 0, 0], current.overlap);
  }
  if (current.technique === 'filter_blend' || current.technique === 'long_blend') {
    scheduleCurve(outEffect?.filter?.frequency, [22000, 18000, 9000, 3500, 1200, 700], current.overlap);
    scheduleCurve(inEffect?.filter?.frequency, [900, 1600, 4200, 10000, 18000, 22000], current.overlap);
  }
  if (current.technique === 'echo_cut') {
    ensureEcho(current.fromIndex);
    scheduleCurve(outEffect?.echoWet?.gain, [0, 0.05, 0.12, 0.24, 0.32, 0.18], current.overlap);
  }
}

/**
 * How long the supervisor waits before looking at the media clock again.
 *
 * `armed` is a long wait: the DJ commits a transition COMMIT_LEAD_SECONDS (45)
 * before the out-cue, and every look until the preroll point does nothing but
 * compare two numbers. Watching that at mix resolution is ~1100 timer wakeups
 * per track, which on a low-power laptop is enough on its own to keep the CPU
 * out of its deeper idle states for most of the song. The coarse rate still
 * lands far inside the head start the preroll allows (MIN_OVERLAP is 1.2s), and
 * a late start is what `prerolling`'s phase correction exists to absorb —
 * everything that actually needs resolution runs from that phase on.
 */
function tickInterval(): number {
  const current = mix;
  if (!current || current.phase !== 'armed') return TICK_MS;
  const from = decks()[current.fromIndex];
  const runway = current.outCue - current.preroll - (from.currentTime || 0);
  return runway > ARMED_FINE_LEAD ? ARMED_TICK_MS : TICK_MS;
}

/** Bumped by every stop, so a timeout already in flight cannot re-arm itself. */
let tickerToken = 0;

function startTicker(): void {
  stopTicker();
  const token = tickerToken;
  const run = () => {
    mixTimer = null;
    tick();
    // tick() may have finished, failed or cancelled the mix, each of which
    // stops the ticker. Reviving it here would outlive the transition.
    if (token !== tickerToken) return;
    mixTimer = setTimeout(run, tickInterval());
  };
  mixTimer = setTimeout(run, tickInterval());
}

function stopTicker(): void {
  tickerToken += 1;
  if (mixTimer) clearTimeout(mixTimer);
  mixTimer = null;
}

function stopRateReturn(): void {
  if (rateTimer) clearInterval(rateTimer);
  rateTimer = null;
}

/** Walk a beatmatched deck back to its own tempo once the blend is over. Over
 * eight seconds, with pitch preserved, this is inaudible — and leaving the deck
 * permanently detuned is not. */
function scheduleRateReturn(index: number): void {
  stopRateReturn();
  const deck = decks()[index];
  const from = deck.playbackRate;
  if (Math.abs(from - 1) < 0.001) {
    deck.playbackRate = 1;
    return;
  }
  const startedAt = Date.now();
  rateTimer = setInterval(() => {
    if (decks()[activeIndex] !== deck) {
      stopRateReturn();
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / RATE_RETURN_MS);
    deck.playbackRate = from + (1 - from) * progress;
    if (progress >= 1) stopRateReturn();
  }, 200);
}

/** Release a stream. Clearing `src` (rather than just pausing) is what makes the
 * browser abort the in-flight request — for previews that request is a proxied
 * googlevideo stream, so leaving it open keeps the engine streaming bytes nobody
 * is listening to. */
function detach(deck: HTMLAudioElement): void {
  deck.pause();
  deck.playbackRate = 1;
  if (deck.getAttribute('src') === null && !deck.currentSrc) return;
  // Not while the page is in the background. This runs the instant a handoff
  // completes, before the incoming deck has produced a single sample, and
  // `load()` is what resets a media element — on iOS that is enough to hand the
  // audio session back and end playback for a phone that is locked in a pocket.
  // Holding the stream costs nothing until then: `stage` assigns this same deck
  // a new `src` milliseconds later, which aborts the old request anyway.
  if (pageHidden()) {
    pendingDetach.add(deck);
    return;
  }
  deck.removeAttribute('src');
  deck.load();
}

/** Decks whose stream outlived their track because the page was hidden. */
const pendingDetach = new Set<HTMLAudioElement>();
/** A graph teardown the background refused to carry out. See `abandonGraph`. */
let pendingAbandon: GraphFailure['reason'] | null = null;

/** Finish what the background deferred, now that the page can afford it. */
function flushDeferredWork(): void {
  for (const deck of pendingDetach) {
    // Skip a deck that has been handed a real track in the meantime — `stage`
    // and `load` both assign `src` without going through `detach`.
    if (deck.paused && (deck.getAttribute('src') !== null || deck.currentSrc)) {
      deck.removeAttribute('src');
      deck.load();
    }
  }
  pendingDetach.clear();
  const reason = pendingAbandon;
  pendingAbandon = null;
  if (reason) abandonGraph(reason);
}

let lifecycleBound = false;

/** Watch for the page coming back, once per session. Registered from `decks()`
 * so it exists as early as the elements themselves do. */
function bindLifecycle(): void {
  if (lifecycleBound) return;
  lifecycleBound = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') flushDeferredWork();
    });
  }
  // A blend is driven by a chain of timeouts, and a backgrounded page does not
  // get to keep its timers: iOS throttles them to whatever it likes and stops
  // them altogether once the page is frozen. `timeupdate` and `ended` come from
  // the media element itself and keep arriving for as long as it is sounding,
  // which on a locked phone is the only clock left. `tick` reads media clocks
  // and compares them, so being called twice for the same moment costs nothing
  // and being called at all is the difference between a handoff and silence.
  onDeckEvent('timeupdate', () => {
    if (mix) tick();
  });
  onDeckEvent('ended', () => {
    if (mix) tick();
  });
  const rejectOrphanedDeck = (event: Event) => {
    const deck = event.currentTarget as HTMLAudioElement | null;
    if (!deck || holdsUnlockSample(deck) || isActiveDeck(deck) || !deckIsPlaying(deck)) return;
    // Both decks are legitimate programme sources only while one live mix owns
    // them. Outside it, a non-active play is WebKit reviving an old media
    // session (most often after a Bluetooth/lock-screen command), never music
    // Soundsible asked to start.
    if (mix && (deck === decks()[mix.fromIndex] || deck === decks()[mix.toIndex])) return;
    const index = decks().indexOf(deck);
    if (index < 0) return;
    releaseDeck(index);
    reportProgramTransport('inactive_deck_play', 'media_session', 'idle', false);
  };
  onDeckEvent('play', rejectOrphanedDeck);
  onDeckEvent('playing', rejectOrphanedDeck);
}

/**
 * Tear down the running transition.
 *
 * Whichever deck currently owns playback keeps it; the other is released. That
 * single rule is what keeps audio and UI from disagreeing: before the handoff a
 * cancel means "stay on the outgoing track", after it a cancel means "the
 * incoming track is simply the current track now".
 */
function cancelMix(reason: MixCancelReason): void {
  const current = mix;
  mixGeneration += 1;
  stopTicker();
  mix = null;
  setBlendLimiter(false);
  if (!current) return;
  const keep = current.dominant ? current.toIndex : current.fromIndex;
  const drop = 1 - keep;
  activeIndex = keep;
  setDeckGain(keep, 1);
  setDeckGain(drop, 0);
  resetDeckEffects(keep);
  resetDeckEffects(drop);
  releaseDeck(drop);
  if (current.dominant) scheduleRateReturn(keep);
  current.callbacks.onCancel(reason);
}

function finishMix(): void {
  const current = mix;
  if (!current) return;
  const incoming = decks()[current.toIndex];
  stopTicker();
  mix = null;
  setBlendLimiter(false);
  setDeckGain(current.toIndex, 1);
  setDeckGain(current.fromIndex, 0);
  resetDeckEffects(current.toIndex);
  resetDeckEffects(current.fromIndex);
  if (!current.dominant) {
    activeIndex = current.toIndex;
    current.callbacks.onDominant();
  }
  releaseDeck(current.fromIndex);
  scheduleRateReturn(current.toIndex);
  current.callbacks.onComplete(incoming.currentTime);
}

function failMix(error: unknown): void {
  const current = mix;
  if (!current) return;
  mixGeneration += 1;
  stopTicker();
  mix = null;
  setBlendLimiter(false);
  const keep = current.dominant ? current.toIndex : current.fromIndex;
  activeIndex = keep;
  setDeckGain(keep, 1);
  setDeckGain(1 - keep, 0);
  resetDeckEffects(keep);
  resetDeckEffects(1 - keep);
  releaseDeck(1 - keep);
  current.callbacks.onError(error);
}

/**
 * One tick of the mixer.
 *
 * Every decision reads a *media* clock — `deck.currentTime` — rather than wall
 * time. A buffering outgoing deck therefore delays its own transition instead of
 * being mixed out of at the wrong musical moment, and a pause freezes the blend
 * exactly where it was.
 */
function tick(): void {
  const current = mix;
  if (!current) {
    stopTicker();
    return;
  }
  const from = decks()[current.fromIndex];
  const to = decks()[current.toIndex];

  if (current.phase === 'armed') {
    if (from.paused && !from.ended) return;
    const due = from.ended || from.currentTime >= current.outCue - current.preroll;
    if (!due) return;
    // Invariant: nothing fades until the incoming deck can actually sound.
    if (to.readyState < 3) {
      // If the outgoing song has ended, waiting no longer protects continuity:
      // it is silence. Fail the committed handoff while ownership still belongs
      // to the outgoing deck so the store can promote a verified fallback.
      if (from.ended) failMix(new Error('incoming deck was not ready at boundary'));
      return;
    }
    current.phase = 'prerolling';
    void to.play().catch((error) => failMix(error));
    // A requested skip has no head start to wait out: fall straight through.
    if (!current.manual) return;
  }

  // A pause anywhere holds the blend where it is; the gains stay put because
  // the incoming media clock is what drives them.
  if (to.paused || (from.paused && !from.ended)) return;

  if (current.phase === 'prerolling') {
    const outRemaining = current.outCue - from.currentTime;
    const inRemaining = (current.inCue - to.currentTime) / current.rate;
    const phaseError = inRemaining - outRemaining;
    if (
      !current.manual
      && !current.phaseCorrected
      && outRemaining > 0.15
      && Math.abs(phaseError) > current.phaseTolerance
    ) {
      // The incoming deck is silent. Correcting its playhead here prevents a
      // flam instead of trying to hide one after both tracks are audible.
      to.currentTime = Math.max(0, current.inCue - outRemaining * current.rate);
      current.phaseCorrected = true;
      return;
    }
    const due = current.manual || from.ended
      || (outRemaining <= current.phaseTolerance && inRemaining <= current.phaseTolerance);
    if (!due) return;
    if (!from.ended && !current.manual) {
      const target = current.inCue + Math.max(0, from.currentTime - current.outCue) * current.rate;
      if (Math.abs(to.currentTime - target) > current.phaseTolerance * current.rate) {
        to.currentTime = Math.max(0, target);
      }
    }
    current.mixStart = to.currentTime;
    current.phase = 'crossfading';
    scheduleCrossfade(current);
  }

  const span = Math.max(0.05, current.overlap * current.rate);
  const elapsed = to.currentTime - (current.mixStart ?? to.currentTime);
  const progress = Math.min(1, Math.max(0, elapsed / span));
  // Equal-power curves keep the perceived loudness steadier than linear gain,
  // especially on long blends.
  if (!deckGains || !audioContext) {
    setDeckGain(current.toIndex, Math.sin(progress * Math.PI * 0.5));
    setDeckGain(current.fromIndex, Math.cos(progress * Math.PI * 0.5));
  }
  if (!current.dominant && (current.manual || progress >= 0.5)) {
    current.dominant = true;
    activeIndex = current.toIndex;
    current.callbacks.onDominant();
  }
  if (progress >= 1) finishMix();
}

/**
 * Monotonic load counter. Every `load`/`prime`/`stop` claims the next value, so
 * an async continuation can tell whether it still owns the deck. Without it,
 * the `play()` promise of a superseded track rejects with AbortError *after* the
 * new track started, and whoever catches it reports the new track as failed.
 */
let loadSeq = 0;

/** True while `token` is still the most recent load claim. */
export function isCurrentLoad(token: number): boolean {
  return token === loadSeq;
}

/** The URL cued up on the idle deck, if any. See `stage`. */
let stagedUrl = '';

export const audioService = {
  /**
   * Point the active deck at `url` and start playing.
   *
   * Rejects only for failures that belong to *this* load: being interrupted by
   * a newer load — the shape of a listener tapping through several previews
   * before any of them starts — resolves quietly instead.
   */
  load(url: string, level: number): Promise<void> {
    cancelMix('load');
    const a = audioEl();
    const token = ++loadSeq;
    stopRateReturn();
    a.playbackRate = 1;
    // Before `src`, and required rather than defaulted: this deck is not
    // detached between tracks, so the only thing standing between a levelled
    // song and the podcast after it is that every caller passes its own level.
    setDeckLevel(activeIndex, level);
    // Assigning src runs the media load algorithm, which aborts the previous
    // fetch. No explicit detach: it would emit a spurious `pause` between the
    // two tracks and flicker the transport controls.
    a.src = url;
    return a.play().catch((err: unknown) => {
      if (token !== loadSeq) return; // superseded — the newer load owns the deck
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    });
  },
  /** Reload a stalled stream and resume from the last audible position. */
  recover(url: string, positionSec: number, level: number): Promise<void> {
    cancelMix('load');
    const a = audioEl();
    const token = ++loadSeq;
    setDeckLevel(activeIndex, level);
    a.src = url;
    const resumeAtPosition = async () => {
      if (token !== loadSeq) return;
      const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
      if (position > 0) {
        const duration = a.duration;
        a.currentTime = Number.isFinite(duration) && duration > 0
          ? Math.min(position, Math.max(0, duration - 0.05))
          : position;
      }
      try {
        await a.play();
      } catch (err: unknown) {
        if (token !== loadSeq) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        throw err;
      }
    };
    if (a.readyState >= 1) return resumeAtPosition();
    return new Promise<void>((resolve, reject) => {
      const onMetadata = () => {
        a.removeEventListener('error', onError);
        void resumeAtPosition().then(resolve, reject);
      };
      const onError = () => {
        a.removeEventListener('loadedmetadata', onMetadata);
        reject(new Error('media recovery failed'));
      };
      a.addEventListener('loadedmetadata', onMetadata, { once: true });
      a.addEventListener('error', onError, { once: true });
    });
  },
  /** Load without playing, optionally cued to `positionSec` (cross-device resume). */
  // `level` last, matching `recover`: with it second, an existing two-argument
  // call would still typecheck and quietly pass a seek position as a gain.
  prime(url: string, positionSec: number, level: number): void {
    cancelMix('load');
    const a = audioEl();
    const token = ++loadSeq;
    setDeckLevel(activeIndex, level);
    // Explicitly, before the stream is handed over. A deck that is mid-`play()`
    // from `unlockDecks` — the silent sample every gesture spends on an empty
    // deck — would otherwise carry that play straight into the track being
    // primed, and a session put back on boot would start sounding on its own.
    a.pause();
    a.src = url;
    a.load();
    const applyPosition = () => {
      if (token !== loadSeq) return;
      const pos = Math.max(0, positionSec);
      if (!Number.isFinite(pos) || pos <= 0) return;
      const dur = a.duration;
      a.currentTime = Number.isFinite(dur) && dur > 0 ? Math.min(pos, dur) : pos;
    };
    if (a.readyState >= 1) applyPosition();
    else a.addEventListener('loadedmetadata', applyPosition, { once: true });
  },
  /** Resume the one deck that owns the programme. */
  resume(origin: ProgramTransportOrigin = 'ui'): Promise<void> {
    // Once the decks are routed through the graph, their output only exists
    // inside it. Resuming here costs nothing and means any play gesture can
    // recover a context the browser suspended behind our back.
    if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {});
    const current = mix;
    const phase = current?.phase ?? 'idle';
    const dominant = current?.dominant ?? false;
    const started = audioEl().play();
    reportProgramTransport('resume', origin, phase, dominant);
    return started;
  },
  /**
   * Pause the whole programme, not whichever media element the platform happens
   * to consider its Now Playing session.
   *
   * An armed handoff has only one sounding deck and remains prepared. Once the
   * incoming deck has started, pausing closes the overlap on the deck that owns
   * playback at that instant. A later play therefore has exactly one possible
   * source; it can never revive the outgoing song underneath the current one.
   *
   * The context is deliberately left running. Suspending it costs nothing to
   * resume from a page gesture but a great deal from anywhere else, and the
   * play that follows a pause in a car arrives through MediaSession — a
   * lock-screen or steering-wheel button, not a tap on the page. A suspended
   * context that will not come back is silence; an idle one is a rounding error.
   */
  pause(origin: ProgramTransportOrigin = 'ui'): void {
    const current = mix;
    const phase = current?.phase ?? 'idle';
    const dominant = current?.dominant ?? false;
    if (current && current.phase !== 'armed') cancelMix('transport_pause');
    audioEl().pause();
    reportProgramTransport('pause', origin, phase, dominant);
  },
  /** Stop and release the stream — for teardown (track deleted, queue emptied),
   * not for pausing. */
  stop(): void {
    loadSeq += 1;
    cancelMix('stop');
    stagedUrl = '';
    releaseDeck(activeIndex);
    releaseDeck(1 - activeIndex);
  },
  seek(t: number): void {
    cancelMix('seek');
    const a = audioEl();
    if (Number.isFinite(t)) a.currentTime = Math.max(0, t);
  },
  /**
   * How far the active deck has buffered, in seconds — the furthest edge it
   * holds, not the range around the playhead.
   *
   * Read as a progress signal, never as a readiness gate: a load that is slow
   * but advancing is a slow link, and reloading it throws away everything it
   * has fetched. Returns 0 when the deck holds nothing, which is what a load
   * that is genuinely stuck looks like.
   */
  bufferedEnd(): number {
    const buffered = audioEl().buffered;
    let furthest = 0;
    for (let i = 0; i < buffered.length; i += 1) {
      const end = buffered.end(i);
      if (Number.isFinite(end) && end > furthest) furthest = end;
    }
    return furthest;
  },
  /** 0..1 — persisted so volume survives reloads. */
  setVolume(v: number): void {
    const clamped = Math.min(1, Math.max(0, v));
    masterVolume = clamped;
    if (monitorGain) monitorGain.gain.value = allMuted ? 0 : clamped;
    else applyDeckVolume();
    try {
      localStorage.setItem(VOLUME_KEY, String(clamped));
    } catch {
      /* private mode / storage disabled */
    }
  },
  getVolume(): number {
    return masterVolume;
  },
  setMuted(muted: boolean): void {
    allMuted = muted;
    applyDeckVolume();
  },
  /**
   * Set both decks' levelling at once, ramped.
   *
   * The one path allowed to change the level of a deck that is already
   * sounding, because it is the listener asking for it. Everything else waits
   * for the next track: a gain that moves under a song is exactly the artefact
   * this feature exists to avoid.
   */
  setLevels(activeLevel: number, idleLevel: number): void {
    setDeckLevel(activeIndex, activeLevel, true);
    setDeckLevel(1 - activeIndex, idleLevel, true);
  },
  /** Turn levelling on or off. Off restores unity exactly, not approximately. */
  setLevelingEnabled(enabled: boolean): void {
    if (levelingEnabled === enabled) return;
    levelingEnabled = enabled;
    // Re-assert both decks so the change is heard now, ramped rather than
    // stepped. The desired levels are untouched, so switching back on restores
    // what each deck was already meant to be at.
    setDeckLevel(activeIndex, levelGains[activeIndex], true);
    setDeckLevel(1 - activeIndex, levelGains[1 - activeIndex], true);
  },
  levelingEnabled(): boolean {
    return levelingEnabled;
  },
  unlockAudio,
  graphReady,
  acquireBroadcastCapture,
  broadcastPlaybackActive,
  broadcastStream,
  releaseBroadcastStream,
  programMixSnapshot,

  /**
   * Cue the next track on the idle deck without playing it.
   *
   * This is the whole answer to "the song ended and nothing followed". A track
   * that ends with its successor already loaded hands over inside the `ended`
   * handler itself — no network, no `src` assignment, no gap — which is both
   * instant and the only shape of continuation a phone with its screen off
   * reliably allows. Waiting until the track is over to ask the network for the
   * next one is what turned a moment of bad signal into silence for the rest of
   * the journey.
   */
  stage(url: string, level: number): void {
    if (mix || !url) return;
    const index = 1 - activeIndex;
    const idle = decks()[index];
    // Above the early return on purpose: re-staging the same URL is how a
    // track that has only just been measured gets its level onto the silent
    // deck before it is promoted.
    setDeckLevel(index, level);
    if (stagedUrl === url && (idle.getAttribute('src') !== null || idle.currentSrc)) return;
    stagedUrl = url;
    setDeckGain(index, 0);
    idle.muted = graphReady() ? false : allMuted;
    idle.playbackRate = 1;
    idle.src = url;
    idle.load();
  },

  /** Release the idle deck's stream — the staged track is no longer next. */
  clearStaged(): void {
    if (mix || !stagedUrl) return;
    stagedUrl = '';
    releaseDeck(1 - activeIndex);
  },

  /**
   * Hand playback to the staged deck, if it is holding exactly `url`.
   *
   * Returns null when there is nothing usable staged, so the caller falls back
   * to an ordinary load.
   */
  takeStaged(url: string, level: number): Promise<void> | null {
    if (mix || !url || stagedUrl !== url) return null;
    const toIndex = 1 - activeIndex;
    const to = decks()[toIndex];
    // Deliberately not a `readyState` gate. Safari downgrades `preload="auto"`
    // to metadata-only — on cellular, and for a second media element, near
    // always — so an iPhone's staged deck sits at `HAVE_METADATA` however long
    // it has been cued. Refusing it there sent every track change back to the
    // network, which is precisely what a locked phone will not do. A deck that
    // is holding the right URL is always the better start: `play()` buffers what
    // it still needs, and the fallback would make the same request from scratch
    // and throw away everything this one already has.
    if (to.networkState === NETWORK_NO_SOURCE) return null;
    const fromIndex = activeIndex;
    const token = ++loadSeq;
    stagedUrl = '';
    stopRateReturn();
    to.playbackRate = 1;
    // Already set by `stage`, but re-asserted because the caller may have a
    // fresher measurement than it had when the track was cued. Nothing moves
    // between decks here — only which deck is active.
    setDeckLevel(toIndex, level);
    // Ownership moves first: the outgoing deck's `pause` and `error` from the
    // release below then belong to a deck the store is no longer listening to.
    activeIndex = toIndex;
    setDeckGain(toIndex, 1);
    setDeckGain(fromIndex, 0);
    const started = to.play().catch((err: unknown) => {
      if (token !== loadSeq) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    });
    releaseDeck(fromIndex);
    return started;
  },
  mixPhase(): MixPhase {
    return mix?.phase ?? 'idle';
  },
  /** True once the incoming deck owns playback — the point past which cancelling
   * would mean reviving a track the listener already stopped hearing. */
  mixIsDominant(): boolean {
    return mix?.dominant ?? false;
  },
  cancelMix,
  /**
   * Bring a prepared blend forward because the listener asked for the next
   * track now. The incoming deck keeps whatever it has already buffered — a
   * skip should not pay for a fresh seek.
   */
  startMixNow(overlapSeconds = 1.6): boolean {
    const current = mix;
    if (!current || current.phase === 'crossfading') return false;
    current.manual = true;
    current.preroll = 0;
    current.overlap = Math.max(MIN_OVERLAP, overlapSeconds);
    current.outCue = decks()[current.fromIndex].currentTime;
    tick();
    return true;
  },

  /**
   * Commit to a transition: load the incoming deck, cue it, and hold.
   *
   * Nothing sounds until the outgoing deck's own clock reaches the cue, so
   * arming early is free. `manual` is a listener-requested skip: the blend
   * starts at once and the handoff is reported immediately, because the
   * listener already knows they changed the track.
   */
  armTransition(
    url: string,
    plan: LiveTransitionPlan,
    callbacks: MixCallbacks,
    options: { manual?: boolean; level: number },
  ): void {
    cancelMix('superseded');
    const generation = ++mixGeneration;
    // No graph is built here. Routing an element into an AudioContext is
    // irreversible, and this runs from the mixer's ticker — a timer is the one
    // place it must never happen. `unlockAudio` owns that, from a gesture.
    // Deliberately not awaited: the mix has to be armed before this function
    // returns, or the caller's own "is a handoff prepared?" check races it.
    if (audioContext && audioContext.state !== 'running') void audioContext.resume?.().catch(() => {});
    stagedUrl = '';

    const fromIndex = activeIndex;
    const toIndex = 1 - activeIndex;
    const from = decks()[fromIndex];
    const to = decks()[toIndex];
    const manual = options.manual === true;
    const rate = Math.min(1.06, Math.max(0.94, Number(plan.playback_rate) || 1));
    const overlap = manual
      ? Math.max(MIN_OVERLAP, Math.min(1.8, Number(plan.overlap_seconds) || 4))
      : Math.max(MIN_OVERLAP, Number(plan.overlap_seconds) || 6);
    const inCue = Math.max(0, Number(plan.in_cue) || 0);
    const preroll = manual ? 0 : Math.min(MAX_PREROLL, inCue / rate);
    const startPosition = Math.max(0, inCue - preroll * rate);
    const outCue = manual ? from.currentTime : Math.max(0, Number(plan.out_cue) || 0);

    setDeckGain(toIndex, 0);
    // The incoming deck gets its own level; the outgoing one keeps its own,
    // because it is still playing its own track. Set before `src` and before
    // the manual `tick()` below, which can reach `crossfading` inside this call.
    setDeckLevel(toIndex, options.level);
    resetDeckEffects(toIndex);
    resetDeckEffects(fromIndex);
    to.muted = graphReady() ? false : allMuted;
    to.src = url;
    to.load();
    to.playbackRate = rate;
    const cue = () => {
      if (generation !== mixGeneration) return;
      to.currentTime = startPosition;
    };
    if (to.readyState >= 1) cue();
    else to.addEventListener('loadedmetadata', cue, { once: true });
    const onDeckError = () => {
      if (generation !== mixGeneration) return;
      failMix(new Error('incoming deck failed to load'));
    };
    to.addEventListener('error', onDeckError, { once: true });

    mix = {
      phase: 'armed',
      fromIndex,
      toIndex,
      outCue,
      inCue,
      overlap,
      rate,
      preroll,
      mixStart: null,
      technique: plan.technique,
      phaseTolerance: Math.max(
        0.001,
        Math.min(0.012, Number(plan.sync?.phase_tolerance_ms || 5) / 1000),
      ),
      phaseCorrected: false,
      dominant: false,
      manual,
      callbacks,
    };
    callbacks.onArmed?.();
    stopTicker();
    // A manual skip should not wait a whole tick to become audible. Running it
    // before the ticker starts also means the first interval is picked from the
    // phase the skip left behind rather than from `armed`.
    if (manual) tick();
    if (mix) startTicker();
  },
};
