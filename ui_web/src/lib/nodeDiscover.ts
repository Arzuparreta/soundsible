/**
 * Node-based discovery engine.
 *
 * The user's library is a graph of nodes; discovery walks outward from it.
 * Each refresh weighted-samples a handful of *seed* tracks from the library —
 * gradually preferring the most recently added, boosting favourites, and
 * rotating away from recently used seeds — then expands every seed through
 * the same recommendation source the radio mode uses (`related` mixes), and
 * interleaves the results round-robin into one feed. Anything already in the
 * library (or duplicated across seeds) is filtered out, so the feed is always
 * *new* music that branches off what the user actually collects.
 *
 * Performance contract:
 * - At most SEED_COUNT `related` calls per rebuild, run CONCURRENCY at a time.
 * - Per-seed results are cached for REL_TTL_MS (they change slowly), and
 *   library-track → video-id resolutions are cached forever — so a typical
 *   rebuild after the first session is mostly cache hits.
 * - The assembled feed is persisted and rehydrated for instant paint; it only
 *   rebuilds when stale (FEED_TTL_MS) or on explicit refresh.
 */
import { createSignal } from 'solid-js';
import { api } from './api';
import { state } from '../stores';
import { isPodcastTrack } from './track';
import { prefetchPreviews } from './prefetch';
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
const CONCURRENCY = 2;
/** Feed freshness: within this window, tab switches / navigations reuse the
 * assembled feed instead of re-rolling seeds. */
const FEED_TTL_MS = 30 * 60_000;
/** Related mixes move slowly; a day of reuse saves most upstream calls. */
const REL_TTL_MS = 24 * 3_600_000;
const REL_CACHE_MAX = 30;
/** Recency half-life, in tracks: the newest addition weighs 1, the ~25th
 * newest weighs 0.5, the ~50th 0.25 … a gradual preference, not a cutoff. */
const RECENCY_HALF_LIFE = 25;
const FAV_BOOST = 1.6;
/** Seeds used in recent rebuilds are damped so the feed rotates across the
 * library instead of orbiting the same few tracks. */
const RECENT_SEED_PENALTY = 0.25;
const RECENT_SEEDS_MAX = 12;

/* ── Storage ── */
const KEY = {
  feed: 'nodefeed:v1:feed',
  related: 'nodefeed:v1:related',
  resolve: 'nodefeed:v1:resolve',
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

/* ── Caches ── */

type RelatedCache = Record<string, { ts: number; results: SearchResult[] }>;

async function relatedCached(ytId: string): Promise<SearchResult[]> {
  const cache = readJson<RelatedCache>(KEY.related) ?? {};
  const hit = cache[ytId];
  if (hit && Date.now() - hit.ts < REL_TTL_MS && Array.isArray(hit.results)) return hit.results;
  const results = await api.relatedYouTube(ytId);
  cache[ytId] = { ts: Date.now(), results };
  // Prune oldest entries so the blob stays bounded.
  const ids = Object.keys(cache);
  if (ids.length > REL_CACHE_MAX) {
    ids
      .sort((a, b) => cache[a].ts - cache[b].ts)
      .slice(0, ids.length - REL_CACHE_MAX)
      .forEach((id) => delete cache[id]);
  }
  writeJson(KEY.related, cache);
  return results;
}

/** Library track → video id, cached forever (stable mapping). */
async function ytIdForSeed(track: Track): Promise<string | null> {
  if (track.youtube_id) return track.youtube_id;
  if (track.source === 'preview') return track.id;
  const map = readJson<Record<string, string>>(KEY.resolve) ?? {};
  if (map[track.id]) return map[track.id];
  if (!track.artist || !track.title) return null;
  try {
    const res = await api.resolveCatalogItem({ artist: track.artist, title: track.title, duration: track.duration });
    if (!res.video_id) return null;
    map[track.id] = res.video_id;
    writeJson(KEY.resolve, map);
    return res.video_id;
  } catch {
    return null;
  }
}

function readRecentSeeds(): string[] {
  const v = readJson<string[]>(KEY.seeds);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function pushRecentSeeds(ids: string[]): void {
  const next = [...ids, ...readRecentSeeds().filter((id) => !ids.includes(id))].slice(0, RECENT_SEEDS_MAX);
  writeJson(KEY.seeds, next);
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

let inFlight: Promise<void> | null = null;

async function rebuild(): Promise<void> {
  if (inFlight) return inFlight;
  const library = state.library.filter((t) => !isPodcastTrack(t));
  if (library.length === 0) {
    setNodeFeed([]);
    return;
  }
  setNodeLoading(true);
  inFlight = (async () => {
    const favs = new Set(state.favorites);
    const recentSeeds = readRecentSeeds();
    const total = library.length;
    // Library arrives oldest → newest; rank 0 = newest addition.
    const candidates = library.map((track, i) => ({
      track,
      recencyRank: total - 1 - i,
      fav: favs.has(track.id),
      recentlyUsed: recentSeeds.includes(track.id),
    }));
    const seeds = pickWeighted(candidates, SEED_COUNT);

    // Expand seeds with bounded concurrency; a failed seed is just skipped.
    const perSeed: SeedExpansion[] = [];
    const seedYts = new Set<string>();
    const queue = [...seeds];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          const s = queue.shift();
          if (!s) return;
          try {
            const yt = await ytIdForSeed(s.track);
            if (!yt) continue;
            seedYts.add(yt);
            const recs = await relatedCached(yt);
            perSeed.push({
              seed: { id: s.track.id, title: s.track.title, artist: s.track.artist },
              recs,
            });
          } catch {
            /* skip this seed */
          }
        }
      }),
    );

    const exclude = libraryExclude();
    for (const yt of seedYts) exclude.add(yt);
    const feed = interleave(perSeed, exclude, FEED_SIZE);
    if (feed.length > 0) {
      setNodeFeed(feed);
      writeJson(KEY.feed, { ts: Date.now(), items: feed });
      pushRecentSeeds(seeds.map((s) => s.track.id));
      // Warm the first rows so the eventual tap starts near-instantly.
      prefetchPreviews(feed.slice(0, 4).map((r) => r.id));
    }
  })().finally(() => {
    inFlight = null;
    setNodeLoading(false);
  });
  return inFlight;
}

/** Hydrate from cache and rebuild only if the feed is stale or empty. */
export function ensureNodeFeed(): void {
  hydrate();
  if (nodeFeed().length === 0 || !feedFresh()) void rebuild();
}

/** Explicit re-roll: new seeds, new feed (still coalesced while in flight). */
export function refreshNodeFeed(): void {
  hydrate();
  void rebuild();
}
