/**
 * The engine the rendering bench talks to: a production bundle and a large,
 * deterministic library, served from one origin by plain Node.
 *
 * A real HTTP server rather than Playwright routes, so no request crosses the
 * automation channel while frames are being counted.
 *
 * Sizes follow the 2026-11-16 web UI review: 6,000 tracks, 600 albums,
 * 200 artists, 1,800 saved songs of which 900 are favourites, real JPEG
 * artwork (the showcase catalog's covers, reused by album).
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const here = import.meta.dirname;
const coverDir = join(here, '..', 'showcase', 'catalog', 'covers');
const covers = readdirSync(coverDir).filter((name) => name.endsWith('.jpg')).sort().map((name) => readFileSync(join(coverDir, name)));

export const SIZES = { tracks: 6000, albums: 600, artists: 200, saved: 1800, favourites: 900, previews: 600, stressAlbumTracks: 100 };

/** Deterministic words, so titles differ in length the way real ones do. */
const WORDS = ['Night', 'River', 'Glass', 'Echo', 'Paper', 'Signal', 'Harbour', 'Velvet', 'Static', 'Orchard', 'Northern', 'Quiet', 'Electric', 'Summer', 'Hollow', 'Golden', 'Winter', 'Satellite', 'Motel', 'Parade'];
const phrase = (seed, words) => Array.from({ length: words }, (_, index) => WORDS[(seed * 7 + index * 13 + (seed >> 3)) % WORDS.length]).join(' ');
const stamp = (index) => new Date(Date.UTC(2026, 9, 1) - index * 3_600_000).toISOString().replace(/Z$/, '');

function build() {
  const artists = Array.from({ length: SIZES.artists }, (_, index) => ({ id: `artist-${index}`, name: `${phrase(index, 2)} ${index}` }));
  const albums = Array.from({ length: SIZES.albums }, (_, index) => {
    const artist = artists[index % SIZES.artists];
    return { id: `album-${index}`, title: `${phrase(index + 31, 1 + (index % 3))} ${index}`, artist, year: 1970 + (index % 55), genre: ['Rock', 'Jazz', 'Electronic', 'Folk', 'Soul'][index % 5], tracks: [] };
  });
  const files = [];
  // Album 0 is the stress album the review scrolled: 100 tracks on one page.
  const perAlbum = (SIZES.tracks - SIZES.stressAlbumTracks) / (SIZES.albums - 1);
  for (let index = 0; index < SIZES.tracks; index += 1) {
    const album = index < SIZES.stressAlbumTracks ? albums[0] : albums[1 + Math.floor((index - SIZES.stressAlbumTracks) / perAlbum)];
    const track = {
      id: `file-${index}`, item_id: `item-${index}`, title: phrase(index + 5, 1 + (index % 4)), artist: album.artist.name,
      artist_id: album.artist.id, album: album.title, album_id: album.id, album_artist: album.artist.name,
      track_number: album.tracks.length + 1, disc_number: 1, year: album.year, genre: album.genre,
      duration: 150 + (index * 37) % 240, added_at: stamp(index), artwork_revision: 'bench', artwork_width: 500, artwork_height: 500,
      audio_quality: 'lossy',
    };
    album.tracks.push(track);
    files.push(track);
  }
  const previews = Array.from({ length: SIZES.previews }, (_, index) => ({
    id: `yt${String(index).padStart(9, '0')}`, item_id: `item-p${index}`, title: phrase(index + 900, 2 + (index % 3)),
    artist: artists[(index * 3) % SIZES.artists].name, album: phrase(index + 77, 2), duration: 170 + (index * 11) % 200,
    source: 'preview', cover: null, originKeys: [`yt:yt${String(index).padStart(9, '0')}`], unavailable: false, added_at: stamp(index * 9 + 4),
  }));
  // Every fifth file is saved (1,200), plus every preview (600).
  const savedFiles = files.filter((_, index) => index % 5 === 0);
  const saved = [...savedFiles.map((track) => ({ track, keys: [`lib:${track.id}`] })), ...previews.map((track) => ({ track, keys: track.originKeys }))]
    .map(({ track, keys }, index) => ({
      item_id: track.item_id, keys, title: track.title, artist: track.artist, album: track.album, duration: track.duration,
      added_at: track.added_at, ...(index % 2 === 0 ? { favourite: true, favourited_at: track.added_at } : {}),
    }))
    .sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
  const items = [...files, ...previews].sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
  const playlists = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`Playlist ${index + 1}`, files.filter((_, at) => at % 24 === index).slice(0, 120).map((track) => track.item_id)]));
  return { artists, albums, files, previews, saved, items, playlists };
}

const data = build();
const coverByFile = new Map(data.files.map((track) => [track.id, covers[Number(track.album_id.slice(6)) % covers.length]]));

const catalogAlbum = (album) => ({
  id: album.id, title: album.title, album_artist: album.artist.name, album_artist_id: album.artist.id, year: album.year, genre: album.genre,
  is_compilation: false, track_count: album.tracks.length, duration: album.tracks.reduce((sum, track) => sum + track.duration, 0),
  cover_track_id: album.tracks[0]?.id ?? null,
});
const catalogArtist = (artist) => {
  const albums = data.albums.filter((album) => album.artist === artist);
  return { id: artist.id, name: artist.name, track_count: albums.reduce((sum, album) => sum + album.tracks.length, 0), album_count: albums.length, cover_track_id: albums[0]?.tracks[0]?.id ?? null };
};

