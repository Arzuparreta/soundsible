/**
 * Node-based discovery engine — server-backed edition.
 *
 * The user's library is a graph of nodes; discovery walks outward from it.
 * Each refresh weighted-samples a handful of *seed* tracks from the library —
 * gradually preferring the most recently added, boosting favourites, and
 * rotating away from recently used seeds — then sends them to the server's
 * `/api/discover/feed` endpoint, which resolves each seed to a video id and
 * expands it through the same related-mix source the radio mode uses.
 *
 * The server returns cache-hit recs immediately and streams misses back via
 * the `discover_seed_ready` socket event. The client interleaves everything
 * round-robin into one feed, painting cache hits instantly and appending
 * streamed results as they arrive — so the feed is never a blank 90s wait.
 *
 * Performance contract:
 * - The client does zero yt-dlp calls. The server owns the persistent
 *   related-mix cache (SQLite, 7-day TTL) and seed resolution.
 * - The assembled feed is persisted in localStorage (short TTL) so tab
 *   switches and navigations repaint instantly without re-requesting.
 * - Pure logic (seedWeight / pickWeighted / interleave) is exported and
 *   unit-tested independently of the server.
 */
import { createSignal } from 'solid-js';
import { api } from './api';
import { state } from '../stores';
import { isPodcastTrack } from './track';
import { prefetchPreviews } from './prefetch';
import { setDiscoverSeedHandler } from './socket';
import type { SearchResult, Track } from '../types/music';

export interface NodeRec extends SearchResult {
  /** Library track this recommendation branched from. */
  seedId: string;
  seedTitle: string;
  seedArtist: string;
}

/* ── Tuning ── */
const SEED_COUNT = 6;
const FEED_SIZE = 30;
/** Feed freshness: within this window, tab switches / navigations reuse the
 * assembled feed instead of re-requesting. Short because the server cache is
 * the real source of truth — this just avoids redundant HTTP on tab flips. */
const FEED_TTL_MS = 5 * 60_000;
/** Recency half-life, in tracks: the newest addition weighs 1, the ~25th
 * newest weighs 0.5, the ~50th 0.25 … a gradual preference, not a cutoff. */
const RECENCY_HALF_LIFE = 25;
const FAV_BOOST = 1.6;
/** Seeds used in recent rebuilds are damped so the feed rotates across the
 * library instead of orbiting the same few tracks. */
const RECENT_SEED_PENALTY = 0.25;
const RECENT_SEEDS_MAX = 12;
/** Safety net: if the socket is disconnected and pending seeds never report,
 * finalize with what we have after this delay. */
const PENDING_TIMEOUT_MS = 30_000;

/* ── Storage ── */
const KEY = {
  feed: 'nodefeed:v1:feed',
  seeds: 'nodefeed:v1:recentSeeds',
} as const;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, data: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* storage full / disabled */
  }
}

/* ── Pure core (exported for tests) ── */

export interface SeedCandidate {
  /** 0 = newest library addition. */
  recencyRank: number;
  fav: boolean;
  recentlyUsed: boolean;
}

export function seedWeight(c: SeedCandidate): number {
  let w = Math.pow(0.5, c.recencyRank / RECENCY_HALF_LIFE);
  if (c.fav) w *= FAV_BOOST;
  if (c.recentlyUsed) w *= RECENT_SEED_PENALTY;
  return w;
}

/** Weighted sampling without replacement. `rand` is injectable for tests. */
export function pickWeighted<T extends SeedCandidate>(
  candidates: T[],
  count: number,
  rand: () => number = Math.random,
): T[] {
  const pool = [...candidates];
  const picked: T[] = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, c) => sum + seedWeight(c), 0);
    let r = rand() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= seedWeight(pool[i]);
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

export interface SeedExpansion {
  seed: { id: string; title: string; artist: string };
  recs: SearchResult[];
}

/** Round-robin across the seeds' recommendation lists: one from each seed per
 * round, skipping anything excluded (library, seeds) or already emitted. The
 * feed alternates flavours instead of dumping one seed's mix in a block. */
