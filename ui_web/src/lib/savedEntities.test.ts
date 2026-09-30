import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { entitiesBusy, fillEntityCover, sameEntity, savedEntities, setSavedEntities, setEntitySaved, syncSavedEntities, type SavedEntity } from './savedEntities';
import { toast } from './toast';
import { pulseNavigation } from './tabNavigation';

vi.mock('./api', () => ({ api: { getSavedEntities: vi.fn(), setSavedEntity: vi.fn() } }));
vi.mock('./toast', () => ({ toast: { action: vi.fn(), error: vi.fn() } }));
vi.mock('./tabNavigation', () => ({ pulseNavigation: vi.fn() }));
const album = (id: string): SavedEntity => ({ kind: 'album', name: 'Greatest Hits', artist: 'Artist', destination: `/album/Greatest%20Hits?deezer_id=${id}` });
beforeEach(() => { vi.clearAllMocks(); setSavedEntities([]); });

describe('saved entities', () => {
  it('matches exact identities across views and preserves homonyms', () => {
    expect(sameEntity(album('1'), { ...album('1'), destination: album('1').destination + '&view=library' })).toBe(true);
    expect(sameEntity(album('1'), album('2'))).toBe(false);
    expect(sameEntity(album('1'), { ...album('1'), destination: '/album/Greatest%20Hits' })).toBe(false);
  });
  it('points at Library when a save lands, and only then', async () => {
    vi.mocked(api.setSavedEntity).mockResolvedValue([album('1')]);
    await setEntitySaved(album('1'), true);
    expect(pulseNavigation).toHaveBeenCalledWith(['/', '/?saved=albums']);
    expect(toast.action).not.toHaveBeenCalled();
    vi.mocked(pulseNavigation).mockClear();
    vi.mocked(api.setSavedEntity).mockResolvedValue([]);
    await setEntitySaved(album('1'), false);
    vi.mocked(api.setSavedEntity).mockRejectedValue(new Error('disk full'));
    await setEntitySaved(album('2'), true);
    expect(pulseNavigation).not.toHaveBeenCalled();
  });
  it('fills a missing picture quietly and never replaces one', async () => {
    setSavedEntities([album('1')]);
    const pictured = { ...album('1'), cover: 'https://example.org/cover.jpg' };
    vi.mocked(api.setSavedEntity).mockResolvedValue([pictured]);
    await fillEntityCover(pictured);
    expect(api.setSavedEntity).toHaveBeenCalledWith(pictured, true);
    expect(savedEntities()).toEqual([pictured]);
    expect(pulseNavigation).not.toHaveBeenCalled();
    await fillEntityCover({ ...album('1'), cover: 'https://example.org/other.jpg' });
    await fillEntityCover({ ...album('2'), cover: 'https://example.org/other.jpg' });
    expect(api.setSavedEntity).toHaveBeenCalledTimes(1);
    setSavedEntities([album('3')]);
    vi.mocked(api.setSavedEntity).mockRejectedValue(new Error('offline'));
    await fillEntityCover({ ...album('3'), cover: 'https://example.org/cover.jpg' });
    expect(savedEntities()).toEqual([album('3')]);
    expect(toast.error).not.toHaveBeenCalled();
    expect(entitiesBusy()).toBe(false);
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
