import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MigrationJob } from './migrationApi';

const { actions, confirmDialog, getArtistDiscography } = vi.hoisted(() => ({
  actions: { setSongsSaved: vi.fn(async () => true) },
  confirmDialog: vi.fn(async () => true),
  getArtistDiscography: vi.fn(),
}));

vi.mock('../stores', () => ({ actions }));
vi.mock('./savedEntities', () => ({ setEntitySaved: vi.fn() }));
vi.mock('./confirm', () => ({ confirmDialog }));
vi.mock('./api', () => ({ api: { getArtistDiscography } }));
vi.mock('./i18n', () => ({ t: (key: string) => key }));

import { collectionStep, discographyOf, saveCollection } from './collection';
import { setEntitySaved } from './savedEntities';

const job = (state: string, counts: Record<string, number> = {}) => ({ state, selected_counts: counts } as unknown as MigrationJob);
const song = (n: number) => ({
  id: `deezer:track:${n}`, type: 'track' as const, source: 'deezer', title: `Song ${n}`, artist: 'A',
  external_ids: { deezer_id: String(n) },
});
const album = { kind: 'album' as const, name: 'Discovery', artist: 'Daft Punk', destination: '/album/Discovery?artist=Daft+Punk&deezer_id=302127' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('collectionStep', () => {
  it('moves through download, downloading, review and owned', () => {
    const base = { total: 3, owned: 1, job: null };
    expect(collectionStep(base)).toBe('download');
    expect(collectionStep({ ...base, job: job('running') })).toBe('downloading');
    expect(collectionStep({ ...base, job: job('needs_review', { needs_review: 1 }) })).toBe('review');
    expect(collectionStep({ ...base, owned: 3, job: job('running') })).toBe('owned');
  });

  it('offers ⬇ again for songs that failed, but not for songs never found', () => {
    const base = { total: 3, owned: 2 };
    expect(collectionStep({ ...base, job: job('partial', { failed: 1 }) })).toBe('download');
    expect(collectionStep({ ...base, job: job('partial', { unavailable: 1 }) })).toBe('missing');
    expect(collectionStep({ ...base, owned: 1, job: job('partial', { unavailable: 1 }) })).toBe('download');
  });
});

describe('bulk song saving is separate from bookmarks', () => {
  const artist = { kind: 'artist' as const, name: 'Daft Punk', destination: '/artist/Daft%20Punk?deezer_id=27' };

  it.each([album, artist])('adds songs only after confirmation for $kind', async (entity) => {
    await saveCollection(entity, [song(1), song(2)]);
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ message: 'collectionControl.addSongsMessage' }));
    expect(actions.setSongsSaved).toHaveBeenCalledWith([
      expect.objectContaining({ keys: ['cat:deezer:track:1', 'deezer:1'] }),
      expect.objectContaining({ keys: ['cat:deezer:track:2', 'deezer:2'] }),
    ], true);
    expect(setEntitySaved).not.toHaveBeenCalled();
  });

  it.each([album, artist])('changes nothing when bulk saving $kind is cancelled', async (entity) => {
    confirmDialog.mockResolvedValueOnce(false);
    await saveCollection(entity, [song(1)]);
    expect(actions.setSongsSaved).not.toHaveBeenCalled();
    expect(setEntitySaved).not.toHaveBeenCalled();
  });

  it('does not ask or save when no songs are available', async () => {
    await saveCollection(artist, []);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(actions.setSongsSaved).not.toHaveBeenCalled();
    expect(setEntitySaved).not.toHaveBeenCalled();
  });

  it('reads the artist discography for an explicit bulk action', async () => {
    getArtistDiscography.mockResolvedValue({ tracklist: [song(2)] });
    expect(await discographyOf('27')).toEqual([song(2)]);
    expect(getArtistDiscography).toHaveBeenCalledWith('27');
  });
});
