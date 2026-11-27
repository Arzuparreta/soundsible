const catalog = fetch(new URL('catalog.json', document.baseURI)).then(response => response.json());

export async function demoRequest(url) {
  const path = new URL(url).pathname;
  const tracks = await catalog;
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
