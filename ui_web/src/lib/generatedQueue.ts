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
export type AutoSource = 'local' | 'related' | 'discovery';
export type AutoPhase = 'idle' | 'following_queue' | 'planning' | 'ready' | 'degraded';

export interface AutoActivity {
  id: number;
  status: 'working' | 'done' | 'error';
  key: string;
  values?: Record<string, string | number>;
}

export interface AutoPlanItem {
  trackId: string;
  source: AutoSource;
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
  requestId?: string;
}

export interface AutoRequest {
  id: string;
  kind: 'track' | 'artist';
  label: string;
  track?: Track;
  artist?: { name: string };
  status: 'queued' | 'planned' | 'playing' | 'failed';
  etaTracks: number | null;
  scheduledPosition?: number | null;
  failureCode?: string | null;
}

export interface AutoModeState {
  active: boolean;
  profile: AutoProfile;
  djProfile: DjProfile;
  direction: DjDirection;
  requests: AutoRequest[];
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
  phase: AutoPhase;
  activity: AutoActivity | null;
  plan: Record<string, AutoPlanItem>;
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
}

const TARGET_LOOKAHEAD = 8;
const REFILL_THRESHOLD: Record<ListeningPlanIntent, number> = {
  autoplay: 3,
  radio: 4,
  auto_mode: 4,
};
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
    this.session = { intent, seed, profile, continuous: true };
    return this.sync(true);
  }

  ensureAutoplay(seed: Track, force = false): Promise<boolean> {
    if (this.session && this.session.intent !== 'autoplay') return Promise.resolve(false);
    if (!this.session) {
      this.session = { intent: 'autoplay', seed, profile: 'balanced', continuous: false };
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

  private scheduleRetry(): void {
    if (!this.session?.continuous || this.retryTimer) return;
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

  private exclusions(replace = false): string[] {
    const values = new Set(this.recent);
    const retained = this.retained(replace);
    for (const track of retained) {
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
    ).then((response) => {
      if (generation !== this.generation || aborter.signal.aborted || this.session !== session) return false;
      const accepted = this.deps.applyPlan(session.intent, response, replace, seed);
      if (accepted === 0) {
        this.deps.onStatus(session.intent, 'degraded', response, replace);
        this.scheduleRetry();
        return false;
      }
      for (const item of response.items) this.remember(item.recommendation_identity || item.id);
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
