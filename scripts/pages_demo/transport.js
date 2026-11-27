const asset = path => new URL(path, document.baseURI).href;
const tracksById = new Map();
let collection;

export function streamUrl(id) {
  const track = tracksById.get(id);
  return track ? asset(`media/${track.file}`) : '';
}

export function coverUrl(id) {
  const track = tracksById.get(id);
  return track ? asset(`media/${track.album_id}.svg`) : undefined;
}

async function loadCollection() {
  const response = await fetch(asset('catalog.json'));
  if (!response.ok) throw new Error(`Demo catalog returned HTTP ${response.status}`);
  const tracks = await response.json();
  const albums = new Map();
  const artists = new Map();
  for (const track of tracks) {
    track.artist_id = track.artist.toLowerCase().replaceAll(' ', '-');
    tracksById.set(track.id, track);
    const artist = artists.get(track.artist_id) ?? {
      id: track.artist_id, name: track.artist, track_ids: [], albums: [], cover_track_id: track.id,
    };
    const album = albums.get(track.album_id) ?? {
      id: track.album_id, title: track.album, album_artist: track.artist,
      album_artist_id: artist.id, year: track.year, genre: track.genre, is_compilation: false,
      cover_track_id: track.id, track_ids: [], duration: 0,
    };
    if (!albums.has(album.id)) artist.albums.push(album);
    artist.track_ids.push(track.id);
    artist.track_count = artist.track_ids.length;
    artist.album_count = artist.albums.length;
    album.track_ids.push(track.id);
    album.track_count = album.track_ids.length;
    album.duration += track.duration;
    albums.set(album.id, album);
    artists.set(artist.id, artist);
  }
  return { tracks, albums, artists };
}

function getCollection() {
  return collection ??= loadCollection().catch(error => {
    collection = undefined;
    throw error;
  });
}

// This collection is separate from the public media and scoped to the browser.
const favouritesKey = 'soundsible:pages-demo:favourites';
let marked = [];
try {
  const stored = JSON.parse(localStorage.getItem(favouritesKey) ?? '[]');
  if (Array.isArray(stored)) marked = stored.filter(id => typeof id === 'string');
} catch {
  // Playback also works when the browser restricts storage.
}

function setFavourite(id, requested) {
  const is_favourite = requested ?? !marked.includes(id);
  marked = is_favourite ? [id, ...marked.filter(item => item !== id)] : marked.filter(item => item !== id);
  try { localStorage.setItem(favouritesKey, JSON.stringify(marked)); } catch { /* session-only */ }
  return Response.json({ is_favourite });
}

function favouriteEntries() {
  return marked.flatMap(id => {
    const track = tracksById.get(id);
    return track ? [{ ...track, keys: [`lib:${id}`], favourite: true }] : [];
  });
}

function trackItem(track) {
  return {
    ...track, id: `lib:${track.id}`, type: 'library_track', source: 'library', track_id: track.id,
    cover: coverUrl(track.id), action_state: { in_library: true, playable: true }, raw: track,
  };
}

function search({ tracks, albums, artists }, params) {
  const query = params.get('q')?.trim() ?? '';
  const matches = value => value.toLowerCase().includes(query.toLowerCase());
  const types = params.get('type')?.split(',') ?? ['all'];
  const items = [
    ...tracks.filter(track => matches(`${track.title} ${track.artist} ${track.album}`)).map(trackItem),
    ...[...albums.values()].filter(album => matches(`${album.title} ${album.album_artist}`)).map(album => ({
      id: `album:${album.id}`, title: album.title, artist: album.album_artist, type: 'album', source: 'library',
      cover: coverUrl(album.cover_track_id), external_ids: { library_album_id: album.id },
    })),
    ...[...artists.values()].filter(artist => matches(artist.name)).map(artist => ({
      id: `artist:${artist.id}`, title: artist.name, type: 'artist', source: 'library',
      cover: coverUrl(artist.cover_track_id), external_ids: { library_artist_id: artist.id },
    })),
  ].filter(item => types.includes('all') || types.includes(item.type));
  return Response.json({ query, items: query ? items : [], sections: [] });
}

export async function demoRequest(url, { method, body, signal }) {
  const { pathname: path, searchParams } = new URL(url);
  const library = await getCollection();
  signal?.throwIfAborted();
  const { tracks, albums, artists } = library;
  if (path.startsWith('/api/library/albums/')) {
    const album = albums.get(decodeURIComponent(path.split('/').at(-1)));
    return album ? Response.json({ album, track_ids: album.track_ids }) : new Response(null, { status: 404 });
  }
  if (path.startsWith('/api/library/artists/')) {
    const artist = artists.get(decodeURIComponent(path.split('/').at(-1)));
    return artist ? Response.json({ artist, albums: artist.albums, track_ids: artist.track_ids }) : new Response(null, { status: 404 });
  }
  if (path.endsWith('/lyrics') || path === '/api/lyrics') {
    return Response.json({ status: 'not_found', synced: null, plain: null });
  }
  if (path === '/api/library/favourites/toggle' || (path === '/api/library/favourites' && method === 'PUT')) {
    const payload = JSON.parse(body ?? '{}');
    const keys = (payload.entry ?? payload.favourite)?.keys ?? [];
    const id = keys.find(key => key.startsWith('lib:'))?.slice(4) ?? payload.track_id;
    if (!tracksById.has(id)) return new Response(null, { status: 404 });
    return setFavourite(id, payload.marked);
  }
  switch (path) {
    case '/api/auth/state':
      return Response.json({ requires_login: false, user: { id: 'pages-demo', username: 'listener', role: 'user' } });
    case '/api/library':
      return Response.json({ tracks, playlists: {}, settings: {}, podcast_subscriptions: [] });
    case '/api/library/albums':
      return Response.json({ albums: [...albums.values()] });
    case '/api/library/artists':
      return Response.json({ artists: [...artists.values()] });
    case '/api/library/saved':
      return Response.json({ saved: favouriteEntries() });
    case '/api/library/favourites':
      return Response.json(marked.filter(id => tracksById.has(id)));
    case '/api/library/favourites/entries':
      return Response.json({ favourites: favouriteEntries() });
    case '/api/library/saved-entities':
      return Response.json({ entities: [] });
    case '/api/catalog/album': {
      const album = [...albums.values()].find(item => item.title === searchParams.get('name'));
      if (!album) return new Response(null, { status: 404 });
      return Response.json({
        title: album.title, artist: album.album_artist, year: album.year, genre: album.genre,
        duration: album.duration, cover: coverUrl(album.cover_track_id),
        tracklist: album.track_ids.map(id => trackItem(tracksById.get(id))),
        resolved: true, in_library: true, cached: true,
      });
    }
    case '/api/catalog/artist': {
      const artist = [...artists.values()].find(item => item.name === searchParams.get('name'));
      if (!artist) return new Response(null, { status: 404 });
      return Response.json({
        name: artist.name, resolved: true, in_library: true, cached: true,
        top_tracks: artist.track_ids.map(id => trackItem(tracksById.get(id))),
        albums: [], singles_eps: [], candidates: [], related_artists: [],
      });
    }
    case '/api/catalog/search':
      return search(library, searchParams);
    case '/api/devices':
      return Response.json({ devices: [] });
    case '/api/playback/state':
      return Response.json({});
    default:
      return Response.json({ error: 'This feature requires a Soundsible Station.' }, { status: 404 });
  }
}
