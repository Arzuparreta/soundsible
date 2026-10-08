import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';
import catalog from './catalog/catalog.json' with { type: 'json' };

/**
 * An engine for the screenshots, answering from the Jamendo catalog in
 * `catalog/` (see `catalog/fetch.mjs`). Nothing reaches the network: the
 * pictures are the same on every machine and on every run.
 */

export type CatalogTrack = (typeof catalog.tracks)[number];

const dir = join(import.meta.dirname, 'catalog');
export const tracks = catalog.tracks;
/** Newest first, one song from each album in turn, so the top of the list —
 * the only part a screenshot shows — is the whole library rather than one
 * record. */
export const library = (() => {
  const byAlbum = Map.groupBy(tracks.filter((row) => row.in_library), (row) => row.album_id);
  const rounds = Math.max(...[...byAlbum.values()].map((rows) => rows.length));
  return Array.from({ length: rounds }, (_, round) => [...byAlbum.values()].flatMap((rows) => rows[round] ?? [])).flat();
})();
export const albums = catalog.albums;
export const artists = catalog.artists;
export const track = (title: string): CatalogTrack => {
  const found = tracks.find((row) => row.title === title);
  if (!found) throw new Error(`No showcase track called ${title}`);
  return found;
};

const QUIET = new Set([
  '/api/catalog/resolve',
  '/api/discover/feed',
  '/api/discovery/music/recently-saved',
  '/api/discovery/podcasts/recommendations',
  '/api/playback/play-timing',
  '/api/playback/trace',
]);

/** The song every screenshot is in the middle of. */
export const NOW_PLAYING = track('Stickybee');
export const NOW_PLAYING_AT = 53;
/** What the listener asked for next, ahead of the library carrying on. */
export const REQUESTS = ['Polygondwanaland', 'Her', 'Leaving Paradise', 'Magnolia Soul', 'Exotica', 'Earth (2009)', 'Confusion Will Pass']
  .map((album) => library.find((row) => row.album === album)!);

const covers = new Map(albums.map((album) => [album.id, readFileSync(join(dir, 'covers', `${album.id}.jpg`))]));
const artistImages = new Map(artists.map((artist) => [artist.id, readFileSync(join(dir, 'artists', `${artist.id}.jpg`))]));
const coverOf = (id: string) => {
  const row = tracks.find((track) => track.id === id);
  return row && covers.get(row.album_id);
};

/** Newest first, a day apart, ending on a fixed date: the library's order is
 * the catalog's, whatever day the screenshots are taken. */
const addedAt = (index: number) => new Date(Date.UTC(2026, 8, 30) - index * 86_400_000).toISOString().replace(/Z$/, '');

const asTrack = (row: CatalogTrack, index = 0) => ({
  id: row.id,
  title: row.title,
  artist: row.artist,
  album: row.album,
  album_artist: row.album_artist,
  year: row.year,
  genre: row.genre,
  duration: row.duration,
  added_at: addedAt(index),
  artwork_revision: 'showcase',
  artwork_width: 500,
  artwork_height: 500,
  audio_quality: 'lossy',
});

/**
 * Lyrics with timings spread over the song. Jamendo has the words but not when
 * they are sung, and the screenshots only need a line lit in the right place.
 */
function syncedLyrics(row: CatalogTrack): string | null {
  if (!row.lyrics) return null;
  const lines = row.lyrics.split('\n').map((line) => line.trim()).filter(Boolean);
  const start = 14;
  const step = (row.duration - start - 20) / lines.length;
  const stamp = (seconds: number) =>
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
  return lines.map((line, index) => `[${stamp(start + index * step)}]${line}`).join('\n');
}

/**
 * Silence exactly as long as the song, so the player's clock reads the
 * catalog's duration. 8 kHz, 8-bit mono: the smallest WAV a browser plays.
 */
const silences = new Map<number, Buffer>();
function silence(seconds: number): Buffer {
  let wav = silences.get(seconds);
  if (wav) return wav;
  const samples = 8000 * seconds;
  wav = Buffer.alloc(44 + samples, 0x80);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(samples, 40);
  silences.set(seconds, wav);
  return wav;
}

/** Served in ranges, as the engine does: without them the browser cannot seek,
 * and a restored session would sit at 0:00 instead of where it was left. */
