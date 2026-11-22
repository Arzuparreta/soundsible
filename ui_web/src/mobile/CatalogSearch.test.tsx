import { beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { setLocale } from '../lib/i18n';
import type { CatalogItem, CatalogSearchResponse, SavedEntry, Track } from '../types/music';
import CatalogSearch from './CatalogSearch';
import { dispatchNavigationBack } from './backNavigation';
import { createSearchHistoryStorage } from '../lib/searchHistoryStorage';
const mocks = vi.hoisted(() => ({ search: vi.fn(), resolve: vi.fn(), save: vi.fn(), menu: vi.fn(), feed: vi.fn(), emitDiscoveryEvent: vi.fn(), artist: vi.fn(), album: vi.fn(), albumJob: vi.fn(), artistJob: vi.fn(), request: vi.fn(), toastAction: vi.fn(), toastError: vi.fn(), toastInfo: vi.fn(), toastLoading: vi.fn() }));
vi.mock('../lib/api', async () => ({ ApiError: (await import('../lib/http')).ApiError, api: { searchCatalog: mocks.search, resolveCatalogItem: mocks.resolve, setSavedEntries: mocks.save, getDiscoveryMusicFeed: mocks.feed, emitDiscoveryEvent: mocks.emitDiscoveryEvent, getArtistProfile: mocks.artist, getAlbumProfile: mocks.album, getAlbumDownload: mocks.albumJob, getArtistDownload: mocks.artistJob } }));
vi.mock('../lib/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/http')>();
  return { ...actual, request: mocks.request };
});
vi.mock('../lib/toast', () => ({
  toast: { action: mocks.toastAction, error: mocks.toastError, info: mocks.toastInfo, loading: mocks.toastLoading },
}));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: mocks.menu }));
const row: CatalogItem = { id: 'deezer:track:1', title: 'Song', artist: 'Artist', source: 'deezer', type: 'track', duration: 120, external_ids: { deezer_id: '1' } };
const result = (items: CatalogItem[]): CatalogSearchResponse => ({ query: 'song', items, sections: [] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { cleanup(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); setLocale('en'); vi.clearAllMocks(); mocks.search.mockResolvedValue(result([row])); mocks.resolve.mockResolvedValue({ video_id: 'A1111111111' }); mocks.save.mockResolvedValue(undefined); mocks.feed.mockResolvedValue({}); mocks.emitDiscoveryEvent.mockResolvedValue({ status: 'recorded', recorded: true }); mocks.albumJob.mockResolvedValue({ job: null }); mocks.artistJob.mockResolvedValue({ job: null }); mocks.artist.mockResolvedValue({ name: 'Artist', resolved: true, candidates: [], top_tracks: [], albums: [], singles_eps: [], related_artists: [], in_library: false, cached: false }); mocks.album.mockResolvedValue({ title: 'Album', artist: 'Artist', cover: '', tracklist: [], resolved: true, in_library: false, cached: false }); });
it('executes an owned recent query and removes it reactively without creating playback', async () => {
  localStorage.clear();
  const history = createSearchHistoryStorage(key => `native-member:${key}`);
  history.remember('music', 'previous');
  const play = vi.fn();
  const view = render(() => <CatalogSearch history={history} generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={play} onChanged={vi.fn()} />);
  fireEvent.click(view.getByRole('button', { name: 'previous' }));
  await waitFor(() => expect(mocks.search).toHaveBeenCalledWith('previous', expect.any(AbortSignal), 'track,library_track,artist,album'));
  fireEvent.input(view.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.click(view.getByRole('button', { name: 'Remove “previous” from recent searches' }));
  expect(view.queryByRole('button', { name: 'previous' })).toBeNull();
  expect(play).not.toHaveBeenCalled();
});
it('discards stale queries even when a provider ignores abort', async () => {
  const old = deferred<CatalogSearchResponse>();
  mocks.search.mockImplementation((query: string) => query === 'old' ? old.promise : Promise.resolve(result([{ ...row, title: 'New song' }])));
  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'old' } });
  await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1));
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'new' } });
  await waitFor(() => expect(view.getByText('New song')).toBeTruthy());
  old.resolve(result([row])); await Promise.resolve();
  expect(view.queryByText('Song')).toBeNull();
  expect(mocks.search.mock.calls[0][1].aborted).toBe(true);
});
it('cancels an obsolete resolution before it can replace the native program', async () => {
  const resolved = deferred<{ video_id: string }>(); mocks.resolve.mockReturnValue(resolved.promise);
  const play = vi.fn();
  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={play} onChanged={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'song' } });
  await waitFor(() => expect(view.getByText('Song')).toBeTruthy());
  fireEvent.click(view.container.querySelector('[data-row-main]')!);
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'other' } });
  resolved.resolve({ video_id: 'A1111111111' }); await Promise.resolve();
  expect(play).not.toHaveBeenCalled();
  expect(mocks.resolve.mock.calls[0][1].aborted).toBe(true);
});
it('saves exact resolved identity only after server confirmation, without acquisition', async () => {
  const saved = deferred<void>(); mocks.save.mockReturnValue(saved.promise);
  const changed = vi.fn().mockResolvedValue(undefined);
  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={vi.fn()} onChanged={changed} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'song' } });
  await waitFor(() => expect(view.getByText('Song')).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: 'More options: Song' }));
  const action = mocks.menu.mock.calls[0][0].actions[1]; expect(action.selected).toBe(false); action.onSelect();
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  expect(mocks.save.mock.calls[0][0][0].keys).toContain('yt:A1111111111');
  expect(mocks.save.mock.calls[0][1]).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  saved.resolve(); await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(view.container.querySelector('audio')).toBeNull();
});
it('removes a saved bookmark without resolving or deleting audio', async () => {
  const entry: SavedEntry = { title: 'Song', artist: 'Artist', keys: ['deezer:1', 'yt:A1111111111'] };
  const changed = vi.fn().mockResolvedValue(undefined);
  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[entry]} disconnected={false} onPlay={vi.fn()} onChanged={changed} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'song' } });
  await waitFor(() => expect(view.getByText('Song')).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: 'More options: Song' }));
  const action = mocks.menu.mock.calls[0][0].actions[1]; expect(action.selected).toBe(true); action.onSelect();
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.save.mock.calls[0][1]).toBe(false);
});
it('invalidates deferred menu actions when the account changes', async () => {
  const [generation, setGeneration] = createSignal(1);
  const view = render(() => <CatalogSearch generation={generation()} tracks={[]} saved={[]} disconnected={false} onPlay={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'song' } });
  await waitFor(() => expect(view.getByText('Song')).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: 'More options: Song' }));
  const action = mocks.menu.mock.calls[0][0].actions[1]; setGeneration(2); action.onSelect();
  expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});
