import { beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({
  saved: false, favourite: false, downloading: false, owned: undefined as object | undefined,
  state: { autoMode: { active: false } },
  actions: { toggleFavourite: vi.fn(), toggleSaved: vi.fn(), downloadSaved: vi.fn(), startRadio: vi.fn(), linkCatalogItem: vi.fn() },
  buildTrackMenu: vi.fn(() => []),
  sendDiscoveryNotInterested: vi.fn(),
  resolveCatalogItem: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../stores', () => ({
  state: store.state,
  actions: store.actions,
  isSavedKeys: () => store.saved, isFavouriteKeys: () => store.favourite,
  isDownloadingKeys: () => store.downloading, ownedTrackForKeys: () => store.owned,
}));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('./trackActions', () => ({
  buildTrackMenu: store.buildTrackMenu,
  musicLinkActions: () => [],
  sendDiscoveryNotInterested: store.sendDiscoveryNotInterested,
}));
vi.mock('../lib/api', () => ({ api: { resolveCatalogItem: store.resolveCatalogItem } }));
vi.mock('../lib/toast', () => ({ toast: { error: store.toastError } }));
vi.mock('./PlaylistPicker', () => ({ openPlaylistPicker: vi.fn() }));
vi.mock('./DeviceSheet', () => ({ openPlayOnDevice: vi.fn() }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: vi.fn() }));
import { buildEntryMenu } from './entryActions';
import { openPlayOnDevice } from './DeviceSheet';

const entry = { keys: ['deezer:42'], title: 'Unresolved song', artist: 'Artist' };
beforeEach(() => { store.saved = false; store.favourite = false; store.downloading = false; store.owned = undefined; store.state.autoMode.active = false; vi.clearAllMocks(); store.buildTrackMenu.mockReturnValue([]); });

describe('mobile entry menus', () => {
  it('opens unresolved catalogue actions without resolving or saving, and preserves their original keys', () => {
    const list = buildEntryMenu(entry);
    expect(list.map((action) => action.label)).toEqual(['collection.save', 'collection.download', 'trackActions.playOnDevice', 'trackActions.startRadio']);
    expect(store.actions.toggleSaved).not.toHaveBeenCalled();
    list[0].onSelect(); expect(store.actions.toggleSaved).toHaveBeenCalledWith(entry);
    list[1].onSelect(); expect(store.actions.downloadSaved).toHaveBeenCalledWith(entry);
    list[2].onSelect(); expect(openPlayOnDevice).toHaveBeenCalledWith(expect.objectContaining({ source: 'preview',
      originKeys: entry.keys, pendingResolve: { catalogItemId: 'deezer:42', artist: 'Artist', title: 'Unresolved song', duration: undefined } }));
  });
  it('exposes recommendation reason, Not interested with deezer_id, and Start radio on unresolved catalog items', async () => {
    const onNotInterested = vi.fn();
    const onUndoNotInterested = vi.fn();
    store.resolveCatalogItem.mockResolvedValueOnce({ video_id: 'dQw4w9WgXcQ' });
    const list = buildEntryMenu(entry, {
      item: {
        id: 'deezer:42',
        title: 'Unresolved song',
        artist: 'Artist',
        source: 'deezer',
        type: 'track',
        external_ids: { deezer_id: '42', isrc: 'USRC17607839' },
      },
      recommendation: { identity: 'music:deezer:42', source: 'discover', reason: 'More from Artist' },
      onNotInterested,
      onUndoNotInterested,
    });
    expect(list.map((action) => [action.label, Boolean(action.disabled)])).toEqual([
      ['collection.save', false],
      ['collection.download', false],
      ['trackActions.playOnDevice', false],
      ['trackActions.startRadio', false],
      ['More from Artist', true],
      ['trackActions.notInterested', false],
    ]);
    list[3].onSelect();
    await vi.waitFor(() => expect(store.resolveCatalogItem).toHaveBeenCalledWith({ artist: 'Artist', title: 'Unresolved song', duration: undefined }, undefined));
    await vi.waitFor(() => expect(store.actions.startRadio).toHaveBeenCalledWith(expect.objectContaining({ id: 'dQw4w9WgXcQ' })));
    list[5].onSelect();
    expect(store.sendDiscoveryNotInterested).toHaveBeenCalledWith(
      expect.objectContaining({
        media_type: 'music_track',
        deezer_id: '42',
        isrc: 'USRC17607839',
        title: 'Unresolved song',
        artist: 'Artist',
        source: 'discover',
      }),
      { onDismissed: onNotInterested, onUndone: onUndoNotInterested },
    );
  });
  it('forwards recommendation and dismissal hooks to buildTrackMenu for resolved tracks without duplicates', () => {
    store.owned = { id: 'local', title: entry.title, artist: entry.artist };
    const onNotInterested = vi.fn();
    const onUndoNotInterested = vi.fn();
    buildEntryMenu(entry, {
      recommendation: { identity: 'music:track:local', source: 'discover', reason: 'In your library' },
      onNotInterested,
      onUndoNotInterested,
    });
    expect(store.buildTrackMenu).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local', recommendation: { identity: 'music:track:local', source: 'discover', reason: 'In your library' } }),
      expect.objectContaining({ onNotInterested, onUndoNotInterested }),
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
