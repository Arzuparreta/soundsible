/**
 * One search request lifecycle for every surface that searches music.
 *
 * The Search route and the player's search panel each carried their own copy
 * of the same work: a request counter so a slow answer cannot overwrite a newer
 * one, an abort for the request it replaces, the shared result cache, a pasted
 * YouTube link peeked instead of searched. The copies drifted — the panel never
 * wrote the cache, the route never fell back to YouTube. They now share this
 * controller and differ only in what they ask of it.
 */
import { createSignal } from 'solid-js';
import { api } from './api';
import { readSearchCache, writeSearchCache } from './searchCache';
import { CATALOG_CACHE_NS, type CachedCatalog } from './searchSections';
import { parseYouTubeInput } from './youtube';
import { t } from './i18n';
import type { CatalogItem, CatalogSection, SearchResult } from '../types/music';

/** The shortest query worth sending: one character answers nothing. */
export const MIN_SEARCH_LENGTH = 2;

const YOUTUBE_CACHE_NS = 'youtube';

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function hasSongs(items: CatalogItem[]): boolean {
  return items.some((item) => item.type === 'track' || item.type === 'library_track');
}

/** What a pasted link shows when its details cannot be read. */
export function fallbackDirectResult(videoId: string): SearchResult {
  return {
    id: videoId,
    title: t('search.ytVideoTitle'),
    channel: t('search.ytVideoChannel'),
    thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  };
}

export interface CatalogSearchOptions {
  /** Search YouTube for songs when the catalog has none or fails. A surface
   * whose only list is songs needs something to play; the Search route offers
   * a YouTube mode of its own instead. */
  youtubeFallback?: boolean;
}

export function createCatalogSearch(options: CatalogSearchOptions = {}) {
  const [items, setItems] = createSignal<CatalogItem[]>([]);
  const [sections, setSections] = createSignal<CatalogSection[]>([]);
  const [interpretedAs, setInterpretedAs] = createSignal('');
  const [partial, setPartial] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [youtube, setYoutube] = createSignal<SearchResult[]>([]);
  const [direct, setDirect] = createSignal<SearchResult | null>(null);
  const [youtubeLoading, setYoutubeLoading] = createSignal(false);
  const [youtubeError, setYoutubeError] = createSignal(false);
  let request = 0;
  let aborter: AbortController | undefined;

  /** Start a request, invalidating whatever is still in flight. */
  const begin = () => {
    aborter?.abort();
    aborter = new AbortController();
    return { id: ++request, signal: aborter.signal };
  };
  const current = (id: number) => id === request;

  /** Drop the request in flight and its pending marks. Results already shown
   * stay, so a caller can keep them on screen while the next query settles. */
  const cancel = () => {
    request += 1;
    aborter?.abort();
    aborter = undefined;
    setLoading(false);
    setYoutubeLoading(false);
  };

  const clearCatalog = () => {
    setItems([]);
    setSections([]);
    setInterpretedAs('');
    setPartial(false);
    setError(false);
  };
  const clearYoutube = () => {
    setYoutube([]);
    setDirect(null);
    setYoutubeError(false);
  };

  /** Cancel and empty everything. */
  const reset = () => {
    cancel();
    clearCatalog();
    clearYoutube();
  };

  const searchYoutubeSongs = (query: string, id: number, signal: AbortSignal) => {
    const cached = readSearchCache<SearchResult[]>(YOUTUBE_CACHE_NS, query);
    if (cached) {
      setYoutube(cached);
      return Promise.resolve();
    }
    setYoutubeLoading(true);
    return api.searchYouTube(query, signal)
      .then((results) => {
        if (!current(id)) return;
        writeSearchCache(YOUTUBE_CACHE_NS, query, results);
        setYoutube(results);
      })
      .catch((failure) => {
        if (!current(id) || isAbort(failure)) return;
        setYoutube([]);
        setYoutubeError(true);
      })
      .finally(() => { if (current(id)) setYoutubeLoading(false); });
  };

  const peek = (videoId: string, url: string, id: number, signal: AbortSignal) => {
    setYoutubeLoading(true);
    api.peekYouTube(url, signal)
      .then((result) => { if (current(id)) setDirect(result ?? fallbackDirectResult(videoId)); })
      .catch((failure) => { if (current(id) && !isAbort(failure)) setDirect(fallbackDirectResult(videoId)); })
      .finally(() => { if (current(id)) setYoutubeLoading(false); });
  };

  /** Search the music catalog: library and online sources, one response laid
   * out by the server. */
  const catalog = (raw: string) => {
    const query = raw.trim();
    cancel();
    clearCatalog();
    clearYoutube();
    if (query.length < MIN_SEARCH_LENGTH) return;
    const { id, signal } = begin();
    const cached = readSearchCache<CachedCatalog>(CATALOG_CACHE_NS, query);
    if (cached) {
      setItems(cached.items);
      setSections(cached.sections);
      setInterpretedAs(cached.interpretedAs);
      if (options.youtubeFallback && !hasSongs(cached.items)) void searchYoutubeSongs(query, id, signal);
      return;
    }
    setLoading(true);
    api.searchCatalog(query, signal)
      .then((response) => {
        if (!current(id)) return;
        const found = response.items ?? [];
        const layout = response.sections ?? [];
        const interpreted = response.interpreted_as ?? '';
        writeSearchCache<CachedCatalog>(CATALOG_CACHE_NS, query, { items: found, sections: layout, interpretedAs: interpreted });
        setItems(found);
        setSections(layout);
        setInterpretedAs(interpreted);
        setPartial(Boolean(response.partial_failures?.length));
        if (options.youtubeFallback && !hasSongs(found)) void searchYoutubeSongs(query, id, signal);
      })
      .catch((failure) => {
        if (!current(id) || isAbort(failure)) return;
        if (options.youtubeFallback) void searchYoutubeSongs(query, id, signal);
        else setError(true);
      })
      .finally(() => { if (current(id)) setLoading(false); });
  };

  /** Search YouTube itself. A pasted link — or, with `allowVideoId`, a bare
   * video id — is read directly rather than searched for. */
  const youtubeSearch = (raw: string, opts: { allowVideoId?: boolean } = {}) => {
    const query = raw.trim();
    cancel();
    clearCatalog();
    clearYoutube();
    const pasted = parseYouTubeInput(query, { allowVideoId: opts.allowVideoId });
    if (!pasted && query.length < MIN_SEARCH_LENGTH) return;
    const { id, signal } = begin();
    if (pasted) peek(pasted.videoId, pasted.url, id, signal);
    else void searchYoutubeSongs(query, id, signal);
  };

  /** What any search box means by its text: a pasted link is that video,
   * anything else is a catalog search. */
  const search = (raw: string) => {
    if (parseYouTubeInput(raw.trim())) youtubeSearch(raw);
    else catalog(raw);
  };

  return {
    items, sections, interpretedAs, partial, loading, error,
    youtubeResults: youtube, direct, youtubeLoading, youtubeError,
    /** Mark a search as pending before its debounce fires, so the surface
     * shows it working rather than an empty answer. */
    markPending: (domain: 'music' | 'youtube') => (domain === 'music' ? setLoading : setYoutubeLoading)(true),
    catalog, youtube: youtubeSearch, search, cancel, reset,
  };
}

export type CatalogSearch = ReturnType<typeof createCatalogSearch>;
