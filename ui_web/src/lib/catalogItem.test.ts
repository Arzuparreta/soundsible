import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogItem } from '../types/music';

const mocks = vi.hoisted(() => ({
  epoch: 1,
  state: { library: [], autoMode: { active: true } },
  resolve: vi.fn(),
  request: vi.fn(),
  reference: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('./api', () => ({ api: { resolveCatalogItem: mocks.resolve } }));
vi.mock('../stores', () => ({
  state: mocks.state,
  isPlayingItem: () => false,
  actions: {
    autoSessionToken: () => mocks.epoch,
    linkCatalogItem: vi.fn(),
    placeAutoTracks: mocks.request,
    addAutoSource: mocks.reference,
  },
}));
vi.mock('./toast', () => ({ toast: {
  loading: () => ({ dismiss: mocks.dismiss }), error: mocks.error, success: vi.fn(),
} }));

import { useCatalogCollection } from './catalogItem';

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
