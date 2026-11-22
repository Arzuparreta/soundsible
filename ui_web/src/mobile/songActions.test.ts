import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn(), menu: vi.fn(), toast: { action: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn() } }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: mocks.menu }));
vi.mock('../lib/toast', () => ({ toast: mocks.toast }));
vi.mock('../lib/i18n', () => ({ t: (key: string, values?: Record<string, string>) => values ? `${key}:${Object.values(values).join(',')}` : key }));
import { catalogFeedback, nativeFeedbackActions, nativeMusicLinkActions, openNativePlayOnDevice, podcastFeedback } from './songActions';
import { trackMusic } from '../lib/musicLinks';
import type { CatalogItem, Track } from '../types/music';
afterEach(() => vi.resetAllMocks());
const song: Track = { id: 'song', title: 'Song', artist: 'A', artists: ['A', 'B'], album: 'Record', album_artist: 'A' } as Track;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

it('offers one link per performer and then the album, like the web menu', () => {
  const open = vi.fn();
  const actions = nativeMusicLinkActions(trackMusic(song), open, false);
  expect(actions.map(action => action.label)).toEqual(['trackActions.goToArtist: A', 'trackActions.goToArtist: B', 'musicExplorer.openAlbum']);
  actions[2].onSelect(); expect(open).toHaveBeenCalledWith(expect.stringMatching(/^\/album\/Record\?/));
  expect(nativeMusicLinkActions(trackMusic({ ...song, artists: undefined, album: '' }), open, true).map(action => [action.label, action.disabled]))
    .toEqual([['trackActions.goToArtist', true]]);
  expect(nativeMusicLinkActions(trackMusic({ ...song, media_kind: 'podcast_episode' } as Track), open, false)).toEqual([]);
});

it('sends "not interested" and "less from this artist" only for recommended items, forwards deezer/isrc and dismissal hooks, and undoes for the same account', async () => {
  const plain = { id: 'x', type: 'track', title: 'T', artist: 'A', raw: {} } as CatalogItem;
  expect(catalogFeedback(plain)).toBeNull(); expect(nativeFeedbackActions(null, () => true)).toEqual([]);
  const recommended = {
    ...plain,
    external_ids: { deezer_id: '300', deezer_artist_id: '77', isrc: 'USRC17607839' },
    raw: { youtube_id: 'dQw4w9WgXcQ', recommendation: { identity: 'id-1', source: 'discover', reason: 'Because you played A' } },
  } as CatalogItem;
  let current = true;
  const onDismissed = vi.fn();
  const onUndone = vi.fn();
  const onArtistDismissed = vi.fn();
  const onArtistUndone = vi.fn();
  const actions = nativeFeedbackActions(catalogFeedback(recommended), () => current, {
    onDismissed, onUndone, onArtistDismissed, onArtistUndone,
  });
  expect(actions.map(action => [action.label, !!action.disabled])).toEqual([
    ['Because you played A', true],
    ['trackActions.notInterested', false],
    ['trackActions.lessFromArtist', false],
  ]);
  mocks.request.mockResolvedValueOnce({ recorded: true, event_id: 'event/1' }).mockResolvedValueOnce({ undone: true });
  actions[1].onSelect(); await flush();
  expect(mocks.request.mock.calls[0][1].body).toEqual({
    feedback: 'not_interested',
    item: { media_type: 'music_track', track_id: undefined, title: 'T', artist: 'A', youtube_id: 'dQw4w9WgXcQ', deezer_id: '300', deezer_artist_id: '77', isrc: 'USRC17607839', source: 'discover' },
  });
  expect(onDismissed).toHaveBeenCalledTimes(1);
  const undo = mocks.toast.action.mock.calls[0][2];
  current = false; undo(); expect(mocks.request).toHaveBeenCalledTimes(1);
  current = true; undo(); await flush();
  expect(mocks.request.mock.calls[1][0]).toBe('/api/discovery/feedback/event%2F1');
  expect(onUndone).toHaveBeenCalledTimes(1);

  mocks.request.mockResolvedValueOnce({ recorded: true, event_id: 'event/2' }).mockResolvedValueOnce({ undone: true });
  actions[2].onSelect(); await flush();
  expect(mocks.request.mock.calls[2][1].body).toEqual({
    feedback: 'less_from_artist',
    item: { media_type: 'music_track', track_id: undefined, title: 'T', artist: 'A', youtube_id: 'dQw4w9WgXcQ', deezer_id: '300', deezer_artist_id: '77', isrc: 'USRC17607839', source: 'discover' },
  });
  expect(onArtistDismissed).toHaveBeenCalledWith('A');
  const undoArtist = mocks.toast.action.mock.calls[1][2];
  undoArtist(); await flush();
  expect(mocks.request.mock.calls[3][0]).toBe('/api/discovery/feedback/event%2F2');
  expect(onArtistUndone).toHaveBeenCalledWith('A');

  const podcastActions = nativeFeedbackActions(
    podcastFeedback({ title: 'Show', author: 'Host', feed_url: 'https://example.com/rss', recommendation_identity: 'podcast:show:1' }),
    () => true,
  );
  expect(podcastActions.map(action => action.label)).toEqual(['trackActions.notInterested']);
  const podcastEpisodeActions = nativeFeedbackActions(
    { recommendation: {}, item: { media_type: 'podcast_episode', artist: 'Show Host' } },
    () => true,
  );
  expect(podcastEpisodeActions.map(action => action.label)).toEqual(['trackActions.notInterested']);

  // Uses structured primary artist (artists[0]) and falls back to subtitle via itemArtist.
  const collab = {
    id: 'c1', type: 'track', title: 'Get Lucky', artist: 'Daft Punk, Pharrell Williams',
    raw: { artists: ['Daft Punk', 'Pharrell Williams'], recommendation: { identity: 'id-c1', source: 'discover' } },
  } as CatalogItem;
  expect(catalogFeedback(collab)?.item.artist).toBe('Daft Punk');
  const subtitleOnly = {
    id: 'c2', type: 'track', title: 'Track', subtitle: 'Subtitle Artist',
    raw: { recommendation: { identity: 'id-c2', source: 'discover' } },
  } as CatalogItem;
  expect(catalogFeedback(subtitleOnly)?.item.artist).toBe('Subtitle Artist');
});