it('recognizes confirmed saved identity for native highlighting and replay without rematching', async () => {
  const track: Track = { id: 'C1111111111', title: 'Song', artist: 'Artist', source: 'preview', originKeys: ['cat:deezer:track:1', 'deezer:1', 'yt:C1111111111'] };
  const play = vi.fn();
  const view = render(() => <CatalogSearch generation={1} tracks={[track]} saved={[]} disconnected={false} activeId="C1111111111" onPlay={play} onChanged={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'song' } });
  await waitFor(() => expect(view.getByText('Song')).toBeTruthy());
  expect(view.container.querySelector('[data-now-playing]')).toBeTruthy();
  fireEvent.click(view.container.querySelector('[data-row-main]')!);
  expect(play).toHaveBeenCalledWith(track); expect(mocks.resolve).not.toHaveBeenCalled();
});
it('reports an invalid provider identity instead of acknowledging nonexistent playback', async () => {
  mocks.search.mockResolvedValue(result([{ ...row, source: 'youtube', raw: { id: 'invalid' } }]));
  const play = vi.fn();
  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={play} onChanged={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'song' } });
  await waitFor(() => expect(view.getByText('Song')).toBeTruthy());
  fireEvent.click(view.container.querySelector('[data-row-main]')!);
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
  expect(play).not.toHaveBeenCalled();
});

