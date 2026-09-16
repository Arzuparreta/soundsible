import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogItem } from '../types/music';

const mocks = vi.hoisted(() => ({
  epoch: 1,
  state: { library: [] as Array<{ id: string; title: string; artist: string }>, autoMode: { active: true } },
  playFrom: vi.fn(),
  playTrack: vi.fn(),
  resolve: vi.fn(),
  request: vi.fn(),
  reference: vi.fn(),
  change: vi.fn().mockResolvedValue(true),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('./api', () => ({ api: { resolveCatalogItem: mocks.resolve } }));
vi.mock('../stores', () => ({
  state: mocks.state,
  isPlayingItem: () => false,
  actions: {
    autoSessionToken: () => mocks.epoch,
    beginAutoSessionChange: () => ++mocks.epoch,
    changeAutoSession: mocks.change,
    linkCatalogItem: vi.fn(),
    placeAutoTracks: mocks.request,
    addAutoSource: mocks.reference,
    playFrom: mocks.playFrom,
    playTrack: mocks.playTrack,
  },
}));
vi.mock('./toast', () => ({ toast: {
  loading: () => ({ dismiss: mocks.dismiss }), error: mocks.error, success: vi.fn(),
} }));

import { playCatalogItem, useCatalogCollection } from './catalogItem';

const item = (index: number): CatalogItem => ({
  id: `catalog:${index}`, title: `Song ${index}`, artist: 'Artist', type: 'track', source: 'deezer',
});

describe('catalog collection commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch = 1;
    mocks.state.autoMode.active = true;
    mocks.resolve.mockImplementation(async ({ title }: { title: string }) => ({ video_id: title }));
  });

  it('requests the entire collection, retains repeated songs, and reports unresolved titles', async () => {
    mocks.resolve.mockImplementation(async ({ title }: { title: string }) => {
      if (title === 'Song 4') throw new Error('unavailable');
      return { video_id: title };
    });
    const items = [...Array.from({ length: 24 }, (_, index) => item(index)), item(0)];
    expect(await useCatalogCollection(items, 'Album', 'request', 'chosen-seam')).toBe(true);
    const [tracks, target] = mocks.request.mock.calls[0];
    expect(tracks.map((track: { id: string }) => track.id)).toEqual(items.filter((row) => row.title !== 'Song 4').map((row) => row.title));
    expect(target).toBe('chosen-seam');
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('Song 4'));
    expect(mocks.reference).not.toHaveBeenCalled();
  });

  it.each(['session', 'picker'] as const)('discards a late resolution after the %s changes', async (change) => {
    let finish!: (value: { video_id: string }) => void;
    let current = true;
    mocks.resolve.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = useCatalogCollection([item(0)], 'Album', 'reference', undefined, () => current);
    if (change === 'session') mocks.epoch += 1;
    else current = false;
    finish({ video_id: 'late-song' });
    expect(await pending).toBe(false);
    expect(mocks.reference).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.dismiss).toHaveBeenCalledOnce();
  });
});


describe('catalogue direction changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch = 1;
    mocks.state.autoMode.active = true;
  });

  it('does not change the session if the collection cannot be resolved', async () => {
    mocks.resolve.mockRejectedValue(new Error('unavailable'));
    expect(await useCatalogCollection([item(1)], 'Unavailable', 'change')).toBe(false);
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it('reserves the latest selection before resolution and discards the older result', async () => {
    let finishOld!: (value: { video_id: string }) => void;
    mocks.resolve.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce({ video_id: 'new' });
    const old = useCatalogCollection([item(1)], 'Old', 'change');
    const started = vi.fn();
    expect(await useCatalogCollection([item(2)], 'Latest', 'change', undefined, () => true, undefined, started)).toBe(true);
    finishOld({ video_id: 'old' });
    expect(await old).toBe(false);
    expect(mocks.change).toHaveBeenCalledOnce();
    expect(mocks.change).toHaveBeenCalledWith([expect.objectContaining({ id: 'new' })], 'Latest');
    expect(started).toHaveBeenCalledOnce();
    expect(mocks.reference).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe('playing a catalog row in its collection', () => {
  const album = { id: 'album:record', kind: 'album' as const, label: 'Record' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.autoMode.active = false;
    mocks.state.library = [{ id: 'owned', title: 'Song 1', artist: 'Artist' }];
    mocks.resolve.mockImplementation(async ({ title }: { title: string }) => ({ video_id: `vid-${title}` }));
  });

  it('plays from the tapped row and keeps every other row in its place, matched or not', async () => {
    const rows = [item(0), { ...item(1), track_id: 'owned' }, item(2), item(3)];
    await playCatalogItem(rows[2], rows, album);

    // Only the tapped row is matched before playback starts.
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    const [tracks, index, opts] = mocks.playFrom.mock.calls[0];
    expect(index).toBe(2);
    expect(tracks.map((track: { id: string }) => track.id))
      .toEqual(['pending:catalog:0', 'owned', 'vid-Song 2', 'pending:catalog:3']);
    expect(tracks[3].pendingResolve).toEqual({ catalogItemId: 'catalog:3', artist: 'Artist', title: 'Song 3' });
    expect(tracks[3].originKeys).toContain('cat:catalog:3');
    expect(opts).toEqual({ context: album });
  });

  it('starts at the row itself when it is already playable, without asking the engine', async () => {
    const rows = [item(0), { ...item(1), track_id: 'owned' }];
    await playCatalogItem(rows[1], rows, album);
    expect(mocks.resolve).not.toHaveBeenCalled();
    const [tracks, index] = mocks.playFrom.mock.calls[0];
    expect(index).toBe(1);
    expect(tracks.map((track: { id: string }) => track.id)).toEqual(['pending:catalog:0', 'owned']);
  });

  it('plays a row outside the list first, and a row on its own as a selection', async () => {
    const rows = [item(0)];
    await playCatalogItem(item(5), rows, album);
    expect(mocks.playFrom.mock.calls[0][1]).toBe(0);
    expect(mocks.playFrom.mock.calls[0][0].map((track: { id: string }) => track.id))
      .toEqual(['vid-Song 5', 'pending:catalog:0']);

    await playCatalogItem(item(6));
    expect(mocks.playTrack).toHaveBeenCalledWith(expect.objectContaining({ id: 'vid-Song 6' }));
  });
});
