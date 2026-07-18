import { queueIdentity } from './queueDiscovery';
import type { Track } from '../types/music';

export type AutoProfile = 'familiar' | 'balanced' | 'explore';
export type AutoSource = 'local' | 'related' | 'node';
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
}

export interface AutoModeState {
  active: boolean;
  profile: AutoProfile;
  phase: AutoPhase;
  activity: AutoActivity | null;
  plan: Record<string, AutoPlanItem>;
}

export interface AutoCandidate {
  track: Track;
  source: AutoSource;
  reasonKey: string;
  reasonValues?: Record<string, string | number>;
}

export interface AutoSnapshot {
  currentTrack: Track | null;
  queue: Track[];
  index: number;
  library: Track[];
  favorites: string[];
}

export interface AutopilotDeps {
  snapshot: () => AutoSnapshot;
  patchState: (patch: Partial<AutoModeState>) => void;
  append: (candidates: AutoCandidate[]) => AutoCandidate[];
  /** Replace everything after the current track with `candidates`, in one commit.
   * Used when the listener changes profile: the very next track must already
   * reflect the new mix, so the whole upcoming tail is swapped atomically — the
   * current track keeps playing, no empty-queue gap opens. Returns the accepted
   * candidates (dedup against the retained prefix). */
  replaceUpcoming: (candidates: AutoCandidate[]) => AutoCandidate[];
  getRelated: (track: Track, signal: AbortSignal) => Promise<Track[]>;
  getNodeCandidates: () => Promise<AutoCandidate[]>;
  /** Trending/charts candidates, tagged `node`. Optional supplementary pool. */
  getChartCandidates?: (signal: AbortSignal) => Promise<AutoCandidate[]>;
  /** Current artist's top tracks, tagged `related`. Optional supplementary pool. */
  getArtistCandidates?: (track: Track, signal: AbortSignal) => Promise<AutoCandidate[]>;
}

const TARGET_LOOKAHEAD = 8;
const REFILL_THRESHOLD = 4;
const RECENT_MAX = 60;
/** Related resolution can chain catalog-resolve → YouTube-search → related-mix.
 * The old 5s ceiling routinely timed out on a library seed with no YouTube
 * identity, leaving the related pool empty and the batch all-local. */
const RELATED_DEADLINE_MS = 12_000;
/** Ceiling for each supplementary catalog pool so a slow batch of
 * catalog-resolve calls can't hold a plan open. The underlying fetch keeps
 * running to warm the resolution cache for the next refill. */
const SUPPLEMENTARY_DEADLINE_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    handle = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([
    promise.then((value) => value, () => fallback).finally(() => clearTimeout(handle)),
    timeout,
  ]);
}
const SOURCE_SEQUENCE: Record<AutoProfile, AutoSource[]> = {
  familiar: ['local', 'local', 'local', 'local', 'related', 'related', 'related', 'node'],
  balanced: ['local', 'local', 'related', 'related', 'related', 'node', 'node', 'node'],
  explore: ['local', 'related', 'related', 'related', 'node', 'node', 'node', 'node'],
};