it('opens feed entities and nested discography without playing, and returns to the same feed', async () => {
  const scrollContainer = document.createElement('main'); scrollContainer.scrollTop = 321;
  const play = vi.fn(), entityMenu = vi.fn();
  mocks.feed.mockResolvedValue({ browse_sections: [{ id: 'artists', popular: false, items: [{ id: 'artist:11', type: 'artist', source: 'deezer', title: 'Artist', external_ids: { deezer_artist_id: '11' } }] }] });
  mocks.artist.mockResolvedValue({ name: 'Artist', deezer_id: '11', resolved: true, candidates: [], top_tracks: [], albums: [{ deezer_id: '21', title: 'Record', cover: '', year: 2001 }], singles_eps: [], related_artists: [], in_library: false, cached: false });
  const view = render(() => <CatalogSearch scrollTarget={() => scrollContainer} generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={play} onChanged={vi.fn()} onEntityMenu={entityMenu} />);
  await waitFor(() => expect(view.getByRole('button', { name: 'Artist' })).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: 'Artist' }));
  await waitFor(() => expect(mocks.artist).toHaveBeenCalledWith('Artist', '11', expect.any(AbortSignal)));
  await waitFor(() => expect(view.getByRole('button', { name: /Record/ })).toBeTruthy());
  expect(play).not.toHaveBeenCalled();
  await waitFor(() => expect(scrollContainer.scrollTop).toBe(0)); scrollContainer.scrollTop = 87;
  fireEvent.click(view.getByRole('button', { name: /Record/ }));
  await waitFor(() => expect(mocks.album).toHaveBeenCalledWith('Record', 'Artist', '21', expect.any(AbortSignal)));
  await waitFor(() => expect(scrollContainer.scrollTop).toBe(0));
  expect(dispatchNavigationBack()).toBe(true);
  await waitFor(() => expect(view.getByRole('heading', { name: 'Artist' })).toBeTruthy());
  await waitFor(() => expect(scrollContainer.scrollTop).toBe(87));
  expect(dispatchNavigationBack()).toBe(true);
  await waitFor(() => expect(view.getByRole('button', { name: 'Artist' })).toBeTruthy());
  await waitFor(() => expect(scrollContainer.scrollTop).toBe(321));
  expect(mocks.feed).toHaveBeenCalledTimes(1); expect(mocks.save).not.toHaveBeenCalled(); expect(entityMenu).not.toHaveBeenCalled();
});
it('searches songs, artists and albums while preserving the query after an entity visit', async () => {
  mocks.search.mockResolvedValue(result([{ id: 'album:21', type: 'album', source: 'deezer', title: 'Record', artist: 'Artist', external_ids: { deezer_album_id: '21' } }, row]));
  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'record' } });
  await waitFor(() => expect(view.getByText('Record')).toBeTruthy());
  fireEvent.click(view.getByText('Record'));
  await waitFor(() => expect(mocks.album).toHaveBeenCalledWith('Record', 'Artist', '21', expect.any(AbortSignal)));
  expect(dispatchNavigationBack()).toBe(true);
  expect(view.getByRole('searchbox')).toHaveValue('record'); expect(view.getByText('Song')).toBeTruthy();
});
it('uses the shared native song menu for held results so offline and library actions stay available', async () => {
  const track: Track = { id: 'held', title: 'Held', artist: 'Artist' }, menu = vi.fn();
  mocks.search.mockResolvedValue(result([{ ...row, title: 'Held', type: 'library_track', source: 'library', track_id: 'held' }]));
  const view = render(() => <CatalogSearch generation={1} tracks={[track]} saved={[]} disconnected={false} onResolvedMenu={menu} onPlay={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'held' } });
  await waitFor(() => expect(view.getByText('Held')).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: 'More options: Held' }));
  expect(menu.mock.calls[0][0]).toBe(track); expect(mocks.menu).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
});
it('keeps explicit catalog save actions when a resolved preview uses the shared song menu', async () => {
  const menu = vi.fn(), changed = vi.fn().mockResolvedValue(undefined);
  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[]} disconnected={false}
    onResolvedMenu={menu} onPlay={vi.fn().mockResolvedValue(undefined)} onChanged={changed} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'song' } });
  await waitFor(() => expect(view.getByText('Song')).toBeTruthy());
  fireEvent.click(view.container.querySelector('[data-row-main]')!);
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce());
  await waitFor(() => expect(view.getByRole('button', { name: 'More options: Song' })).not.toBeDisabled());
  fireEvent.click(view.getByRole('button', { name: 'More options: Song' }));
  const actions = menu.mock.calls[0][2];
  expect(actions.map((action: { label: string }) => action.label)).toEqual(['Play', 'Save to your library']);
  await actions[1].onSelect();
  await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.save.mock.calls[0][0][0].keys).toContain('deezer:1');
});
it('opens an artist asked for from a song menu once, and Back returns to search', async () => {
  mocks.feed.mockResolvedValue({});
  mocks.artist.mockResolvedValue({ name: 'Artist', deezer_id: '11', resolved: true, candidates: [], top_tracks: [], albums: [], singles_eps: [], related_artists: [], in_library: false, cached: false });
  const handled = vi.fn();
  const [request, setRequest] = createSignal<{ path: string; id: number } | null>({ path: '/artist/Artist?view=discover&deezer_id=11', id: 1 });
  const view = render(() => <CatalogSearch openRequest={request()} onRequestHandled={id => { handled(id); setRequest(null); }} generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(mocks.artist).toHaveBeenCalledWith('Artist', '11', expect.any(AbortSignal)));
  expect(handled).toHaveBeenCalledExactlyOnceWith(1);
  expect(dispatchNavigationBack()).toBe(true);
  await waitFor(() => expect(view.getByRole('searchbox')).toBeVisible());
  setRequest({ path: '/artist/Artist?view=discover&deezer_id=11', id: 1 });
  expect(mocks.artist).toHaveBeenCalledTimes(1);
});
it('adds artist links and "not interested" to a recommended song that has not resolved yet', async () => {
  const recommended = { ...row, album: 'Record', raw: { recommendation: { identity: 'r1', source: 'discover', reason: 'Because you played Artist' } } } as CatalogItem;
  mocks.feed.mockResolvedValue({ items: [{ id: recommended.id, title: 'Song', artist: 'Artist', album: 'Record', external_ids: { deezer_id: '1' }, recommendation_identity: 'r1', reason: 'Because you played Artist' }] });
  const startRadio = vi.fn().mockResolvedValue(undefined);
  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[]} disconnected={false} onStartRadio={startRadio} onPlay={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(view.getByText('Song')).toBeTruthy());
  fireEvent.contextMenu(view.getByText('Song'));
  await waitFor(() => expect(mocks.menu).toHaveBeenCalled());
  const actions = mocks.menu.mock.calls.at(-1)![0].actions as Array<{ label: string; onSelect: () => void }>;
  expect(actions.map(action => action.label)).toEqual(expect.arrayContaining(['Start radio', 'Go to artist', 'Go to album', 'Because you played Artist', 'Not interested', 'Less from this artist']));

  mocks.request
    .mockResolvedValueOnce({ recorded: true, event_id: 'ev-deezer-1' })
    .mockResolvedValueOnce({ undone: true });
  actions.find(action => action.label === 'Not interested')!.onSelect();
  await waitFor(() => expect(view.queryByText('Song')).toBeNull());
  expect(mocks.request).toHaveBeenCalledWith('/api/discovery/feedback', expect.objectContaining({
    method: 'POST',
    body: expect.objectContaining({
      feedback: 'not_interested',
      item: expect.objectContaining({ deezer_id: '1', title: 'Song', artist: 'Artist', source: 'discover' }),
    }),
  }));

  const undo = mocks.toastAction.mock.calls[0][2];
  undo();
  await waitFor(() => expect(view.getByText('Song')).toBeTruthy());
  expect(mocks.request).toHaveBeenCalledWith('/api/discovery/feedback/ev-deezer-1', { method: 'DELETE', timeoutMs: 5000 });

  actions.find(action => action.label === 'Start radio')!.onSelect();
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalled());
  await waitFor(() => expect(startRadio).toHaveBeenCalledWith(expect.objectContaining({ id: 'A1111111111', title: 'Song', artist: 'Artist' })));
});

