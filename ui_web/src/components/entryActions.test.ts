import { beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({
  saved: false, favourite: false, downloading: false, owned: undefined as object | undefined,
  state: { autoMode: { active: false } },
  actions: { toggleFavourite: vi.fn(), toggleSaved: vi.fn(), downloadSaved: vi.fn(), startRadio: vi.fn(), linkCatalogItem: vi.fn() },
  buildTrackMenu: vi.fn(() => []),
  queueActions: vi.fn((track: object) => [
    { icon: 'next', label: 'trackActions.playNext', onSelect: () => store.queued.push(['next', track]) },
    { icon: 'queue', label: 'trackActions.addToQueue', onSelect: () => store.queued.push(['queue', track]) },
  ]),
  queued: [] as Array<[string, object]>,
  sendDiscoveryNotInterested: vi.fn(),
  sendDiscoveryLessFromArtist: vi.fn(),
  resolveCatalogItem: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../stores', () => ({
  state: store.state,
  actions: store.actions,
  isSavedKeys: () => store.saved, isFavouriteKeys: () => store.favourite,
  isDownloadingKeys: () => store.downloading, ownedTrackForKeys: () => store.owned,
  savedEntryForKeys: () => undefined,
}));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('./trackActions', () => ({
  buildTrackMenu: store.buildTrackMenu,
  collectionRemovalActions: () => [],
  queueActions: store.queueActions,
  musicLinkActions: () => [],
  sendDiscoveryNotInterested: store.sendDiscoveryNotInterested,
  sendDiscoveryLessFromArtist: store.sendDiscoveryLessFromArtist,
}));
vi.mock('../lib/api', () => ({ api: { resolveCatalogItem: store.resolveCatalogItem } }));
vi.mock('../lib/toast', () => ({ toast: { error: store.toastError } }));
vi.mock('./PlaylistPicker', () => ({ openPlaylistPicker: vi.fn() }));
vi.mock('./DeviceSheet', () => ({ openPlayOnDevice: vi.fn() }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: vi.fn() }));
import { buildEntryMenu } from './entryActions';
import { openPlayOnDevice } from './DeviceSheet';

const entry = { keys: ['deezer:42'], title: 'Unresolved song', artist: 'Artist' };
beforeEach(() => { store.saved = false; store.favourite = false; store.downloading = false; store.owned = undefined; store.state.autoMode.active = false; store.queued = []; vi.clearAllMocks(); store.buildTrackMenu.mockReturnValue([]); });

