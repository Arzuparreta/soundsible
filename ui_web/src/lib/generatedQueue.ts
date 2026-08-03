import type {
  DjDirection,
  DjProfile,
  DjTransitionPlan,
  ListeningPlanIntent,
  ListeningPlanProfile,
  ListeningPlanResponse,
} from './api';
import type { PlaybackQueueEntry } from './playbackQueue';
import type { Track } from '../types/music';

export type AutoProfile = ListeningPlanProfile;
export type AutoPool = 'local' | 'related' | 'discovery';
export interface AutoMusicSet {
  id: string;
  label: string;
  tracks: Track[];
  /** Monotonic order used to favour recent direction changes without erasing
   * older sources. */
  activation: number;
}

export type AutoPhase = 'idle' | 'following_queue' | 'planning' | 'ready' | 'degraded';

export interface AutoActivity {
  id: number;
  status: 'working' | 'done' | 'error';
  key: string;
  values?: Record<string, string | number>;
}

export interface AutoPlanItem {
  trackId: string;
  source: AutoPool;
  reasonKey: string;
  reasonValues?: Record<string, string | number>;
  /**
   * Identity of the track this entry's transition was planned *out of*.
   *
   * A route's cues are chained, and `out_cue` is a position in the outgoing
   * track's timeline. Without this the player has no way to tell whether a cue
   * belongs to the song that is actually playing — which is how a transition
   * planned for a five-minute track ended up cutting a two-minute one in half.
   */
  fromKey: string;
  transition?: DjTransitionPlan;
  bpm?: number;
  key?: string | null;
  sourceSetId?: string;
  sourceSetLabel?: string;
  lineage?: string[];
}

export interface AutoModeState {
  active: boolean;
  profile: AutoProfile;
  djProfile: DjProfile;
  direction: DjDirection;
  sources: AutoMusicSet[];
  heard: Track[];
  avoidedIdentities: string[];
  transition: {
    /** `armed`: the next track is loaded, cued and no longer replannable.
     * `mixing`: the incoming deck already owns playback. */
    status: 'idle' | 'armed' | 'mixing';
    technique?: DjTransitionPlan['technique'];
    nextTrackId?: string;
    /** Position in the playing track at which the blend begins, so the booth can
     * count down to a mix the listener can already see coming. */
    at?: number;
  };
  /** A direction change is waiting out its debounce before the runway is
   * rewritten. The UI uses it to promise "from the next track". */
  pendingDirection: boolean;
  /** A route repair is in flight. Reactive rather than a module flag because
   * the button that starts one has to disable itself while it runs. */
  repairing: boolean;
  phase: AutoPhase;
  activity: AutoActivity | null;
  plan: Record<string, AutoPlanItem>;
  /**
   * Occurrences whose incoming transition is no longer the one that was planned.
   *
   * Reordering the route opens joins the DJ never chose, and re-seaming them
   * costs a round trip nobody asked for mid-drag. Naming them instead lets the
   * route show where the mix is waiting on a repair, rather than leaving a
   * plain fade to be discovered when it fires.
   */
  staleSeams: string[];
}

export interface GeneratedSnapshot {
  currentTrack: Track | null;
  queue: PlaybackQueueEntry[];
  index: number;
}

export interface GeneratedQueueDeps {
  snapshot: () => GeneratedSnapshot;
  requestPlan: (
    intent: ListeningPlanIntent,
    profile: AutoProfile,
    seed: Track,
    limit: number,
    exclude: string[],
    signal: AbortSignal,
    session?: {
      id: string;
      segmentIndex: number;
      context: Track[];
    },
  ) => Promise<ListeningPlanResponse>;
  applyPlan: (
    intent: ListeningPlanIntent,
    response: ListeningPlanResponse,
    replace: boolean,
    /** The track the returned route continues from. Auto Mode chains its
     * transitions from this one, so the caller needs to know it. */
    anchor: Track,
  ) => number;
  onStatus: (
    intent: ListeningPlanIntent,
    status: 'planning' | 'ready' | 'degraded' | 'idle',
    response?: ListeningPlanResponse,
    replacing?: boolean,
  ) => void;
  identity: (track: Track) => string;
  /** True for the one queue entry whose handoff is already loaded and cued. A
   * replan may rewrite everything after it, never it. */
  isCommitted?: (entry: PlaybackQueueEntry) => boolean;
}

