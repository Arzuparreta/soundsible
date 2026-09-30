import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MigrationJob } from './migrationApi';

const { actions, bookmarks, confirmDialog, getAlbumProfile, held, toast } = vi.hoisted(() => ({
  actions: { setSongsSaved: vi.fn(async () => true) },
  bookmarks: new Set<string>(),
  confirmDialog: vi.fn(async () => true),
  getAlbumProfile: vi.fn(),
  held: new Map<string, { keys: string[]; favourite?: boolean }>(),
  toast: { action: vi.fn(), error: vi.fn() },
}));

vi.mock('../stores', () => ({
  actions,
  savedEntryForKeys: (keys: string[]) => keys.map((key) => held.get(key)).find(Boolean) ?? null,
}));
vi.mock('./savedEntities', () => ({
  isEntitySaved: (entity: { name: string }) => bookmarks.has(entity.name),
  setEntitySaved: vi.fn(async (entity: { name: string }, saved: boolean) => {
    if (saved) bookmarks.add(entity.name);
    else bookmarks.delete(entity.name);
  }),
}));
vi.mock('./confirm', () => ({ confirmDialog }));
vi.mock('./toast', () => ({ toast }));
vi.mock('./api', () => ({ api: { getAlbumProfile } }));
vi.mock('./i18n', () => ({ t: (key: string) => key }));

import { albumStep, albumTracklistFor, saveAlbum, toggleAlbumFromLink, unsaveAlbum } from './albumCollection';
import { setEntitySaved } from './savedEntities';

const job = (state: string, counts: Record<string, number> = {}) => ({ state, selected_counts: counts } as unknown as MigrationJob);
const song = (n: number) => ({
  id: `deezer:track:${n}`, type: 'track' as const, source: 'deezer', title: `Song ${n}`, artist: 'A',
  external_ids: { deezer_id: String(n) },
});
const album = { kind: 'album' as const, name: 'Discovery', artist: 'Daft Punk', destination: '/album/Discovery?artist=Daft+Punk&deezer_id=302127' };

beforeEach(() => {
  vi.clearAllMocks();
  bookmarks.clear();
  held.clear();
});

describe('albumStep', () => {
  it('moves through save, download, downloading, review and owned', () => {
    const base = { saved: true, total: 3, owned: 1, job: null };
    expect(albumStep({ ...base, saved: false })).toBe('save');
    expect(albumStep(base)).toBe('download');
    expect(albumStep({ ...base, job: job('running') })).toBe('downloading');
    expect(albumStep({ ...base, job: job('needs_review', { needs_review: 1 }) })).toBe('review');
    expect(albumStep({ ...base, owned: 3, job: job('running') })).toBe('owned');
  });

  it('offers ⬇ again for songs that failed, but not for songs never found', () => {
    const base = { saved: true, total: 3, owned: 2 };
    expect(albumStep({ ...base, job: job('partial', { failed: 1 }) })).toBe('download');
    expect(albumStep({ ...base, job: job('partial', { unavailable: 1 }) })).toBe('missing');
    expect(albumStep({ ...base, owned: 1, job: job('partial', { unavailable: 1 }) })).toBe('download');
  });
});

describe('saving and taking out an album', () => {
  it('keeps the record and puts its songs in the library', async () => {
    await saveAlbum(album, [song(1), song(2)]);
    expect(bookmarks.has('Discovery')).toBe(true);
    expect(actions.setSongsSaved).toHaveBeenCalledWith(
      [expect.objectContaining({ keys: ['cat:deezer:track:1', 'deezer:1'] }), expect.objectContaining({ keys: ['cat:deezer:track:2', 'deezer:2'] })],
      true,
    );
  });

  it('asks before taking streamed songs out, and offers to undo it all', async () => {
    bookmarks.add('Discovery');
    held.set('deezer:1', { keys: ['deezer:1'] });
    held.set('deezer:2', { keys: ['deezer:2'], favourite: true });

    await unsaveAlbum(album, [song(1), song(2)]);

    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ message: 'albumCollection.unsaveMessage' }));
    expect(bookmarks.has('Discovery')).toBe(false);
    expect(actions.setSongsSaved).toHaveBeenCalledWith(expect.any(Array), false);
    expect(setEntitySaved).toHaveBeenCalledWith(album, false, { quiet: true });
    toast.action.mock.calls[0][2]();
    await vi.waitFor(() => expect(bookmarks.has('Discovery')).toBe(true));
  });

  it('keeps everything when the listener says no', async () => {
    bookmarks.add('Discovery');
    held.set('deezer:1', { keys: ['deezer:1'] });
    confirmDialog.mockResolvedValueOnce(false);

    await unsaveAlbum(album, [song(1)]);

    expect(bookmarks.has('Discovery')).toBe(true);
    expect(actions.setSongsSaved).not.toHaveBeenCalled();
  });

  it('does not ask when nothing but the bookmark would go', async () => {
    bookmarks.add('Discovery');
    held.set('deezer:1', { keys: ['deezer:1', 'lib:file1'] });

    await unsaveAlbum(album, [song(1)]);

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(bookmarks.has('Discovery')).toBe(false);
  });

  it('reads the songs of an album saved from a card, and none for a library album', async () => {
    getAlbumProfile.mockResolvedValue({ resolved: true, tracklist: [song(1)] });
    await toggleAlbumFromLink(album);
    expect(getAlbumProfile).toHaveBeenCalledWith('Discovery', 'Daft Punk', '302127');
    expect(actions.setSongsSaved).toHaveBeenCalledWith([expect.objectContaining({ title: 'Song 1' })], true);

    expect(await albumTracklistFor({ ...album, destination: '/album/Discovery?artist=Daft+Punk&album_id=abc' })).toEqual([]);
  });
});