describe('mobile entry menus', () => {
  it('opens unresolved catalogue actions without resolving or saving, and preserves their original keys', () => {
    const list = buildEntryMenu(entry);
    expect(list.map((action) => action.label)).toEqual(['collection.save', 'collection.download', 'trackActions.playNext', 'trackActions.addToQueue', 'trackActions.playOnDevice', 'trackActions.startRadio']);
    expect(store.actions.toggleSaved).not.toHaveBeenCalled();
    list[0].onSelect(); expect(store.actions.toggleSaved).toHaveBeenCalledWith(entry);
    list[1].onSelect(); expect(store.actions.downloadSaved).toHaveBeenCalledWith(entry);
    list[4].onSelect(); expect(openPlayOnDevice).toHaveBeenCalledWith(expect.objectContaining({ source: 'preview',
      originKeys: entry.keys, pendingResolve: { catalogItemId: 'deezer:42', artist: 'Artist', title: 'Unresolved song', duration: undefined } }));
  });
  it('queues an unresolved catalogue row as a pending song, through the same queue pair as a library song', () => {
    const item = { id: 'deezer:42', title: 'Unresolved song', artist: 'Artist', source: 'deezer', type: 'track' } as const;
    const list = buildEntryMenu(entry, { item });
    const pending = expect.objectContaining({
      id: 'pending:deezer:42', title: 'Unresolved song', artist: 'Artist', source: 'preview',
      pendingResolve: { catalogItemId: 'deezer:42', artist: 'Artist', title: 'Unresolved song', duration: undefined },
    });
    expect(store.queueActions).toHaveBeenCalledWith(pending);
    list.find((action) => action.label === 'trackActions.playNext')!.onSelect();
    list.find((action) => action.label === 'trackActions.addToQueue')!.onSelect();
    expect(store.queued).toEqual([['next', pending], ['queue', pending]]);
    expect(store.resolveCatalogItem).not.toHaveBeenCalled();
  });
  it('leaves the queue pair out of an unresolved row inside a DJ session, as for a library song', () => {
    store.state.autoMode.active = true;
    const labels = buildEntryMenu(entry).map((action) => action.label);
    expect(labels).not.toContain('trackActions.playNext');
    expect(labels).not.toContain('trackActions.addToQueue');
    expect(labels).toContain('trackActions.playOnDevice');
  });
  it('exposes recommendation reason, Not interested, Less from this artist, and Start radio on unresolved catalog items', async () => {
    const onNotInterested = vi.fn();
    const onUndoNotInterested = vi.fn();
    const onLessFromArtist = vi.fn();
    const onUndoLessFromArtist = vi.fn();
    store.resolveCatalogItem.mockResolvedValueOnce({ video_id: 'dQw4w9WgXcQ' });
    const list = buildEntryMenu(entry, {
      item: {
        id: 'deezer:42',
        title: 'Unresolved song',
        artist: 'Artist',
        source: 'deezer',
        type: 'track',
        external_ids: { deezer_id: '42', deezer_artist_id: '77', isrc: 'USRC17607839' },
      },
      recommendation: { identity: 'music:deezer:42', source: 'discover', reason: 'More from Artist' },
      onNotInterested,
      onUndoNotInterested,
      onLessFromArtist,
      onUndoLessFromArtist,
    });
    expect(list.map((action) => [action.label, Boolean(action.disabled)])).toEqual([
      ['collection.save', false],
      ['collection.download', false],
      ['trackActions.playNext', false],
      ['trackActions.addToQueue', false],
      ['musicExplorer.startDjFromSong', false],
      ['trackActions.playOnDevice', false],
      ['trackActions.startRadio', false],
      ['More from Artist', true],
      ['trackActions.notInterested', false],
      ['trackActions.lessFromArtist', false],
    ]);
    list[6].onSelect();
    await vi.waitFor(() => expect(store.resolveCatalogItem).toHaveBeenCalledWith({ artist: 'Artist', title: 'Unresolved song', duration: undefined }, undefined));
    await vi.waitFor(() => expect(store.actions.startRadio).toHaveBeenCalledWith(expect.objectContaining({ id: 'dQw4w9WgXcQ' })));
    list[8].onSelect();
    expect(store.sendDiscoveryNotInterested).toHaveBeenCalledWith(
      expect.objectContaining({
        media_type: 'music_track',
        deezer_id: '42',
        deezer_artist_id: '77',
        isrc: 'USRC17607839',
        title: 'Unresolved song',
        artist: 'Artist',
        source: 'discover',
      }),
      { onDismissed: onNotInterested, onUndone: onUndoNotInterested },
    );
    list[9].onSelect();
    expect(store.sendDiscoveryLessFromArtist).toHaveBeenCalledWith(
      expect.objectContaining({
        deezer_id: '42',
        deezer_artist_id: '77',
        artist: 'Artist',
        source: 'discover',
      }),
      expect.objectContaining({ onDismissed: expect.any(Function), onUndone: expect.any(Function) }),
    );
    const hooks = store.sendDiscoveryLessFromArtist.mock.calls[0][1] as { onDismissed: () => void; onUndone: () => void };
    hooks.onDismissed();
    expect(onLessFromArtist).toHaveBeenCalledWith('Artist');
    hooks.onUndone();
    expect(onUndoLessFromArtist).toHaveBeenCalledWith('Artist');
  });
  it('forwards recommendation and dismissal hooks to buildTrackMenu for resolved tracks without duplicates', () => {
    store.owned = { id: 'local', title: entry.title, artist: entry.artist };
    const onNotInterested = vi.fn();
    const onUndoNotInterested = vi.fn();
    const onLessFromArtist = vi.fn();
    const onUndoLessFromArtist = vi.fn();
    buildEntryMenu(entry, {
      recommendation: { identity: 'music:track:local', source: 'discover', reason: 'In your library' },
      onNotInterested,
      onUndoNotInterested,
      onLessFromArtist,
      onUndoLessFromArtist,
    });
    expect(store.buildTrackMenu).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local', recommendation: { identity: 'music:track:local', source: 'discover', reason: 'In your library' } }),
      expect.objectContaining({ onNotInterested, onUndoNotInterested, onLessFromArtist, onUndoLessFromArtist }),
    );
  });
  it('uses the surface download handler and disables a pending download', () => {
    const download = vi.fn();
    buildEntryMenu(entry, { onDownload: download })[1].onSelect();
    expect(download).toHaveBeenCalledOnce(); expect(store.actions.downloadSaved).not.toHaveBeenCalled();
    store.downloading = true;
    expect(buildEntryMenu(entry)[1]).toMatchObject({ label: 'collection.downloading', disabled: true });
  });
  it('reflects current favourite state and omits download for an owned file', () => {
    store.saved = true; store.favourite = true; store.owned = { id: 'local', title: entry.title, artist: entry.artist };
    const list = buildEntryMenu(entry);
    expect(list.map((action) => action.label)).toEqual(['trackActions.removeFav']);
    list[0].onSelect(); expect(store.actions.toggleFavourite).toHaveBeenCalledWith(entry);
  });
  it('draws every collection action it adds', () => {
    expect(buildEntryMenu(entry).every((action) => action.icon)).toBe(true);
    store.saved = true;
    expect(buildEntryMenu(entry, { onRadio: vi.fn() }).every((action) => action.icon)).toBe(true);
  });
});