it('hides all songs by an artist in Android Discover on "Less from this artist" and restores on Undo', async () => {
  mocks.feed.mockResolvedValue({
    items: [
      { id: 'deezer:1', title: 'Track One', artist: 'Same Artist', external_ids: { deezer_id: '1', deezer_artist_id: '50' }, recommendation_identity: 'r1', reason: 'Recommended' },
      { id: 'deezer:2', title: 'Track Two', artist: 'Same Artist', external_ids: { deezer_id: '2', deezer_artist_id: '50' }, recommendation_identity: 'r2', reason: 'Recommended' },
      { id: 'deezer:3', title: 'Other Track', artist: 'Other Artist', external_ids: { deezer_id: '3', deezer_artist_id: '51' }, recommendation_identity: 'r3', reason: 'Recommended' },
    ],
  });
  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(view.getByText('Track One')).toBeTruthy());
  expect(view.getByText('Track Two')).toBeTruthy();

  fireEvent.contextMenu(view.getByText('Track One'));
  await waitFor(() => expect(mocks.menu).toHaveBeenCalled());
  const actions = mocks.menu.mock.calls.at(-1)![0].actions as Array<{ label: string; onSelect: () => void }>;
  mocks.request
    .mockResolvedValueOnce({ recorded: true, event_id: 'ev-artist-1' })
    .mockResolvedValueOnce({ undone: true });
  actions.find(action => action.label === 'Less from this artist')!.onSelect();

  await waitFor(() => expect(view.queryByText('Track One')).toBeNull());
  expect(view.queryByText('Track Two')).toBeNull();
  expect(view.getByText('Other Track')).toBeTruthy();
  expect(mocks.request).toHaveBeenCalledWith('/api/discovery/feedback', expect.objectContaining({
    method: 'POST',
    body: expect.objectContaining({
      feedback: 'less_from_artist',
      item: expect.objectContaining({ artist: 'Same Artist', deezer_artist_id: '50' }),
    }),
  }));

  const undo = mocks.toastAction.mock.calls.at(-1)![2];
  undo();
  await waitFor(() => expect(view.getByText('Track One')).toBeTruthy());
  expect(view.getByText('Track Two')).toBeTruthy();
});

