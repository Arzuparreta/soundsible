// Only documents inside the demo directory are controlled by this worker.
const base = self.registration.scope;
let loaded;
const catalog = () => loaded ??= fetch(new URL('catalog.json', base)).then(response => response.json());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/player/')) {
    event.respondWith(fetch(new URL(url.pathname.slice('/player/'.length), base)));
    return;
  }
  if (!url.pathname.startsWith('/api/')) return;
  event.respondWith(answer(request, url.pathname));
});

async function answer(request, path) {
  if (path.startsWith('/api/static/stream/')) {
    const id = path.split('/').pop();
    if (!(await catalog()).some(track => track.id === id)) return new Response(null, { status: 404 });
    const response = await fetch(new URL(id + '.wav', base), { headers: request.headers });
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range') ?? '');
    if (!range || response.status !== 200) return response;
    const data = await response.arrayBuffer();
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), data.byteLength - 1) : data.byteLength - 1;
    if (start > end) return new Response(null, { status: 416 });
    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${data.byteLength}`,
        'Content-Length': String(end - start + 1) },
    });
  }
  if (path.startsWith('/api/static/cover/')) {
    return fetch(new URL('cover.svg', base));
  }
  const tracks = await catalog();
  const ids = tracks.map(track => track.id);
  const artist = { id: 'soundsible', name: 'Soundsible', track_count: ids.length, album_count: 1, cover_track_id: ids[0] };
  const album = { id: 'station-studies', title: 'Station Studies', album_artist: artist.name,
    album_artist_id: artist.id, genre: 'Electronic', is_compilation: false, track_count: ids.length,
    cover_track_id: ids[0], duration: tracks.reduce((sum, track) => sum + track.duration, 0) };
  switch (path) {
    case '/api/library/albums':
      return Response.json({ albums: [album] });
    case '/api/library/artists':
      return Response.json({ artists: [artist] });
    case '/api/library/albums/station-studies':
      return Response.json({ album, track_ids: ids });
    case '/api/library/artists/soundsible':
      return Response.json({ artist, albums: [album], track_ids: ids });
    case '/api/library/saved':
      return Response.json({ saved: [] });
    case '/api/auth/state':
      return Response.json({ requires_login: false, user: { id: 'demo', username: 'listener', role: 'user' } });
    case '/api/library':
      return Response.json({ tracks, playlists: {}, settings: {}, podcast_subscriptions: [] });
    case '/api/library/favourites':
      return Response.json([]);
    case '/api/library/saved-entities':
      return Response.json({ entities: [] });
    case '/api/devices':
      return Response.json({ devices: [] });
    case '/api/playback/state':
      return Response.json({});
    default:
      return new Response(null, { status: 404 });
  }
}
