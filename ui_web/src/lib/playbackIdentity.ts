import type { CatalogItem, SearchResult, Track } from '../types/music';
import { isPodcastTrack } from './track';

/**
 * Identity keys — the one answer to "is this row the thing that is playing?".
 *
 * A song changes id every time it crosses a boundary: a Deezer row is
 * `deezer:track:123`, playing it resolves to a YouTube video id, downloading it
 * mints a content hash in the library. Comparing `currentTrack.id === row.id`
 * therefore works only *within* one hop, which is why the highlight used to
 * vanish on the search list and again in the library after a download.
 *
 * So identity is not a string, it is a **set of namespaced keys**. Two things
 * are the same song when their key sets intersect. Every key is exact — an id
 * someone assigned — never a fuzzy artist/title match, which would happily
 * conflate a live take, a remix and a re-recording.
 *
 * Namespaces (mirroring the engine's own dedupe keys in
 * `shared/api/routes/catalog.py`):
 *
 * - `lib:`    library track id (content hash)
 * - `yt:`     YouTube video id — the bridge between a preview and its download
 * - `isrc:`   recording code, the bridge between catalogs
 * - `mb:`     MusicBrainz recording id
 * - `deezer:` Deezer track id
 * - `pod:`    podcast episode guid
 * - `cat:`    catalog row id, the bridge back to the row that started playback
 */

/** Shared empty set, so "nothing is playing" costs no allocation per row. */
export const NO_KEYS: ReadonlySet<string> = new Set<string>();

const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

/** ISRCs travel with or without separators and in either case. */
const normIsrc = (v: unknown): string | null => {
  const raw = str(v);
  return raw ? raw.replace(/[\s-]/g, '').toUpperCase() : null;
};

function push(keys: string[], prefix: string, value: string | null): void {
  if (value) keys.push(`${prefix}:${value}`);
}

/**
 * Every identity a playable track answers to.
 *
 * A preview track's `id` *is* the YouTube video id (see `lib/media.ts`), while
 * an owned track's `id` is its library id and the video id lives in
 * `youtube_id` — the two namespaces must not be mixed up, or a preview would
 * claim to be a library track that does not exist.
 */
export function trackKeys(track: Track): string[] {
  const keys: string[] = [];
  const preview = track.source === 'preview';

  if (isPodcastTrack(track)) {
    // A streamed episode carries its guid as the id; a downloaded one has both.
    push(keys, 'pod', str(track.podcast_episode_guid) ?? (preview ? str(track.id) : null));
    if (!preview) push(keys, 'lib', str(track.id));
  } else if (preview) {
    push(keys, 'yt', str(track.id));
  } else {
    push(keys, 'lib', str(track.id));
    push(keys, 'yt', str(track.youtube_id));
  }

  push(keys, 'isrc', normIsrc(track.isrc));
  push(keys, 'mb', str(track.musicbrainz_id));
  // Where this track came from (the catalog row that resolved into it). Library
  // tracks never carry it, so the library index stays free of catalog keys.
  if (track.originKeys) keys.push(...track.originKeys);
  return keys;
}

/**
 * Every identity a catalog row answers to.
 *
 * `cat:` is always present and is the important one: it is what a resolved
 * track stamps as its origin, so a Deezer row lights up the moment the video it
 * resolved to starts playing — no id in common required, no server round trip,
 * and it survives leaving the view and searching again (catalog ids are stable).
 */
export function catalogItemKeys(item: CatalogItem): string[] {
  const keys: string[] = [];
  push(keys, 'cat', str(item.id));
  push(keys, 'lib', str(item.track_id));

  const ext = item.external_ids ?? {};
  push(keys, 'yt', str(ext.youtube_id));
  push(keys, 'isrc', normIsrc(ext.isrc));
  push(keys, 'mb', str(ext.musicbrainz_id));
  push(keys, 'deezer', str(ext.deezer_id));

  // YouTube rows carry the video payload directly; library rows put the library
  // track in `raw`, which `track_id` above already covers.
  if (item.source === 'youtube') push(keys, 'yt', str(item.raw?.id));
  return keys;
}

/** Online (YouTube) search results are identified by their video id. */
export function searchResultKeys(result: SearchResult): string[] {
  const keys: string[] = [];
  push(keys, 'yt', str(result.id));
  return keys;
}

/** A podcast episode row, keyed the way `podcastEpisodeToTrack` keys it. */
export function podcastEpisodeKeys(episodeKey: string): string[] {
  const keys: string[] = [];
  push(keys, 'pod', str(episodeKey));
  return keys;
}

/* ── Derivation ──
 * Pure builders. The store wraps each in a memo so they run only when their
 * input actually changes; keeping them pure is what lets the logic be tested
 * (and mocked) without a reactive graph around it.
 */

/**
 * Widen a key set with what is only known locally: which video a catalog row
 * resolved to. The engine cannot put this in a search response — the resolution
 * happens after the search — so without it a Deezer row and the download it
 * produced share no key at all.
 */
export function withLinkedKeys(keys: string[], links: ReadonlyMap<string, string>): string[] {
  if (!links.size) return keys;
  const out = keys.slice();
  for (const key of keys) {
    if (!key.startsWith('cat:')) continue;
    const videoId = links.get(key.slice(4));
    if (videoId) out.push(`yt:${videoId}`);
  }
  return out;
}

/** Every identity a set of tracks answers to → the track. First entry wins, so
 * the mapping stays stable when the library holds duplicates. */
export function buildIdentityIndex(tracks: Iterable<Track>): Map<string, Track> {
  const index = new Map<string, Track>();
  for (const track of tracks) {
    for (const key of trackKeys(track)) if (!index.has(key)) index.set(key, track);
  }
  return index;
}

/** Every identity present across a set of tracks (queue membership). */
export function collectIdentityKeys(tracks: Iterable<Track>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const track of tracks) for (const key of trackKeys(track)) keys.add(key);
  return keys;
}

/**
 * Every identity the playing track answers to, widened with the keys of the
 * library track it is owned as.
 *
 * That union is what survives a download finishing mid-song: the preview keeps
 * playing under its video id, the library gains a track carrying that same
 * video id, and this set now holds the new library id too — so the row in the
 * library recognises itself without playback being touched.
 *
 * One hop is enough. The twin's own keys already carry its library id, ISRC and
 * MusicBrainz id, so there is nothing further to reach.
 */
export function resolvePlayingKeys(
  current: Track | null,
  index: ReadonlyMap<string, Track>,
  links: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  if (!current) return NO_KEYS;
  const keys = new Set(withLinkedKeys(trackKeys(current), links));
  for (const key of [...keys]) {
    const twin = index.get(key);
    if (twin) for (const twinKey of trackKeys(twin)) keys.add(twinKey);
  }
  return keys;
}

/** Do these identities name something in `set`? */
export function keysMatch(
  keys: string[],
  set: ReadonlySet<string>,
  links: ReadonlyMap<string, string>,
): boolean {
  if (!set.size) return false;
  for (const key of withLinkedKeys(keys, links)) if (set.has(key)) return true;
  return false;
}