/** Silence long enough that a playing bench never reaches the end of a song. */
const WAV = (() => {
  const seconds = 600, samples = 8000 * seconds, wav = Buffer.alloc(44 + samples, 0x80);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(samples, 40);
  return wav;
})();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.webp': 'image/webp' };

function api(request, response, url) {
  const path = url.pathname;
  const json = (body, headers = {}) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); response.end(JSON.stringify(body)); };
  if (path.startsWith('/api/static/cover/')) {
    const body = coverByFile.get(decodeURIComponent(path.slice('/api/static/cover/'.length)));
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
    response.end(body);
    return;
  }
  if (path.startsWith('/api/static/stream/')) {
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), WAV.length - 1) : WAV.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${WAV.length}` } : {}) });
    response.end(WAV.subarray(start, end + 1));
    return;
  }
  const album = /^\/api\/library\/albums\/([^/]+)$/.exec(path);
  if (album) {
    const row = data.albums.find((entry) => entry.id === decodeURIComponent(album[1]));
    if (!row) { response.writeHead(404); response.end('{}'); return; }
    return json({ album: catalogAlbum(row), track_ids: row.tracks.map((track) => track.id) });
  }
  const artist = /^\/api\/library\/artists\/([^/]+)$/.exec(path);
  if (artist) {
    const row = data.artists.find((entry) => entry.id === decodeURIComponent(artist[1]));
    if (!row) { response.writeHead(404); response.end('{}'); return; }
    const albums = data.albums.filter((entry) => entry.artist === row);
    return json({ artist: catalogArtist(row), albums: albums.map(catalogAlbum), track_ids: albums.flatMap((entry) => entry.tracks.map((track) => track.id)) });
  }
  switch (path) {
    case '/api/auth/state':
      return json({ requires_login: true, user: { id: 'bench', username: 'bench', display_name: 'Bench', role: 'admin', has_password: true } });
    case '/api/library':
      return json({ tracks: data.files, playlists: data.playlists, settings: {}, podcast_subscriptions: [] }, { ETag: '"bench-1"', 'X-Soundsible-Collection': 'true' });
    case '/api/library/collection':
      return json({ items: data.items, files: data.files, saved: data.saved, playlists: data.playlists, revision: 1, library_revision: 1, settings: {}, podcast_subscriptions: [] }, { ETag: '"bench-collection-1"' });
    case '/api/library/saved':
      return json({ version: 2, saved: data.saved });
    case '/api/library/favourites':
      return json([]);
    case '/api/library/saved-entities':
      return json({ entities: [] });
    case '/api/library/albums':
      return json({ albums: data.albums.map(catalogAlbum), sort: url.searchParams.get('sort') ?? 'name' });
    case '/api/library/artists':
      return json({ artists: data.artists.map(catalogArtist) });
    case '/api/library/genres':
      return json({ genres: ['Rock', 'Jazz', 'Electronic', 'Folk', 'Soul'].map((name) => ({ name, song_count: SIZES.tracks / 5, album_count: SIZES.albums / 5 })) });
    case '/api/library/years':
      return json({ years: [] });
    case '/api/downloader/queue':
    case '/api/downloader/queue/status':
      return json({ queue: [], is_processing: false, logs: [] });
    case '/api/discovery/settings':
      return json({ learning_enabled: true, autoplay_enabled: false });
    case '/api/downloader/config':
      return json({ quality: 'high', auto_update_ytdlp: false });
    case '/api/devices':
    case '/api/paired-devices':
    case '/api/pairing/sessions':
      return json({ devices: [], sessions: [] });
    // The album and artist pages ask the catalog about the record as well;
    // a library-only answer keeps them on the tracks the bench scrolls.
    case '/api/catalog/album':
      return json({ title: url.searchParams.get('name') ?? '', artist: url.searchParams.get('artist') ?? '', tracklist: [], resolved: false, in_library: true });
    case '/api/catalog/artist':
      return json({ name: url.searchParams.get('name') ?? '', resolved: false, top_tracks: [], albums: [], singles_eps: [], related_artists: [], candidates: [], in_library: true });
    case '/api/discovery/music/feed':
      return json({ sections: [] });
    // The player's search panel lists what this answers: library songs whose
    // title holds the query, capped as the engine caps a search.
    case '/api/catalog/search': {
      const wanted = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const items = data.files.filter((track) => track.title.toLowerCase().includes(wanted)).slice(0, 36).map((track) => ({
        id: `library:${track.id}`, type: 'library_track', source: 'library', title: track.title, artist: track.artist,
        subtitle: track.artist, album: track.album, duration: track.duration, track_id: track.id, item_id: track.item_id,
        action_state: { in_library: true, playable: true },
      }));
      return json({ items, sections: [{ id: 'songs', item_ids: items.map((item) => item.id) }] });
    }
  }
  return json({});
}

/** Serve `dist` at /player/ and the fixture at /api. Resolves to the origin. */
export function startServer(dist, port = 0) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://bench');
    if (url.pathname.startsWith('/api/')) return api(request, response, url);
    if (url.pathname.startsWith('/socket.io/')) { response.writeHead(404); response.end(); return; }
    const relative = normalize(decodeURIComponent(url.pathname.replace(/^\/player\/?/, ''))).replace(/^(\.\.[/\\])+/, '');
    let file = join(dist, relative);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) })));
}

export const fixture = data;
