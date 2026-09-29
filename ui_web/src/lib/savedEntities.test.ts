import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { entitiesBusy, sameEntity, savedEntities, setSavedEntities, setEntitySaved, syncSavedEntities, type SavedEntity } from './savedEntities';
import { toast } from './toast';

vi.mock('./api', () => ({ api: { getSavedEntities: vi.fn(), setSavedEntity: vi.fn() } }));
vi.mock('./toast', () => ({ toast: { action: vi.fn(), error: vi.fn() } }));
const album = (id: string): SavedEntity => ({ kind: 'album', name: 'Greatest Hits', artist: 'Artist', destination: `/album/Greatest%20Hits?deezer_id=${id}` });
beforeEach(() => { vi.clearAllMocks(); setSavedEntities([]); });

describe('saved entities', () => {
  it('matches exact identities across views and preserves homonyms', () => {
    expect(sameEntity(album('1'), { ...album('1'), destination: album('1').destination + '&view=library' })).toBe(true);
    expect(sameEntity(album('1'), album('2'))).toBe(false);
    expect(sameEntity(album('1'), { ...album('1'), destination: '/album/Greatest%20Hits' })).toBe(false);
  });
  it('rolls back a failed write without losing other bookmarks', async () => {
    setSavedEntities([album('1')]);
    vi.mocked(api.setSavedEntity).mockRejectedValue(new Error('disk full'));
    await setEntitySaved(album('2'), true);
    expect(savedEntities()).toEqual([album('1')]);
    expect(toast.error).toHaveBeenCalled();
    expect(entitiesBusy()).toBe(false);
  });
  it('removes only the chosen entity and offers undo', async () => {
    setSavedEntities([album('1'), album('2')]);
    vi.mocked(api.setSavedEntity).mockResolvedValue([album('2')]);
    await setEntitySaved(album('1'), false);
    expect(savedEntities()).toEqual([album('2')]);
    expect(toast.action).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Function));
    vi.mocked(api.setSavedEntity).mockResolvedValue([album('1'), album('2')]);
    const undo = vi.mocked(toast.action).mock.calls[0][2];
    undo();
    await vi.waitFor(() => expect(savedEntities()).toHaveLength(2));
  });
  it('does not replace a new mutation with an older fetch', async () => {
    let finish!: (entries: SavedEntity[]) => void;
    vi.mocked(api.getSavedEntities).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const read = syncSavedEntities();
    await Promise.resolve();
    vi.mocked(api.setSavedEntity).mockResolvedValue([album('1')]);
    await setEntitySaved(album('1'), true);
    finish([]);
    await read;
    expect(savedEntities()).toEqual([album('1')]);
  });
});

it('refreshes an update from another device received during a write', async () => {
  let finish!: (entries: SavedEntity[]) => void;
  vi.mocked(api.setSavedEntity).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  vi.mocked(api.getSavedEntities).mockResolvedValue([album('2'), album('1')]);
  const write = setEntitySaved(album('1'), true);
  await syncSavedEntities();
  finish([album('1')]);
  await write;
  await vi.waitFor(() => expect(savedEntities()).toEqual([album('2'), album('1')]));
});
