/**
 * Supplementary Auto Mode discovery pools built on the *catalog* capabilities
 * the rest of the app already exposes: the trending music feed
 * (`/api/discovery/music/feed`) and an artist's top tracks
 * (`/api/catalog/artist`).
 *
 * Unlike node/related candidates — whose ids are already YouTube video ids and
 * therefore stream directly through `/api/preview/stream` — catalog rows carry
 * Deezer/catalog metadata, not a playable identity. Each seed must be resolved
 * to a video id before it can be enqueued, so this module resolves a *bounded*
 * number of seeds (bounded concurrency, per-item cache) and drops the ones that
 * do not resolve. Resolutions are cached for the whole session and the source
 * feeds are cached with a short TTL, so steady-state cost is a handful of
 * requests per plan, not one per track on every refill.
 */
import { api } from './api';
import type { AutoCandidate } from './autopilot';
import type { CatalogItem, Track } from '../types/music';

interface Seed {
  artist: string;
  title: string;
  duration?: number;
  cover?: string;
  album?: string;
}

/** artist␟title → resolved video id (or null when unresolvable). Session-lived
 * so a track never gets resolved twice. */
const resolvedIds = new Map<string, string | null>();
const seedKey = (artist: string, title: string): string =>
  `${artist.trim().toLowerCase()}␟${title.trim().toLowerCase()}`;

async function resolveVideoId(seed: Seed, signal?: AbortSignal): Promise<string | null> {
  const key = seedKey(seed.artist, seed.title);
  const cached = resolvedIds.get(key);
  if (cached !== undefined) return cached;
  try {
    const res = await api.resolveCatalogItem(
      { artist: seed.artist, title: seed.title, duration: seed.duration },
      signal,
    );
    const id = res.video_id ?? null;
    resolvedIds.set(key, id);
    return id;
  } catch {
    // Transient failure — do not cache, so a later plan can retry.
    return null;
  }
}

/** Resolve up to `max` seeds into playable preview tracks with bounded
 * concurrency. Order of `seeds` is preserved as far as resolution allows. */
async function toPreviewTracks(seeds: Seed[], max: number, signal?: AbortSignal): Promise<Track[]> {
  const usable = seeds.filter((s) => s.artist && s.title);
  const out: Track[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < usable.length && out.length < max) {
      const seed = usable[cursor++];
      const id = await resolveVideoId(seed, signal);
      if (signal?.aborted) return;
      if (id && out.length < max) {
        out.push({
          id,
          title: seed.title,
          artist: seed.artist,
          album: seed.album,
          duration: seed.duration,
          cover: seed.cover,
          source: 'preview',
        });
      }
    }
  };
  const lanes = Math.min(3, usable.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  return out.slice(0, max);
}

/* ── Trending / charts pool ── */

const CHART_TTL_MS = 10 * 60_000;
let chartCache: { ts: number; seeds: Seed[] } | null = null;

/**
 * Trending tracks from the discovery music feed, tagged as `node` so they share
 * the node pool's quota. New every session; the source feed is cached for
 * {@link CHART_TTL_MS}.
 */
export async function chartCandidates(max = 6, signal?: AbortSignal): Promise<AutoCandidate[]> {
  let seeds: Seed[];
  if (chartCache && Date.now() - chartCache.ts < CHART_TTL_MS) {
    seeds = chartCache.seeds;
  } else {
    const feed = await api.getDiscoveryMusicFeed();
    seeds = (feed.items ?? [])
      .filter((it) => (it.media_type ?? 'track') === 'track')
      .map((it) => ({ artist: it.artist, title: it.title, duration: it.duration, cover: it.cover, album: it.album }))
      .filter((s) => s.artist && s.title);
    chartCache = { ts: Date.now(), seeds };
  }
  const tracks = await toPreviewTracks(seeds, max, signal);
  return tracks.map((track) => ({ track, source: 'node' as const, reasonKey: 'autoMode.reason.chart' }));
}

/* ── Artist top-tracks pool ── */

const ARTIST_TTL_MS = 30 * 60_000;
const artistCache = new Map<string, { ts: number; seeds: Seed[] }>();

/**
 * Top tracks of the current track's artist, tagged as `related` so they share
 * the related pool's quota ("more from what you're hearing"). Cached per artist
 * for {@link ARTIST_TTL_MS}.
 */
export async function artistCandidates(track: Track, max = 6, signal?: AbortSignal): Promise<AutoCandidate[]> {
  const artist = track.artist?.trim();
  if (!artist) return [];
  const cacheKey = artist.toLowerCase();
  let seeds: Seed[];
  const cached = artistCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ARTIST_TTL_MS) {
    seeds = cached.seeds;
  } else {
    let profile;
    try {
      profile = await api.getArtistProfile(artist, undefined, signal);
    } catch {
      return [];
    }
    seeds = (profile.top_tracks ?? [])
      .map((it: CatalogItem) => ({
        artist: it.artist ?? artist,
        title: it.title,
        duration: it.duration,
        cover: it.cover,
        album: it.album,
      }))
      .filter((s) => s.artist && s.title);
    artistCache.set(cacheKey, { ts: Date.now(), seeds });
  }
  const tracks = await toPreviewTracks(seeds, max, signal);
  return tracks.map((t) => ({
    track: t,
    source: 'related' as const,
    reasonKey: 'autoMode.reason.artist',
    reasonValues: { artist },
  }));
}