interface GeneratedSession {
  intent: ListeningPlanIntent;
  profile: AutoProfile;
  seed: Track;
  continuous: boolean;
  id?: string;
  segmentIndex: number;
}

const TARGET_LOOKAHEAD = 8;
/**
 * How thin the generated lane may get before it is refilled.
 *
 * Sized for a bad connection rather than a good one: on a drive, the refill that
 * matters is the one that had time to fail, back off and succeed before the
 * listener reaches the end of the lane. Three tracks of warning was enough on
 * Wi-Fi and not enough on a phone changing cells.
 */
const REFILL_THRESHOLD: Record<ListeningPlanIntent, number> = {
  autoplay: 5,
  radio: 5,
  auto_mode: 5,
};

function sessionId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (!cryptoApi?.getRandomValues) {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  cryptoApi.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
const RETRY_DELAYS = [15_000, 30_000, 60_000];
const RECENT_MAX = 80;

/** One lifecycle owner for every generated queue.
 *
 * The server owns candidate assembly and final ordering. This controller owns
 * only session-local concerns: cancellation, stale-result protection, refill,
 * retry, and atomic replacement after an Auto Mode profile change.
 */
export class GeneratedQueueController {
  private session: GeneratedSession | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private aborter: AbortController | null = null;
  private inFlight: Promise<boolean> | null = null;
  private generation = 0;
  private retryStep = 0;
  private recent: string[] = [];

  constructor(private readonly deps: GeneratedQueueDeps) {}

  activeIntent(): ListeningPlanIntent | null {
    return this.session?.intent ?? null;
  }

  start(
    intent: Exclude<ListeningPlanIntent, 'autoplay'>,
    seed: Track,
    profile: AutoProfile = 'balanced',
  ): Promise<boolean> {
    this.stop();
    this.session = {
      intent,
      seed,
      profile,
      continuous: true,
      id: intent === 'auto_mode' ? sessionId() : undefined,
      segmentIndex: 0,
    };
    return this.sync(true);
  }

  ensureAutoplay(seed: Track, force = false): Promise<boolean> {
    if (this.session && this.session.intent !== 'autoplay') return Promise.resolve(false);
    if (!this.session) {
      this.session = {
        intent: 'autoplay',
        seed,
        profile: 'balanced',
        continuous: false,
        segmentIndex: 0,
      };
    } else {
      this.session.seed = seed;
    }
    return this.sync(force);
  }

  stop(intent?: ListeningPlanIntent): void {
    if (intent && this.session?.intent !== intent) return;
    const stoppedIntent = this.session?.intent;
    this.generation += 1;
    this.aborter?.abort();
    this.aborter = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.inFlight = null;
    this.retryStep = 0;
    this.recent = [];
    this.session = null;
    if (stoppedIntent) this.deps.onStatus(stoppedIntent, 'idle');
  }

  /** Rewrite the uncommitted runway — everything the listener has not started
   * hearing yet — after a direction, DJ or request change. */
  replan(profile: AutoProfile): Promise<boolean> {
    if (this.session?.intent !== 'auto_mode') return Promise.resolve(false);
    this.session.profile = profile;
    this.aborter?.abort();
    this.inFlight = null;
    return this.sync(true, true);
  }

  rememberCurrent(): void {
    const current = this.deps.snapshot().currentTrack;
    if (!current) return;
    this.remember(this.deps.identity(current));
  }

  async refillNow(): Promise<boolean> {
    this.rememberCurrent();
    return this.sync(true);
  }

  ensureRunway(): Promise<boolean> {
    return this.sync();
  }

  private remember(identity: string): void {
    if (!identity) return;
    this.recent = [identity, ...this.recent.filter((value) => value !== identity)].slice(0, RECENT_MAX);
  }

  /**
   * Try again after a failed plan.
   *
   * Runs for every intent, including Autoplay. It used to be limited to
   * `continuous` sessions, which meant a single failed request — one tunnel, one
   * cell handover — left the invisible lane empty for good, and the music simply
   * ended when the queue ran out. Autoplay is no less continuous to the listener
   * than Radio is; it just does not say so on screen.
   */
  private scheduleRetry(): void {
    if (!this.session || this.retryTimer) return;
    const delay = RETRY_DELAYS[Math.min(this.retryStep, RETRY_DELAYS.length - 1)];
    this.retryStep += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.sync(true);
    }, delay);
  }

  private generatedRemaining(intent: ListeningPlanIntent): number {
    const snapshot = this.deps.snapshot();
    return snapshot.queue
      .slice(Math.max(0, snapshot.index + 1))
      .filter((entry) => entry.queueLane === 'generated' && entry.queueSource === intent)
      .length;
  }

  /** The queue as it will look once this plan is applied: what a replace keeps,
   * or everything when the plan is appended. */
  private retained(replace: boolean): PlaybackQueueEntry[] {
    const snapshot = this.deps.snapshot();
    if (!replace) return snapshot.queue;
    return snapshot.queue.filter(
      (entry, index) =>
        index <= snapshot.index
        || entry.queueLane === 'manual'
        || this.deps.isCommitted?.(entry) === true,
    );
  }

  /**
   * The track the next plan continues from.
   *
   * It is the *tail* of what survives, not the track that is playing: a route's
   * transitions are chained, so a plan seeded anywhere else produces cues that
   * belong to a song nobody will be listening to when they are reached.
   */
  private anchor(replace: boolean): Track {
    const snapshot = this.deps.snapshot();
    return this.retained(replace).at(-1) ?? snapshot.currentTrack ?? this.session!.seed;
  }

  private context(replace: boolean): Track[] {
    return this.retained(replace).slice(-5);
  }

  private exclusions(replace = false): string[] {
    const values = new Set(this.recent);
    const retained = this.retained(replace);
    const routeAnchors = replace
      ? this.deps.snapshot().queue.filter((entry) => entry.autoRoute?.kind === 'user')
      : [];
    for (const track of [...retained, ...routeAnchors]) {
      const identity = this.deps.identity(track);
      if (identity) values.add(identity);
      if (track.recommendation?.identity) values.add(track.recommendation.identity);
      if (track.youtube_id) values.add(track.youtube_id);
      if (track.id) values.add(track.id);
    }
    return [...values];
  }

  private sync(force = false, replace = false): Promise<boolean> {
    const session = this.session;
    if (!session) return Promise.resolve(false);
    if (this.inFlight) return this.inFlight;
    const remaining = this.generatedRemaining(session.intent);
    if (!force && remaining >= REFILL_THRESHOLD[session.intent]) {
      if (session.intent === 'auto_mode') {
        this.deps.onStatus(session.intent, 'ready');
      }
      return Promise.resolve(true);
    }
    const needed = replace ? TARGET_LOOKAHEAD : Math.max(0, TARGET_LOOKAHEAD - remaining);
    if (needed === 0) return Promise.resolve(true);

    const generation = ++this.generation;
    this.aborter?.abort();
    const aborter = new AbortController();
    this.aborter = aborter;
    this.deps.onStatus(session.intent, 'planning', undefined, replace);
    // Auto Mode continues the route from wherever it currently ends. Radio
    // remains anchored to the song the listener explicitly chose, so a manual
    // request inserted ahead of its generated lane cannot silently retune the
    // station. Autoplay's caller advances `session.seed` to the tail it is
    // extending.
    const seed = session.intent === 'auto_mode' ? this.anchor(replace) : session.seed;
    const task = this.deps.requestPlan(
      session.intent,
      session.profile,
      seed,
      needed,
      this.exclusions(replace),
      aborter.signal,
      session.intent === 'auto_mode' && session.id
        ? {
            id: session.id,
            segmentIndex: session.segmentIndex,
            context: this.context(replace),
          }
        : undefined,
    ).then((response) => {
      if (generation !== this.generation || aborter.signal.aborted || this.session !== session) return false;
      const accepted = this.deps.applyPlan(session.intent, response, replace, seed);
      if (accepted === 0) {
        this.deps.onStatus(session.intent, 'degraded', response, replace);
        this.scheduleRetry();
        return false;
      }
      for (const item of response.items) this.remember(item.recommendation_identity || item.id);
      if (session.intent === 'auto_mode') session.segmentIndex += 1;
      this.retryStep = 0;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      // `degraded` means one or more source pools were unavailable. If the
      // planner still produced playable tracks, the listener has a healthy
      // runway and should not see a false retry/error state.
      this.deps.onStatus(session.intent, 'ready', response, replace);
      return true;
    }).catch(() => {
      if (generation !== this.generation || aborter.signal.aborted || this.session !== session) return false;
      this.deps.onStatus(session.intent, 'degraded', undefined, replace);
      this.scheduleRetry();
      return false;
    }).finally(() => {
      if (generation === this.generation) {
        this.aborter = null;
        this.inFlight = null;
      }
    });
    this.inFlight = task;
    return task;
  }
}