it('lists only other online devices and asks the chosen one to play the library song', async () => {
  mocks.request.mockResolvedValueOnce({ devices: [
    { device_id: 'self', device_name: 'This phone', socket_active: true },
    { device_id: 'laptop', device_name: 'Laptop', socket_active: true },
    { device_id: 'tablet', device_name: 'Tablet', socket_active: false },
  ] }).mockResolvedValueOnce({ status: 'ok' });
  const progress = { update: vi.fn(), dismiss: vi.fn() }; mocks.toast.loading.mockReturnValue(progress);
  await openNativePlayOnDevice(song, async () => 'self', () => true);
  const menu = mocks.menu.mock.calls[0][0];
  expect(menu.actions.map((action: { label: string }) => action.label)).toEqual(['Laptop']);
  menu.actions[0].onSelect(); await flush();
  expect(mocks.request.mock.calls[1]).toEqual(['/api/playback/remote-command', expect.objectContaining({ body: { device_id: 'laptop', command: 'play', track_id: 'song', track: song } })]);
  expect(progress.update).toHaveBeenCalledWith('success', 'deviceSheet.playingOn');
});

it('says so when there is nowhere to play', async () => {
  mocks.request.mockResolvedValueOnce({ devices: [{ device_id: 'self', socket_active: true }] });
  await openNativePlayOnDevice(song, async () => 'self', () => true);
  expect(mocks.toast.info).toHaveBeenCalledWith('deviceSheet.emptyOthers'); expect(mocks.menu).not.toHaveBeenCalled();
});

it.each([
  { ...song, id: 'dQw4w9WgXcQ', source: 'preview' as const },
  { ...song, source: 'preview' as const, media_kind: 'podcast_episode', podcast_enclosure_url: 'https://example.com/episode.mp3' },
])('sends portable previews and podcast episodes without acquiring them', async track => {
  mocks.request.mockResolvedValue({ devices: [{ device_id: 'laptop', socket_active: true }] });
  mocks.toast.loading.mockReturnValue({ update: vi.fn(), dismiss: vi.fn() });
  await openNativePlayOnDevice(track, async () => 'self', () => true);
  mocks.menu.mock.calls[0][0].actions[0].onSelect(); await flush();
  expect(mocks.request.mock.calls[1][1].body).toEqual({ device_id: 'laptop', command: 'play', track_id: track.id, track });
});
