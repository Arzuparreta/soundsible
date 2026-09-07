import { beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({
  saved: false, favourite: false, downloading: false, owned: undefined as object | undefined,
  actions: { toggleFavourite: vi.fn(), toggleSaved: vi.fn(), downloadSaved: vi.fn() },
}));
vi.mock('../stores', () => ({
  actions: store.actions,
  isSavedKeys: () => store.saved, isFavouriteKeys: () => store.favourite,
  isDownloadingKeys: () => store.downloading, ownedTrackForKeys: () => store.owned,
}));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('./trackActions', () => ({ buildTrackMenu: () => [] }));
vi.mock('./PlaylistPicker', () => ({ openPlaylistPicker: vi.fn() }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: vi.fn() }));
import { buildEntryMenu } from './entryActions';

const entry = { keys: ['deezer:42'], title: 'Unresolved song', artist: 'Artist' };
beforeEach(() => { store.saved = false; store.favourite = false; store.downloading = false; store.owned = undefined; vi.clearAllMocks(); });

describe('mobile entry menus', () => {
  it('opens unresolved catalogue actions without resolving or saving, and preserves their original keys', () => {
    const list = buildEntryMenu(entry);
    expect(list.map((action) => action.label)).toEqual(['collection.save', 'collection.download']);
    expect(store.actions.toggleSaved).not.toHaveBeenCalled();
    list[0].onSelect(); expect(store.actions.toggleSaved).toHaveBeenCalledWith(entry);
    list[1].onSelect(); expect(store.actions.downloadSaved).toHaveBeenCalledWith(entry);
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
});
