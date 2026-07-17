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
  removeGeneratedFuture: (ids: Set<string>) => void;
  getRelated: (track: Track, signal: AbortSignal) => Promise<Track[]>;
  getNodeCandidates: () => Promise<AutoCandidate[]>;
}

const TARGET_LOOKAHEAD = 8;
const REFILL_THRESHOLD = 4;
const RECENT_MAX = 60;
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

/** Select a mixed batch with canonical deduplication and a per-artist cap. */
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
  let cursor = 0;
  let misses = 0;

  while (selected.length < limit && misses < sequence.length * 3) {
    const preferred = sequence[cursor % sequence.length];
    cursor += 1;
    const order: AutoSource[] = [preferred, ...(['local', 'related', 'node'] as AutoSource[]).filter((x) => x !== preferred)];
    let picked: AutoCandidate | null = null;
    for (const source of order) {
      while (queues[source].length > 0) {
        const candidate = queues[source].shift()!;
        const id = queueIdentity(candidate.track);
        const artist = candidate.track.artist.trim().toLocaleLowerCase();
        if (seen.has(id) || (artist && (artistCounts.get(artist) ?? 0) >= 2)) continue;
        picked = candidate;
        seen.add(id);
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
    this.generated.clear();
    this.deps.patchState({ active: false, phase: 'idle' });
  }

  setProfile(profile: AutoProfile): void {
    this.profile = profile;
    this.deps.patchState({ profile });
    if (!this.active) return;
    this.aborter?.abort();
    this.deps.removeGeneratedFuture(new Set(this.generated));
    this.generated.clear();
    this.deps.patchState({ plan: {} });
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

  async sync(_force = false): Promise<void> {
    if (!this.active || this.refillInFlight) return;
    const snapshot = this.deps.snapshot();
    if (!snapshot.currentTrack) return;
    const remaining = Math.max(0, snapshot.queue.length - snapshot.index - 1);
    if (remaining >= REFILL_THRESHOLD) {
      this.deps.patchState({ phase: 'following_queue' });
      return;
    }
    const needed = Math.max(0, TARGET_LOOKAHEAD - remaining);
    if (needed === 0) return;

    this.refillInFlight = true;
    this.aborter?.abort();
    const aborter = new AbortController();
    this.aborter = aborter;
    this.deps.patchState({ phase: 'planning' });
    this.report('working', 'autoMode.agent.searching', { title: snapshot.currentTrack.title });

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
          }, 5000);
        }),
      ])
        .then((tracks) => tracks.map((track): AutoCandidate => ({
          track,
          source: 'related',
          reasonKey: 'autoMode.reason.related',
          reasonValues: { title: snapshot.currentTrack!.title },
        })))
        .catch(() => []);
      const [node, related] = await Promise.all([nodePromise, relatedPromise]);
      if (relatedDeadline) clearTimeout(relatedDeadline);
      aborter.signal.removeEventListener('abort', abortRelated);
      if (!this.active || aborter.signal.aborted) return;
      const excluded = new Set<string>([
        ...snapshot.queue.map(queueIdentity),
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
      const appended = this.deps.append(selected);
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
      this.report('done', 'autoMode.agent.queued', {
        count: appended.length,
        tracks: appended.slice(0, 2).map(({ track }) => track.title).join(' · '),
        related: related.length,
        node: node.length,
        local: local.length,
      });
    } finally {
      if (this.aborter === aborter) {
        this.aborter = null;
        this.refillInFlight = false;
      }
    }
  }
}
