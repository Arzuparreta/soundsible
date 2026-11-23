import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';

const apiMock = vi.hoisted(() => ({
  searchCatalog: vi.fn(),
  searchYouTube: vi.fn(),
  peekYouTube: vi.fn(),
}));
vi.mock('./api', () => ({ api: apiMock }));

import { createCatalogSearch } from './catalogSearch';
import { clearSearchCache, writeSearchCache } from './searchCache';
import { CATALOG_CACHE_NS } from './searchSections';

const song = { id: 's1', type: 'track', title: 'Song', artist: 'A' };
const artist = { id: 'a1', type: 'artist', title: 'A' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const withSearch = (options?: Parameters<typeof createCatalogSearch>[0]) =>
  createRoot((dispose) => ({ search: createCatalogSearch(options), dispose }));

beforeEach(() => {
  clearSearchCache();
  vi.clearAllMocks();
});
afterEach(() => clearSearchCache());

describe('createCatalogSearch', () => {
  it('keeps only the newest answer when an older request returns late', async () => {
    const first = deferred<unknown>();
    apiMock.searchCatalog.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ items: [artist], sections: [] });
    const { search, dispose } = withSearch();
    search.catalog('first');
    search.catalog('second');
    await vi.waitFor(() => expect(search.items()).toEqual([artist]));
    first.resolve({ items: [song], sections: [] });
    await Promise.resolve();
    expect(search.items()).toEqual([artist]);
    expect(search.loading()).toBe(false);
    dispose();
  });

  it('answers a cached query without a request', () => {
    writeSearchCache(CATALOG_CACHE_NS, 'cached', { items: [song], sections: [], interpretedAs: 'x' });
    const { search, dispose } = withSearch();
    search.catalog('cached');
    expect(apiMock.searchCatalog).not.toHaveBeenCalled();
    expect(search.items()).toEqual([song]);
    expect(search.interpretedAs()).toBe('x');
    dispose();
  });

  it('falls back to YouTube for songs only when asked to', async () => {
    apiMock.searchCatalog.mockResolvedValue({ items: [artist], sections: [] });
    apiMock.searchYouTube.mockResolvedValue([{ id: 'yt', title: 'Clip' }]);
    const plain = withSearch();
    plain.search.catalog('artist only');
    await vi.waitFor(() => expect(plain.search.loading()).toBe(false));
    expect(apiMock.searchYouTube).not.toHaveBeenCalled();
    plain.dispose();

    const panel = withSearch({ youtubeFallback: true });
    panel.search.catalog('artist only');
    await vi.waitFor(() => expect(panel.search.youtubeResults()).toEqual([{ id: 'yt', title: 'Clip' }]));
    panel.dispose();
  });

  it('reports a catalog failure, or covers it with YouTube when falling back', async () => {
    apiMock.searchCatalog.mockRejectedValue(new Error('down'));
    apiMock.searchYouTube.mockResolvedValue([{ id: 'yt', title: 'Clip' }]);
    const plain = withSearch();
    plain.search.catalog('broken');
    await vi.waitFor(() => expect(plain.search.error()).toBe(true));
    plain.dispose();

    const panel = withSearch({ youtubeFallback: true });
    panel.search.catalog('broken');
    await vi.waitFor(() => expect(panel.search.youtubeResults()).toHaveLength(1));
    expect(panel.search.error()).toBe(false);
    panel.dispose();
  });

  it('reads a pasted link instead of searching for it', async () => {
    apiMock.peekYouTube.mockRejectedValue(new Error('offline'));
    const { search, dispose } = withSearch();
    search.search('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await vi.waitFor(() => expect(search.direct()?.id).toBe('dQw4w9WgXcQ'));
    expect(apiMock.searchCatalog).not.toHaveBeenCalled();
    dispose();
  });
});