function stream(route: Route, body: Buffer) {
  const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
  const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' };
  if (!range) return route.fulfill({ status: 200, headers, body });
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  return route.fulfill({
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}` },
    body: body.subarray(start, end + 1),
  });
}

export async function mockShowcaseEngine(page: Page, theme: string): Promise<void> {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.startsWith('/api/static/stream/')) {
      const row = tracks.find((track) => track.id === decodeURIComponent(path.slice('/api/static/stream/'.length)));
      return stream(route, silence(row?.duration ?? 180));
    }
    if (path.startsWith('/api/static/cover/')) {
      const body = coverOf(decodeURIComponent(path.slice('/api/static/cover/'.length)));
      return body ? route.fulfill({ contentType: 'image/jpeg', body }) : route.fulfill({ status: 404 });
    }
    if (path.startsWith('/api/showcase/artist/')) {
      const body = artistImages.get(path.slice('/api/showcase/artist/'.length));
      return body ? route.fulfill({ contentType: 'image/jpeg', body }) : route.fulfill({ status: 404 });
    }
    if (path.startsWith('/api/showcase/album/')) {
      const body = covers.get(path.slice('/api/showcase/album/'.length));
      return body ? route.fulfill({ contentType: 'image/jpeg', body }) : route.fulfill({ status: 404 });
    }
    const lyrics = path.match(/^\/api\/library\/tracks\/([^/]+)\/lyrics$/);
    if (lyrics) {
      const row = tracks.find((track) => track.id === decodeURIComponent(lyrics[1]));
      const synced = row && syncedLyrics(row);
      return json(synced
        ? { status: 'ready', synced, plain: row!.lyrics, instrumental: false, cached: true }
        : { status: 'not_found', synced: null, plain: null, instrumental: false, cached: true });
    }
    switch (path) {
      case '/api/auth/state':
        return json({
          requires_login: true,
          user: { id: 'showcase', username: 'alex', display_name: 'Alex', role: 'admin', has_password: true },
        });
      case '/api/library':
        return json({ tracks: library.map(asTrack), playlists: {}, settings: {}, podcast_subscriptions: [] });
      case '/api/library/saved-entities':
        return json({ entities: [] });
      case '/api/library/favourites':
        return json([]);
      case '/api/downloader/queue':
      case '/api/downloader/queue/status':
        return json({ queue: [], is_processing: false, logs: [] });
      case '/api/library/saved':
        return json({ saved: [] });
      case '/api/library/artists':
        return json({ artists: [] });
      case '/api/library/genres':
        return json({ genres: [] });
      case '/api/library/years':
        return json({ years: [] });
      case '/api/discovery/settings':
        return json({ learning_enabled: true, autoplay_enabled: true });
      case '/api/downloader/config':
        return json({ quality: 'high', auto_update_ytdlp: false });
      case '/api/devices':
      case '/api/paired-devices':
      case '/api/pairing/sessions':
        return json({ devices: [], sessions: [] });
      case '/api/playback/state':
        return json(route.request().method() === 'GET' ? playbackState() : { status: 'ok' });
      case '/api/catalog/search':
        return json(catalogSearch(url.searchParams.get('q') ?? ''));
    }
    // Recommendations and lookups no screenshot shows. Anything else is new,
    // and worth knowing about before it draws an error into a picture.
    if (!QUIET.has(path)) console.warn(`showcase engine: nothing answers ${route.request().method()} ${path}`);
    return json({});
  });
  await page.addInitScript((theme) => {
    localStorage.clear();
    localStorage.setItem('lang', 'en');
    localStorage.setItem('theme', theme);
    localStorage.setItem('soundsible:interface-size', 'normal');
    localStorage.setItem('device_id', 'showcase-device');
  }, theme);
}

/** A session this device left paused: `NOW_PLAYING`, the requests queued
 * behind it, then the library carrying on. */
function playbackState() {
  const context = { id: 'library', kind: 'library', label: 'Your library', destination: '/' };
  const index = library.indexOf(NOW_PLAYING);
  const queue = [
    { ...asTrack(NOW_PLAYING, index), queueId: `q-${NOW_PLAYING.id}`, queueLane: 'context', queueSource: 'library', queueContext: context, queueContextIndex: index },
    ...REQUESTS.map((row) => ({ ...asTrack(row, library.indexOf(row)), queueId: `q-${row.id}`, queueLane: 'manual', queueSource: 'add_to_queue' })),
    ...library.slice(index + 1).map((row, offset) => ({
      ...asTrack(row, index + 1 + offset), queueId: `q-${row.id}`, queueLane: 'context', queueSource: 'library',
      queueContext: context, queueContextIndex: index + 1 + offset,
    })),
  ];
  return {
    device_id: 'showcase-device',
    device_name: 'Soundsible Web',
    track_id: NOW_PLAYING.id,
    track: asTrack(NOW_PLAYING, index),
    position_sec: NOW_PLAYING_AT,
    is_playing: false,
    updated_at: Date.now() / 1000,
    session: {
      v: 1, mode: 'now_playing', queue, index: 0, shuffle: false, repeat: 'off',
      radio: { active: false, seedId: null }, auto: null,
    },
  };
}

/**
 * Catalog search, answered for the one artist the search screenshot asks for:
 * the songs of theirs the library does not have yet, one album at a time, the
 * way looking an artist up is for finding more of them.
 */
function catalogSearch(query: string) {
  const artist = artists.find((row) => row.name.toLowerCase() === query.trim().toLowerCase());
  if (!artist) return { query, items: [], sections: [] };
  const own = Map.groupBy(tracks.filter((row) => row.artist === artist.name && !row.in_library), (row) => row.album_id);
  const rounds = Math.max(...[...own.values()].map((rows) => rows.length));
  const missing = Array.from({ length: rounds }, (_, round) => [...own.values()].flatMap((rows) => rows[round] ?? [])).flat();
  const songs = missing.map((row) => ({
    id: `youtube:${row.id}`,
    type: 'track',
    source: 'youtube',
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.duration,
    cover: `/api/showcase/album/${row.album_id}`,
    action_state: { in_library: false, playable: true, downloadable: true },
  }));
  const records = albums.filter((row) => row.artist === artist.name).map((row) => ({
    id: `deezer:album:${row.id}`,
    type: 'album',
    source: 'deezer',
    title: row.title,
    artist: row.artist,
    subtitle: String(row.year),
    cover: `/api/showcase/album/${row.id}`,
    external_ids: { deezer_album_id: row.id },
  }));
  const top = {
    id: `deezer:artist:${artist.id}`,
    type: 'artist',
    source: 'deezer',
    title: artist.name,
    cover: `/api/showcase/artist/${artist.id}`,
    external_ids: { deezer_artist_id: artist.id },
  };
  return {
    query,
    top_result: top.id,
    items: [top, ...songs, ...records],
    sections: [
      { id: 'top', layout: 'hero', item_ids: [top.id], total: 1 },
      { id: 'songs', layout: 'rows', item_ids: songs.map((row) => row.id), total: songs.length },
      { id: 'albums', layout: 'grid', item_ids: records.map((row) => row.id), total: records.length },
    ],
  };
}