export function interleave(perSeed: SeedExpansion[], exclude: Set<string>, limit: number): NodeRec[] {
  const seen = new Set(exclude);
  const out: NodeRec[] = [];
  const cursors = perSeed.map(() => 0);
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (let s = 0; s < perSeed.length && out.length < limit; s++) {
      const { seed, recs } = perSeed[s];
      let i = cursors[s];
      while (i < recs.length && seen.has(recs[i].id)) i++;
      if (i >= recs.length) {
        cursors[s] = i;
        continue;
      }
      const rec = recs[i];
      cursors[s] = i + 1;
      seen.add(rec.id);
      out.push({ ...rec, seedId: seed.id, seedTitle: seed.title, seedArtist: seed.artist });
      progressed = true;
    }
  }
  return out;
}

/* ── Helpers ── */

function readRecentSeeds(): string[] {
  const v = readJson<string[]>(KEY.seeds);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function pushRecentSeeds(ids: string[]): void {
  const next = [...ids, ...readRecentSeeds().filter((id) => !ids.includes(id))].slice(0, RECENT_SEEDS_MAX);
  writeJson(KEY.seeds, next);
}

/** Ids the feed must never contain: the whole library, under both track and
 * video identity. */
function libraryExclude(): Set<string> {
  const exclude = new Set<string>();
  for (const t of state.library) {
    exclude.add(t.id);
    if (t.youtube_id) exclude.add(t.youtube_id);
  }
  return exclude;
}

/** Normalize a raw rec dict (from the socket or HTTP) into a SearchResult. */
function normalizeRec(r: Record<string, unknown>): SearchResult {
  return {
    id: String(r.id ?? r.video_id ?? r.videoId ?? ''),
    title: String(r.title ?? ''),
    channel: r.channel ? String(r.channel) : r.uploader ? String(r.uploader) : r.artist ? String(r.artist) : undefined,
    duration: typeof r.duration === 'number' ? r.duration : undefined,
    thumbnail: r.thumbnail ? String(r.thumbnail) : undefined,
  };
}

/* ── Feed state ── */

const [nodeFeed, setNodeFeed] = createSignal<NodeRec[]>([]);
const [nodeLoading, setNodeLoading] = createSignal(false);
export { nodeFeed, nodeLoading };

let hydrated = false;
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const cached = readJson<{ ts: number; items: NodeRec[] }>(KEY.feed);
  if (cached && Array.isArray(cached.items)) setNodeFeed(cached.items);
}

function feedFresh(): boolean {
  const cached = readJson<{ ts: number }>(KEY.feed);
  return !!cached && Date.now() - cached.ts < FEED_TTL_MS;
}

/** Per-rebuild state: the request_id, the seeds we picked, and which are still
 * pending. The socket handler closes over this. */