function shuffled<T>(values: T[], rand: () => number): T[] {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function buildLocalCandidates(
  library: Track[],
  favorites: string[],
  rand: () => number = Math.random,
): AutoCandidate[] {
  const favs = new Set(favorites);
  const favouriteTracks = shuffled(library.filter((track) => favs.has(track.id)), rand);
  const otherTracks = shuffled(library.filter((track) => !favs.has(track.id)), rand);
  return [...favouriteTracks, ...otherTracks].map((track) => ({
    track,
    source: 'local' as const,
    reasonKey: favs.has(track.id) ? 'autoMode.reason.favorite' : 'autoMode.reason.library',
  }));
}

/** Select a mixed batch with canonical deduplication and a per-artist cap.
 *
 * When real discovery candidates exist (related/node non-empty), the number of
 * `local` tracks is capped to the profile's local share so an unlucky source
 * mix can't quietly refill the whole batch from the listener's library — that
 * is what made every profile look identical and library-only. When there are no
 * external candidates at all (e.g. offline), the cap is lifted so playback
 * degrades gracefully to the library instead of stalling. */
export function selectAutoBatch(
  pools: Record<AutoSource, AutoCandidate[]>,
  profile: AutoProfile,
  limit: number,
  excluded: Set<string>,
): AutoCandidate[] {
  const queues: Record<AutoSource, AutoCandidate[]> = {
    local: pools.local.slice(),
    related: pools.related.slice(),
    node: pools.node.slice(),
  };
  const seen = new Set(excluded);
  const artistCounts = new Map<string, number>();
  const selected: AutoCandidate[] = [];
  const sequence = SOURCE_SEQUENCE[profile];
  const externalAvailable = pools.related.length + pools.node.length > 0;
  const localShare = sequence.filter((s) => s === 'local').length;
  const localCap = externalAvailable ? Math.ceil((limit * localShare) / sequence.length) : limit;
  let localUsed = 0;
  let cursor = 0;
  let misses = 0;

  while (selected.length < limit && misses < sequence.length * 3) {
    const preferred = sequence[cursor % sequence.length];
    cursor += 1;
    const canLocal = localUsed < localCap;
    const order = ([preferred, ...(['local', 'related', 'node'] as AutoSource[]).filter((x) => x !== preferred)])
      .filter((source) => source !== 'local' || canLocal);
    let picked: AutoCandidate | null = null;
    for (const source of order) {
      while (queues[source].length > 0) {
        const candidate = queues[source].shift()!;
        const id = queueIdentity(candidate.track);
        const artist = candidate.track.artist.trim().toLocaleLowerCase();
        if (seen.has(id) || (artist && (artistCounts.get(artist) ?? 0) >= 2)) continue;
        picked = candidate;
        seen.add(id);
        if (candidate.source === 'local') localUsed += 1;
        if (artist) artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
        break;
      }
      if (picked) break;
    }
    if (!picked) {
      misses += 1;
      continue;
    }
    misses = 0;
    selected.push(picked);
  }
  return selected;
}

export class AutopilotController {
  private active = false;
  private profile: AutoProfile;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private aborter: AbortController | null = null;
  private refillInFlight = false;
  private replanPending = false;
  private generated = new Set<string>();
  private recent: string[] = [];
  private activityId = 0;
  private retryStep = 0;

  constructor(private readonly deps: AutopilotDeps, initialProfile: AutoProfile) {
    this.profile = initialProfile;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.generated.clear();
    this.recent = [];
    this.retryStep = 0;
    this.deps.patchState({ active: true, profile: this.profile, phase: 'planning', activity: null, plan: {} });
    void this.sync(true);
    this.timer = setInterval(() => void this.sync(), 1000);
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
    this.aborter?.abort();
    this.aborter = null;
    this.refillInFlight = false;
    this.replanPending = false;
    this.generated.clear();
    this.deps.patchState({ active: false, phase: 'idle' });
  }

  setProfile(profile: AutoProfile): void {
    this.profile = profile;
    this.deps.patchState({ profile });
    if (!this.active) return;
    // Re-steer immediately: abort any in-flight refill, release the lock, and
    // request a replan that *replaces* the upcoming tail — so the very next
    // track already reflects the new mix while the current track keeps playing.
    this.replanPending = true;
    this.aborter?.abort();
    this.aborter = null;
    this.refillInFlight = false;
    void this.sync(true);
  }

  skipCurrent(): Promise<void> {
    const current = this.deps.snapshot().currentTrack;
    if (current) this.remember(queueIdentity(current));
    return this.sync(true);
  }

  private report(
    status: AutoActivity['status'],
    key: string,
    values?: Record<string, string | number>,
  ): void {
    this.deps.patchState({ activity: { id: ++this.activityId, status, key, values } });
  }

  private remember(id: string): void {
    this.recent = [id, ...this.recent.filter((value) => value !== id)].slice(0, RECENT_MAX);
  }

  private scheduleRetry(): void {
    if (!this.active || this.retryTimer) return;
    const delays = [15_000, 30_000, 60_000];
    const delay = delays[Math.min(this.retryStep, delays.length - 1)];
    this.retryStep += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.sync(true);
    }, delay);
  }

  async sync(force = false): Promise<void> {
    if (!this.active || this.refillInFlight) return;
    const snapshot = this.deps.snapshot();
    if (!snapshot.currentTrack) return;
    const remaining = Math.max(0, snapshot.queue.length - snapshot.index - 1);
    const replace = this.replanPending;
    if (!force && !replace && remaining >= REFILL_THRESHOLD) {
      this.deps.patchState({ phase: 'following_queue' });
      return;
    }
    // A profile switch rebuilds the whole tail so the next track flips too; a
    // normal refill only tops the lookahead back up to target.
    const needed = replace ? TARGET_LOOKAHEAD : Math.max(0, TARGET_LOOKAHEAD - remaining);
    if (needed === 0) return;
    this.replanPending = false;

    this.refillInFlight = true;
    this.aborter?.abort();
    const aborter = new AbortController();
    this.aborter = aborter;
    this.deps.patchState({ phase: 'planning' });
    if (replace) {
      this.report('working', 'autoMode.agent.recalibrating', { profile: `autoMode.profile.${this.profile}` });
    } else {
      this.report('working', 'autoMode.agent.searching', { title: snapshot.currentTrack.title });
    }

    try {
      const local = buildLocalCandidates(snapshot.library, snapshot.favorites);
      const nodePromise = this.deps.getNodeCandidates().catch(() => []);
      const relatedAborter = new AbortController();
      const abortRelated = () => relatedAborter.abort();
      aborter.signal.addEventListener('abort', abortRelated, { once: true });
      let relatedDeadline: ReturnType<typeof setTimeout> | null = null;
      const relatedPromise = Promise.race([
        this.deps.getRelated(snapshot.currentTrack, relatedAborter.signal),
        new Promise<Track[]>((resolve) => {
          relatedDeadline = setTimeout(() => {
            relatedAborter.abort();
            resolve([]);
          }, RELATED_DEADLINE_MS);
        }),
      ])
        .then((tracks) => tracks.map((track): AutoCandidate => ({
          track,
          source: 'related',
          reasonKey: 'autoMode.reason.related',
          reasonValues: { title: snapshot.currentTrack!.title },
        })))
        .catch(() => []);
      const chartPromise = this.deps.getChartCandidates
        ? withTimeout(this.deps.getChartCandidates(aborter.signal), SUPPLEMENTARY_DEADLINE_MS, [])
        : Promise.resolve<AutoCandidate[]>([]);
      const artistPromise = this.deps.getArtistCandidates
        ? withTimeout(this.deps.getArtistCandidates(snapshot.currentTrack, aborter.signal), SUPPLEMENTARY_DEADLINE_MS, [])
        : Promise.resolve<AutoCandidate[]>([]);
      const [nodeBase, relatedBase, chart, artist] = await Promise.all([
        nodePromise,
        relatedPromise,
        chartPromise,
        artistPromise,
      ]);
      if (relatedDeadline) clearTimeout(relatedDeadline);
      aborter.signal.removeEventListener('abort', abortRelated);
      if (!this.active || aborter.signal.aborted) return;
      // Charts share the node quota (broad discovery); artist top-tracks share
      // the related quota (more of what's playing).
      const node = [...nodeBase, ...chart];
      const related = [...relatedBase, ...artist];
      // On a replan the discarded tail is fair game again — exclude only the
      // retained prefix (current track and anything before it) plus recents.
      const kept = replace ? snapshot.queue.slice(0, snapshot.index + 1) : snapshot.queue;
      const excluded = new Set<string>([
        ...kept.map(queueIdentity),
        ...this.recent,
      ]);
      const selected = selectAutoBatch({ local, related, node }, this.profile, needed, excluded);
      if (selected.length === 0) {
        this.deps.patchState({ phase: 'degraded' });
        this.report('error', 'autoMode.agent.retrying', {
          related: related.length,
          node: node.length,
          local: local.length,
        });
        this.scheduleRetry();
        return;
      }
      this.retryStep = 0;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      let appended: AutoCandidate[];
      if (replace) {
        this.generated.clear();
        appended = this.deps.replaceUpcoming(selected);
      } else {
        appended = this.deps.append(selected);
      }
      for (const candidate of appended) {
        const id = queueIdentity(candidate.track);
        this.generated.add(id);
        this.remember(id);
      }
      if (appended.length === 0) {
        this.deps.patchState({ phase: 'degraded' });
        this.report('error', 'autoMode.agent.retrying', {
          related: related.length,
          node: node.length,
          local: local.length,
        });
        this.scheduleRetry();
        return;
      }
      this.deps.patchState({ phase: 'ready' });
      if (replace) {
        this.report('done', 'autoMode.agent.steered', {
          profile: `autoMode.profile.${this.profile}`,
          count: appended.length,
          related: related.length,
          node: node.length,
          local: local.length,
        });
      } else {
        this.report('done', 'autoMode.agent.queued', {
          count: appended.length,
          tracks: appended.slice(0, 2).map(({ track }) => track.title).join(' · '),
          related: related.length,
          node: node.length,
          local: local.length,
        });
      }
    } finally {
      if (this.aborter === aborter) {
        this.aborter = null;
        this.refillInFlight = false;
      }
    }
  }
}