it('renders the Discover refresh control beside the Android search bar and hides it while searching', async () => {
  mocks.feed
    .mockResolvedValueOnce({ items: [{ id: 'deezer:1', title: 'First Pick', artist: 'Artist One' }] })
    .mockResolvedValueOnce({ items: [{ id: 'deezer:2', title: 'Second Pick', artist: 'Artist Two' }] });

  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(view.getByText('First Pick')).toBeTruthy());

  const refreshBtn = view.getByRole('button', { name: 'Refresh' });
  expect(refreshBtn.closest('[data-testid="search-discovery"]')).toBeNull();
  fireEvent.click(refreshBtn);
  await waitFor(() => expect(view.getByText('Second Pick')).toBeTruthy());
  expect(mocks.feed.mock.calls[1][1]).toBe(true);

  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'song' } });
  expect(view.queryByRole('button', { name: 'Refresh' })).toBeNull();
});

it('shows the passive cold-start hint on Android and emits music_search_played on search playback', async () => {
  mocks.feed.mockResolvedValue({
    needs_seed: true,
    browse_sections: [{ id: 'artists', popular: true, items: [{ id: 'artist:1', title: 'Popular', type: 'artist', source: 'deezer' }] }],
  });
  const play = vi.fn().mockResolvedValue(undefined);
  const view = render(() => <CatalogSearch generation={1} tracks={[]} saved={[]} disconnected={false} onPlay={play} onChanged={vi.fn()} />);

  await waitFor(() => expect(view.getByRole('note')).toBeTruthy());
  expect(mocks.emitDiscoveryEvent).not.toHaveBeenCalled();

  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'song' } });
  await waitFor(() => expect(view.getByText('Song')).toBeTruthy());
  fireEvent.click(view.container.querySelector('[data-row-main]')!);
  expect(mocks.emitDiscoveryEvent).toHaveBeenCalledWith(
    'music_search_played',
    expect.objectContaining({ title: 'Song', artist: 'Artist', source: 'search' }),
  );
});