interface RebuildState {
  requestId: string;
  seeds: Array<{ id: string; title: string; artist: string }>;
  perSeed: SeedExpansion[];
  pending: Set<string>;
  aborter: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

let currentRebuild: RebuildState | null = null;
let inFlight: Promise<void> | null = null;

/** Re-interleave all accumulated expansions and update the feed. */
function paint(rs: RebuildState): void {
  const exclude = libraryExclude();
  for (const s of rs.seeds) exclude.add(s.id);
  const feed = interleave(rs.perSeed, exclude, FEED_SIZE);
  if (feed.length > 0) {
    setNodeFeed(feed);
    writeJson(KEY.feed, { ts: Date.now(), items: feed });
  }
}

/** Finalize a rebuild: clear the socket handler, cancel the safety timer, mark
 * done, and stop loading. */
function finalize(rs: RebuildState): void {
  if (rs.done) return;
  rs.done = true;
  if (rs.timer) clearTimeout(rs.timer);
  if (currentRebuild === rs) currentRebuild = null;
  setDiscoverSeedHandler(null);
  if (rs === currentRebuild || currentRebuild === null) setNodeLoading(false);
  // Warm the first rows so the eventual tap starts near-instantly.
  prefetchPreviews(nodeFeed().slice(0, 4).map((r) => r.id));
}

function startRebuild(): Promise<void> {
  const library = state.library.filter((t) => !isPodcastTrack(t));
  if (library.length === 0) {
    setNodeFeed([]);
    return Promise.resolve();
  }

  // Cancel any in-flight rebuild.
  if (currentRebuild) {
    currentRebuild.aborter.abort();
    if (currentRebuild.timer) clearTimeout(currentRebuild.timer);
    currentRebuild.done = true;
  }

  setNodeLoading(true);
  const aborter = new AbortController();

  const favs = new Set(state.favorites);
  const recentSeeds = readRecentSeeds();
  const total = library.length;
  const candidates = library.map((track, i) => ({
    track,
    recencyRank: total - 1 - i,
    fav: favs.has(track.id),
    recentlyUsed: recentSeeds.includes(track.id),
  }));
  const seeds = pickWeighted(candidates, SEED_COUNT);
  const seedMeta = seeds.map((s) => ({
    id: s.track.id,
    title: s.track.title,
    artist: s.track.artist,
  }));

  const rs: RebuildState = {
    requestId: '',
    seeds: seedMeta,
    perSeed: [],
    pending: new Set<string>(),
    aborter,
    timer: null,
    done: false,
  };
  currentRebuild = rs;

  return (async () => {
    const res = await api.discoverFeed(
      seedMeta.map((s) => s.id),
      25,
      aborter.signal,
    );
    if (rs.done || aborter.signal.aborted) return;

    rs.requestId = res.request_id;

    // Seed info map for looking up by track id.
    const seedById = new Map(seedMeta.map((s) => [s.id, s]));

    // Populate cache-hit expansions.
    for (const r of res.ready) {
      const seed = seedById.get(r.seed_track_id);
      if (!seed) continue;
      rs.perSeed.push({ seed, recs: r.recs });
    }

    // Track pending seeds.
    for (const pid of res.pending) {
      const seed = seedById.get(pid);
      if (seed) {
        rs.pending.add(pid);
        // Ensure the seed has an expansion slot (empty until streamed).
        if (!rs.perSeed.some((e) => e.seed.id === pid)) {
          rs.perSeed.push({ seed, recs: [] });
        }
      }
    }

    // Paint what we have now (cache hits).
    paint(rs);
    pushRecentSeeds(seedMeta.map((s) => s.id));

    if (rs.pending.size === 0) {
      finalize(rs);
      return;
    }

    // Register the socket handler for streamed seeds.
    setDiscoverSeedHandler((data) => {
      if (rs.done || data.request_id !== rs.requestId) return;
      const seed = seedById.get(data.seed_track_id);
      if (!seed || !rs.pending.has(data.seed_track_id)) return;

      // Fill the expansion slot.
      const slot = rs.perSeed.find((e) => e.seed.id === data.seed_track_id);
      if (slot) {
        slot.recs = (data.recs ?? [])
          .map((r) => normalizeRec(r as Record<string, unknown>))
          .filter((r) => r.id);
      }
      rs.pending.delete(data.seed_track_id);
      paint(rs);

      if (rs.pending.size === 0) finalize(rs);
    });

    // Safety net: if the socket is down or seeds never report, finalize.
    rs.timer = setTimeout(() => finalize(rs), PENDING_TIMEOUT_MS);
  })().catch((e: unknown) => {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    /* On any error, finalize with whatever we have (possibly empty). */
    finalize(rs);
  });
}

/** Hydrate from cache and rebuild only if the feed is stale or empty. */
export function ensureNodeFeed(): void {
  hydrate();
  if (nodeFeed().length === 0 || !feedFresh()) {
    inFlight = startRebuild().finally(() => { inFlight = null; });
  }
}

/** Explicit re-roll: new seeds, new feed (still coalesced while in flight). */
export function refreshNodeFeed(): void {
  hydrate();
  inFlight = startRebuild().finally(() => { inFlight = null; });
}
