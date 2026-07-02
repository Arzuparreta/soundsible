import { createMemo, createSignal, For, Match, Show, Switch, onCleanup, onMount, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api, type DiscoveryFeedItem, type DiscoveryFeedSection, type DiscoverySaveCandidate } from '../lib/api';
import { actions, state } from '../stores';
import { coverUrl } from '../lib/media';
import { artistPath } from '../lib/artistRoute';
import { toast } from '../lib/toast';
import { parseYouTubeInput } from '../lib/youtube';
import { ensureDiscover, feedItems, feedSections, refreshDiscover, revalidating } from '../lib/discover';
import SearchResultRow from '../components/SearchResultRow';
import type { CatalogItem, CatalogSaveResponse, SearchResult, Track } from '../types/music';
import styles from './Search.module.css';

type SearchDomain = 'music' | 'youtube';
type SearchTab = 'all' | 'track,library_track' | 'artist' | 'album';

const tabs: Array<{ id: SearchTab; label: string }> = [
  { id: 'all', label: 'Todo' },
  { id: 'track,library_track', label: 'Canciones' },
  { id: 'artist', label: 'Artistas' },
  { id: 'album', label: 'Albums' },
];

const RECENTS_KEY = 'catalog_search_recents';
const RECENTS_KEY_YOUTUBE = 'youtube_search_recents';

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function formatDuration(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 46% 31%), hsl(${(h + 42) % 360} 54% 18%))`;
}

function recentsKey(domain: SearchDomain): string {
  return domain === 'youtube' ? RECENTS_KEY_YOUTUBE : RECENTS_KEY;
}

function loadRecents(domain: SearchDomain): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(recentsKey(domain)) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveRecents(domain: SearchDomain, values: string[]): void {
  localStorage.setItem(recentsKey(domain), JSON.stringify(values.slice(0, 8)));
}

function itemArtist(item: CatalogItem): string {
  return item.artist || item.subtitle || '';
}

function itemTrack(item: CatalogItem): Track | null {
  if (item.track_id) {
    const found = state.library.find((t) => t.id === item.track_id);
    if (found) return found;
  }
  if (item.raw?.id && typeof item.raw.id === 'string') {
    return {
      id: item.raw.id,
      title: String(item.raw.title || item.title),
      artist: String(item.raw.artist || itemArtist(item)),
      album: typeof item.raw.album === 'string' ? item.raw.album : item.album,
      duration: typeof item.raw.duration === 'number' ? item.raw.duration : item.duration,
      youtube_id: typeof item.raw.youtube_id === 'string' ? item.raw.youtube_id : undefined,
      cover: item.cover,
    };
  }
  return null;
}

function candidateVideoId(candidate: Record<string, unknown>): string {
  return String(candidate.video_id || candidate.id || '');
}

function discoveryItemKey(item: DiscoveryFeedItem): string {
  return item.id || item.track_id || `${item.artist}:${item.title}`;
}

function discoveryItemCover(item: DiscoveryFeedItem): string | undefined {
  if (item.action_state?.in_library && item.track_id) return coverUrl(item.track_id);
  return item.cover;
}

function isDiscoveryExternal(item: DiscoveryFeedItem): boolean {
  return !!item.deezer_id || !!item.action_state?.needs_resolution || item.source?.startsWith('deezer') === true;
}

function discoveryCandidateId(candidate: DiscoverySaveCandidate): string {
  return candidate.video_id || candidate.id || '';
}

export default function Search() {
  const navigate = useNavigate();
  const [domain, setDomain] = createSignal<SearchDomain>('music');
  const [q, setQ] = createSignal('');
  const [tab, setTab] = createSignal<SearchTab>('all');
  const [items, setItems] = createSignal<CatalogItem[]>([]);
  const [sectionIds, setSectionIds] = createSignal<Record<string, string[]>>({});
  const [loading, setLoading] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [youtubeResults, setYoutubeResults] = createSignal<SearchResult[]>([]);
  const [youtubeDirect, setYoutubeDirect] = createSignal<SearchResult | null>(null);
  const [youtubeLoading, setYoutubeLoading] = createSignal(false);
  const [youtubeError, setYoutubeError] = createSignal(false);
  const [suggestions, setSuggestions] = createSignal<string[]>([]);
  const [showSuggest, setShowSuggest] = createSignal(false);
  const [recents, setRecents] = createSignal<string[]>(loadRecents('music'));
  const [saving, setSaving] = createSignal<Set<string>>(new Set());
  const [saved, setSaved] = createSignal<Set<string>>(new Set());
  const [youtubeEnqueued, setYoutubeEnqueued] = createSignal<Set<string>>(new Set());
  const [review, setReview] = createSignal<{ item: CatalogItem; response: CatalogSaveResponse } | null>(null);
  const [resolvedDiscovery, setResolvedDiscovery] = createSignal<Map<string, SearchResult>>(new Map());
  const [discoverySaving, setDiscoverySaving] = createSignal<Set<string>>(new Set());
  const [discoverySaved, setDiscoverySaved] = createSignal<Set<string>>(new Set());
  const [discoveryReview, setDiscoveryReview] = createSignal<{ item: DiscoveryFeedItem; candidates: DiscoverySaveCandidate[] } | null>(null);

  let aborter: AbortController | undefined;
  let suggestAborter: AbortController | undefined;
  let debounce: number | undefined;
  let suggestDebounce: number | undefined;
  let requestId = 0;
  let searchInput: HTMLInputElement | undefined;
  const youtubeCache = new Map<string, SearchResult[]>();

  const byId = createMemo(() => new Map(items().map((item) => [item.id, item] as const)));
  const libYt = createMemo(() => new Set(state.library.map((t) => t.youtube_id).filter((x): x is string => !!x)));
  const top = createMemo(() => items()[0]);
  const songs = createMemo(() =>
    (sectionIds().songs ?? [])
      .map((id) => byId().get(id))
      .filter((item): item is CatalogItem => !!item)
      .concat(items().filter((item) => ['track', 'library_track'].includes(item.type) && item.id !== top()?.id))
      .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
      .slice(0, 18),
  );
  const artists = createMemo(() =>
    (sectionIds().artists ?? [])
      .map((id) => byId().get(id))
      .filter((item): item is CatalogItem => !!item)
      .concat(items().filter((item) => item.type === 'artist' && item.id !== top()?.id))
      .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
      .slice(0, 12),
  );
  const albums = createMemo(() =>
    (sectionIds().albums ?? [])
      .map((id) => byId().get(id))
      .filter((item): item is CatalogItem => !!item)
      .concat(items().filter((item) => item.type === 'album' && item.id !== top()?.id))
      .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
      .slice(0, 12),
  );
  const discoveryById = createMemo(() => new Map(feedItems().map((item) => [item.id, item] as const)));

  onMount(() => ensureDiscover());

  const runCatalog = (query: string, nextTab = tab()) => {
    query = query.trim();
    const current = ++requestId;
    aborter?.abort();
    aborter = undefined;
    setSearchError(false);
    setYoutubeError(false);
    setYoutubeDirect(null);
    setYoutubeResults([]);
    setYoutubeLoading(false);
    if (query.length < 2) {
      setItems([]);
      setSectionIds({});
      setLoading(false);
      return;
    }
    aborter = new AbortController();
    setLoading(true);
    api
      .searchCatalog(query, aborter.signal, nextTab)
      .then((res) => {
        if (current !== requestId) return;
        setItems(res.items ?? []);
        const nextSections: Record<string, string[]> = {};
        for (const section of res.sections ?? []) nextSections[section.id] = section.item_ids ?? [];
        setSectionIds(nextSections);
      })
      .catch((e) => {
        if (current !== requestId || isAbort(e)) return;
        setItems([]);
        setSectionIds({});
        setSearchError(true);
      })
      .finally(() => {
        if (current === requestId) setLoading(false);
      });
  };

  const fallbackDirectResult = (videoId: string): SearchResult => ({
    id: videoId,
    title: 'YouTube video',
    channel: 'YouTube',
    thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  });

  const runYouTube = (query: string) => {
    query = query.trim();
    const current = ++requestId;
    aborter?.abort();
    aborter = undefined;
    setYoutubeError(false);
    setLoading(false);
    setItems([]);
    setSectionIds({});
    const direct = parseYouTubeInput(query);
    if (direct) {
      aborter = new AbortController();
      setYoutubeLoading(true);
      setYoutubeResults([]);
      api
        .peekYouTube(direct.url, aborter.signal)
        .then((res) => {
          if (current !== requestId) return;
          setYoutubeDirect(res ?? fallbackDirectResult(direct.videoId));
        })
        .catch((e) => {
          if (current !== requestId || isAbort(e)) return;
          setYoutubeDirect(fallbackDirectResult(direct.videoId));
        })
        .finally(() => {
          if (current === requestId) setYoutubeLoading(false);
        });
      return;
    }

    setYoutubeDirect(null);
    if (query.length < 2) {
      setYoutubeResults([]);
      setYoutubeLoading(false);
      return;
    }
    const cached = youtubeCache.get(query);
    if (cached) {
      setYoutubeResults(cached);
      setYoutubeLoading(false);
      return;
    }
    aborter = new AbortController();
    setYoutubeLoading(true);
    api
      .searchYouTube(query, aborter.signal)
      .then((res) => {
        if (current !== requestId) return;
        youtubeCache.set(query, res);
        setYoutubeResults(res);
      })
      .catch((e) => {
        if (current !== requestId || isAbort(e)) return;
        setYoutubeResults([]);
        setYoutubeError(true);
      })
      .finally(() => {
        if (current === requestId) setYoutubeLoading(false);
      });
  };

  const runSearch = (query: string, nextDomain = domain(), nextTab = tab()) => {
    if (nextDomain === 'youtube') runYouTube(query);
    else runCatalog(query, nextTab);
  };

  const runSuggest = (query: string) => {
    query = query.trim();
    suggestAborter?.abort();
    if (query.length < 2 || parseYouTubeInput(query)) {
      setSuggestions([]);
      return;
    }
    suggestAborter = new AbortController();
    const suggest = domain() === 'youtube' ? api.suggest(query, suggestAborter.signal) : api.suggestCatalog(query, suggestAborter.signal);
    suggest.then((s) => setSuggestions(s)).catch(() => {});
  };

  const commit = (value: string) => {
    const query = value.trim();
    const nextDomain = parseYouTubeInput(query) ? 'youtube' : domain();
    if (nextDomain !== domain()) setDomain(nextDomain);
    setQ(query);
    setShowSuggest(false);
    setSuggestions([]);
    clearTimeout(debounce);
    clearTimeout(suggestDebounce);
    runSearch(query, nextDomain);
    if (query.length >= 2) {
      const next = [query, ...recents().filter((x) => x.toLowerCase() !== query.toLowerCase())].slice(0, 8);
      setRecents(next);
      saveRecents(nextDomain, next);
    }
  };

  const onInput = (value: string) => {
    const nextDomain = parseYouTubeInput(value) ? 'youtube' : domain();
    if (nextDomain !== domain()) {
      setDomain(nextDomain);
      setRecents(loadRecents(nextDomain));
    }
    setQ(value);
    setShowSuggest(true);
    clearTimeout(debounce);
    clearTimeout(suggestDebounce);
    debounce = window.setTimeout(() => runSearch(value, nextDomain), 220);
    suggestDebounce = window.setTimeout(() => runSuggest(value), 120);
  };

  const setActiveTab = (next: SearchTab) => {
    setTab(next);
    runCatalog(q(), next);
  };

  const setActiveDomain = (next: SearchDomain) => {
    setDomain(next);
    setRecents(loadRecents(next));
    setShowSuggest(false);
    setSuggestions([]);
    runSearch(q(), next);
  };

  const coverStyle = (item: CatalogItem, round = false): JSX.CSSProperties => {
    const grad = gradientFor(item.id);
    const url = item.cover || (item.track_id ? coverUrl(item.track_id) : '');
    return {
      background: url ? `url("${url}") center / cover no-repeat, ${grad}` : grad,
      'border-radius': round ? 'var(--radius-full)' : undefined,
    };
  };

  const previewExternal = async (item: CatalogItem) => {
    const artist = itemArtist(item);
    if (!artist || !item.title) return;
    const t = toast.loading('Buscando preview...');
    try {
      const resolved = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration });
      if (!resolved.video_id) throw new Error('not-found');
      actions.playTrack({
        id: resolved.video_id,
        title: item.title,
        artist,
        album: item.album,
        duration: item.duration,
        cover: item.cover,
        source: 'preview',
      });
      t.update('success', 'Reproduciendo preview');
    } catch {
      t.update('error', 'No se pudo encontrar preview');
    }
  };

  const playItem = (item: CatalogItem) => {
    const track = itemTrack(item);
    if (track) {
      actions.playTrack(track);
      return;
    }
    if (item.type === 'track') void previewExternal(item);
    else if (item.type === 'artist') {
      const artist = itemArtist(item) || item.title;
      const hasLocal = state.library.some((t) => t.artist === artist || t.album_artist === artist);
      if (hasLocal) navigate(artistPath(artist));
      else commit(artist);
    } else if (item.type === 'album') {
      commit(`${item.title} ${itemArtist(item)}`.trim());
    }
  };

  const saveItem = async (item: CatalogItem, confirmVideoId?: string) => {
    const artist = itemArtist(item);
    if (!artist || !item.title) return;
    setSaving((s) => new Set(s).add(item.id));
    try {
      const response = await api.saveCatalogItem({
        catalog_item_id: item.id,
        source: item.source,
        artist,
        title: item.title,
        duration: item.duration,
        cover: item.cover,
        external_ids: item.external_ids,
        confirm_video_id: confirmVideoId,
      });
      if (response.status === 'queued') {
        setReview(null);
        setSaved((s) => new Set(s).add(item.id));
        toast.success('Añadido a descargas');
      } else if (response.status === 'needs_review') {
        setReview({ item, response });
      } else {
        toast.error('No se pudo guardar');
      }
    } catch {
      toast.error('No se pudo guardar');
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  };

  const previewYouTube = (result: SearchResult) => {
    actions.playTrack({
      id: result.id,
      title: result.title,
      artist: result.channel ?? '',
      duration: result.duration,
      source: 'preview',
      cover: result.thumbnail,
    });
    void api.emitDiscoveryEvent('music_search_played', {
      title: result.title,
      artist: result.channel ?? '',
      source: 'youtube_search',
      youtube_id: result.id,
      query: q(),
    }).catch(() => {});
  };

  const addYouTube = async (result: SearchResult) => {
    if (libYt().has(result.id)) {
      toast.info('Ya está en tu biblioteca');
      return;
    }
    const alreadyDownloading = state.downloads.queue.some(
      (item) => item.video_id === result.id && item.status !== 'failed' && item.status !== 'interrupted',
    );
    if (alreadyDownloading || youtubeEnqueued().has(result.id)) {
      toast.info('Ya está en la cola de descargas');
      return;
    }
    setYoutubeEnqueued((s) => new Set(s).add(result.id));
    try {
      await api.enqueueDownload([
        {
          source_type: 'youtube_url',
          song_str: `https://www.youtube.com/watch?v=${result.id}`,
          video_id: result.id,
          display_title: result.title,
          display_artist: result.channel,
          thumbnail_url: result.thumbnail,
          duration_sec: result.duration,
          metadata_evidence: null,
        },
      ]);
      void actions.loadDownloads();
      void api.emitDiscoveryEvent('music_added_to_queue', {
        title: result.title,
        artist: result.channel ?? '',
        source: 'youtube_search',
        youtube_id: result.id,
        query: q(),
      }).catch(() => {});
      toast.success('Añadido a descargas');
    } catch {
      setYoutubeEnqueued((s) => {
        const next = new Set(s);
        next.delete(result.id);
        return next;
      });
      toast.error('No se pudo añadir a descargas');
    }
  };

  const discoverySectionItems = (section: DiscoveryFeedSection): DiscoveryFeedItem[] =>
    (section.item_ids ?? []).map((id) => discoveryById().get(id)).filter((item): item is DiscoveryFeedItem => !!item);

  const discoveryTrack = (item: DiscoveryFeedItem): Track | null => {
    if (!item.track_id) return null;
    const found = state.library.find((t) => t.id === item.track_id);
    return (
      found ?? {
        id: item.track_id,
        title: item.title,
        artist: item.artist,
        album: item.album,
        duration: item.duration,
        cover: item.cover,
      }
    );
  };

  const resolveDiscoveryExternal = async (item: DiscoveryFeedItem): Promise<SearchResult | null> => {
    const key = discoveryItemKey(item);
    const cached = resolvedDiscovery().get(key);
    if (cached) return cached;
    const found = (await api.searchYouTube(`${item.title} ${item.artist}`.trim()))[0];
    if (!found) return null;
    setResolvedDiscovery((current) => {
      const next = new Map(current);
      next.set(key, found);
      return next;
    });
    return found;
  };

  const previewDiscoveryExternal = async (item: DiscoveryFeedItem) => {
    const t = toast.loading('Buscando preview...');
    try {
      const resolved = await resolveDiscoveryExternal(item);
      if (!resolved) throw new Error('not-found');
      actions.playTrack({
        id: resolved.id,
        title: item.title || resolved.title,
        artist: item.artist || resolved.channel || '',
        album: item.album,
        duration: item.duration || resolved.duration,
        source: 'preview',
        cover: item.cover || resolved.thumbnail,
      });
      void api.emitDiscoveryEvent('music_search_played', {
        title: item.title,
        artist: item.artist,
        source: item.source,
        deezer_id: item.deezer_id,
        youtube_id: resolved.id,
      }).catch(() => {});
      t.update('success', 'Reproduciendo preview');
    } catch {
      t.update('error', 'No se pudo encontrar preview');
    }
  };

  const playDiscoveryItem = (item: DiscoveryFeedItem) => {
    if (isDiscoveryExternal(item)) {
      void previewDiscoveryExternal(item);
      return;
    }
    const track = discoveryTrack(item);
    if (track) actions.playTrack(track);
  };

  const saveDiscoveryExternal = async (item: DiscoveryFeedItem, confirmVideoId?: string) => {
    const key = discoveryItemKey(item);
    setDiscoverySaving((current) => new Set(current).add(key));
    try {
      const res = await api.saveDiscoveryTrack({
        artist: item.artist,
        title: item.title,
        duration: item.duration,
        deezer_id: item.deezer_id,
        cover: item.cover,
        confirm_video_id: confirmVideoId,
      });
      if (res.status === 'queued') {
        setDiscoveryReview(null);
        setDiscoverySaved((current) => new Set(current).add(key));
        void refreshDiscover();
        toast.success('Añadido a descargas');
        return;
      }
      if (res.status === 'needs_review' && res.candidates?.length) {
        setDiscoveryReview({ item, candidates: res.candidates });
        return;
      }
      toast.error('No se pudo guardar');
    } catch {
      toast.error('No se pudo guardar');
    } finally {
      setDiscoverySaving((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  onCleanup(() => {
    requestId += 1;
    aborter?.abort();
    suggestAborter?.abort();
    clearTimeout(debounce);
    clearTimeout(suggestDebounce);
  });

  return (
    <div class="view">
      <div class={styles.searchBox}>
        <div class={styles.bar}>
          <input
            class={styles.input}
            type="search"
            placeholder="Qué quieres escuchar?"
            value={q()}
            ref={searchInput}
            onInput={(e) => onInput(e.currentTarget.value)}
            onFocus={() => setShowSuggest(true)}
            onBlur={() => setShowSuggest(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value);
              if (e.key === 'Escape') setShowSuggest(false);
            }}
            autofocus
          />
        </div>
        <Show when={showSuggest() && q().trim().length >= 2 && suggestions().length > 0}>
          <div class={styles.suggest}>
            <For each={suggestions()}>
              {(value) => (
                <button class={styles.suggestItem} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => commit(value)}>
                  <SearchIcon />
                  <span>{value}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={domain() === 'music' && q().trim().length >= 2}>
        <div class={styles.tabs}>
          <For each={tabs}>
            {(t) => (
              <button
                classList={{ [styles.tab]: true, [styles.activeTab]: tab() === t.id }}
                type="button"
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class={styles.scroll}>
        <Switch>
          <Match when={!q().trim()}>
            <StartPanel
              recents={recents()}
              domain={domain()}
              sections={feedSections()}
              revalidating={revalidating()}
              sectionItems={discoverySectionItems}
              onPick={commit}
              onFocusSearch={() => searchInput?.focus()}
              onPlay={playDiscoveryItem}
              onSave={(item) => void saveDiscoveryExternal(item)}
              saving={(item) => discoverySaving().has(discoveryItemKey(item))}
              saved={(item) => discoverySaved().has(discoveryItemKey(item)) || !!item.action_state?.in_library}
            />
          </Match>
          <Match when={domain() === 'youtube'}>
            <div class={styles.results}>
              <Show when={youtubeLoading() && youtubeResults().length === 0 && !youtubeDirect()}>
                <div class={styles.skeletonGrid}>
                  <For each={Array.from({ length: 8 })}>{() => <div class={styles.skeleton} />}</For>
                </div>
              </Show>

              <Show when={!youtubeLoading() && !youtubeDirect() && youtubeResults().length === 0 && q().trim().length >= 2}>
                <p class={styles.hint}>
                  {youtubeError() ? (
                    <>
                      No se pudo completar la búsqueda en YouTube.{' '}
                      <button class={styles.retry} type="button" onClick={() => runYouTube(q())}>
                        Reintentar
                      </button>
                    </>
                  ) : (
                    'Sin resultados en YouTube.'
                  )}
                </p>
              </Show>

              <Show when={youtubeDirect()}>
                {(result) => (
                  <section class={styles.section}>
                    <h2 class={styles.sectionTitle}>Video detectado</h2>
                    <SearchResultRow
                      r={result()}
                      active={state.playback.currentTrack?.id === result().id}
                      inLibrary={libYt().has(result().id)}
                      enqueued={youtubeEnqueued().has(result().id)}
                      onPreview={() => previewYouTube(result())}
                      onAdd={() => void addYouTube(result())}
                    />
                  </section>
                )}
              </Show>

              <Show when={youtubeResults().length > 0}>
                <section class={styles.section}>
                  <h2 class={styles.sectionTitle}>Resultados en YouTube</h2>
                  <For each={youtubeResults()}>
                    {(result) => (
                      <SearchResultRow
                        r={result}
                        active={state.playback.currentTrack?.id === result.id}
                        inLibrary={libYt().has(result.id)}
                        enqueued={youtubeEnqueued().has(result.id)}
                        onPreview={() => previewYouTube(result)}
                        onAdd={() => void addYouTube(result)}
                      />
                    )}
                  </For>
                </section>
              </Show>
            </div>
          </Match>
          <Match when={loading() && items().length === 0}>
            <div class={styles.skeletonGrid}>
              <For each={Array.from({ length: 8 })}>{() => <div class={styles.skeleton} />}</For>
            </div>
          </Match>
          <Match when={!loading() && items().length === 0}>
            <p class={styles.hint}>
              {searchError() ? (
                <>
                  No se pudo completar la búsqueda.{' '}
                  <button class={styles.retry} type="button" onClick={() => runCatalog(q())}>
                    Reintentar
                  </button>
                </>
              ) : (
                <>
                  Sin resultados en Música.{' '}
                  <button class={styles.retry} type="button" onClick={() => setActiveDomain('youtube')}>
                    Buscar en YouTube
                  </button>
                </>
              )}
            </p>
          </Match>
          <Match when={true}>
            <div class={styles.results}>
              <Show when={top()}>
                {(item) => (
                  <section class={styles.topSection}>
                    <h2 class={styles.sectionTitle}>Top result</h2>
                    <TopResult
                      item={item()}
                      coverStyle={coverStyle}
                      saving={saving().has(item().id)}
                      saved={saved().has(item().id) || !!item().action_state?.in_library}
                      onPlay={() => playItem(item())}
                      onSave={() => saveItem(item())}
                    />
                  </section>
                )}
              </Show>

              <Show when={songs().length > 0}>
                <section class={styles.section}>
                  <h2 class={styles.sectionTitle}>Canciones</h2>
                  <For each={songs()}>
                    {(item) => (
                      <SongResult
                        item={item}
                        coverStyle={coverStyle}
                        active={state.playback.currentTrack?.id === (item.track_id || item.id)}
                        saving={saving().has(item.id)}
                        saved={saved().has(item.id) || !!item.action_state?.in_library}
                        onPlay={() => playItem(item)}
                        onSave={() => saveItem(item)}
                      />
                    )}
                  </For>
                </section>
              </Show>

              <Show when={artists().length > 0}>
                <CardSection title="Artistas" items={artists()} round coverStyle={coverStyle} onPick={playItem} />
              </Show>

              <Show when={albums().length > 0}>
                <CardSection title="Albums" items={albums()} coverStyle={coverStyle} onPick={playItem} />
              </Show>
            </div>
          </Match>
        </Switch>
      </div>

      <Show when={review()}>
        {(r) => (
          <div class={styles.modalBackdrop} onClick={() => setReview(null)}>
            <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
              <div class={styles.modalHead}>
                <h2>Elige la version</h2>
                <button class={styles.closeBtn} type="button" aria-label="Cerrar" onClick={() => setReview(null)}>
                  x
                </button>
              </div>
              <For each={(r().response.candidates ?? []).slice(0, 5)}>
                {(candidate) => (
                  <button
                    class={styles.candidate}
                    type="button"
                    onClick={() => {
                      const id = candidateVideoId(candidate);
                      if (id) void saveItem(r().item, id);
                    }}
                  >
                    <span class={styles.candidateTitle}>{String(candidate.title || '')}</span>
                    <span class={styles.candidateSub}>{String(candidate.channel || '')}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>

      <Show when={discoveryReview()}>
        {(r) => (
          <div class={styles.modalBackdrop} onClick={() => setDiscoveryReview(null)}>
            <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
              <div class={styles.modalHead}>
                <h2>Elige la version</h2>
                <button class={styles.closeBtn} type="button" aria-label="Cerrar" onClick={() => setDiscoveryReview(null)}>
                  x
                </button>
              </div>
              <For each={r().candidates.slice(0, 5)}>
                {(candidate) => (
                  <button
                    class={styles.candidate}
                    type="button"
                    onClick={() => {
                      const id = discoveryCandidateId(candidate);
                      if (id) void saveDiscoveryExternal(r().item, id);
                    }}
                  >
                    <span class={styles.candidateTitle}>{candidate.title}</span>
                    <span class={styles.candidateSub}>{candidate.channel}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

function StartPanel(props: {
  recents: string[];
  domain: SearchDomain;
  sections: DiscoveryFeedSection[];
  revalidating: boolean;
  sectionItems: (section: DiscoveryFeedSection) => DiscoveryFeedItem[];
  onPick: (value: string) => void;
  onFocusSearch: () => void;
  onPlay: (item: DiscoveryFeedItem) => void;
  onSave: (item: DiscoveryFeedItem) => void;
  saving: (item: DiscoveryFeedItem) => boolean;
  saved: (item: DiscoveryFeedItem) => boolean;
}) {
  return (
    <div class={styles.start}>
      <Show
        when={props.sections.length > 0}
        fallback={props.revalidating ? <RailSkeletons /> : <SeedSearch onFocusSearch={props.onFocusSearch} />}
      >
        <For each={props.sections}>
          {(section) => (
            <section class={styles.rail}>
              <div class={styles.railHead}>
                <div>
                  <h2 class={styles.railTitle}>{section.title}</h2>
                  <Show when={section.reason}>
                    <p class={styles.railReason}>{section.reason}</p>
                  </Show>
                </div>
              </div>
              <div class={styles.railRow}>
                <For each={props.sectionItems(section)}>
                  {(item) => (
                    <DiscoveryCard
                      item={item}
                      onPlay={() => props.onPlay(item)}
                      onSave={isDiscoveryExternal(item) && !item.action_state?.in_library ? () => props.onSave(item) : undefined}
                      saving={props.saving(item)}
                      saved={props.saved(item)}
                    />
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </Show>

      <Show when={props.recents.length > 0}>
        <section>
          <h2 class={styles.sectionTitle}>{props.domain === 'youtube' ? 'Búsquedas recientes en YouTube' : 'Búsquedas recientes'}</h2>
          <div class={styles.recentGrid}>
            <For each={props.recents}>
              {(value) => (
                <button class={styles.recent} type="button" onClick={() => props.onPick(value)}>
                  <SearchIcon />
                  <span>{value}</span>
                </button>
              )}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
}

function SeedSearch(props: { onFocusSearch: () => void }) {
  return (
    <div class={styles.seedState}>
      <h2>Busca musica para empezar</h2>
      <p>Las recomendaciones se generan con artistas, favoritos, playlists y canciones que guardas o reproduces.</p>
      <button class={styles.seedAction} type="button" onClick={props.onFocusSearch}>
        Buscar canciones
      </button>
    </div>
  );
}

function DiscoveryCard(props: {
  item: DiscoveryFeedItem;
  onPlay: () => void;
  onSave?: () => void;
  saving: boolean;
  saved: boolean;
}) {
  const bg = (): JSX.CSSProperties => {
    const cover = discoveryItemCover(props.item);
    const grad = gradientFor(discoveryItemKey(props.item));
    return cover ? { background: `url("${cover}") center / cover no-repeat, ${grad}` } : { background: grad };
  };
  return (
    <div class={styles.discoverCard}>
      <button class={styles.discoverCardBtn} type="button" onClick={props.onPlay}>
        <span class={styles.discoverCardCover} style={bg()} />
        <span class={styles.discoverCardTitle}>{props.item.title}</span>
        <span class={styles.discoverCardSub}>{props.item.artist}</span>
      </button>
      <Switch>
        <Match when={props.onSave && !props.saved}>
          <button
            class={styles.discoverSaveBtn}
            type="button"
            aria-label="Guardar en biblioteca"
            disabled={props.saving}
            onClick={(e) => {
              e.stopPropagation();
              props.onSave?.();
            }}
          >
            <Show when={props.saving} fallback={<PlusIcon />}>
              <span class={styles.smallSpinner} />
            </Show>
          </button>
        </Match>
        <Match when={props.saved && isDiscoveryExternal(props.item)}>
          <span class={styles.discoverSavedBadge} aria-label="Guardado">
            <CheckIcon />
          </span>
        </Match>
      </Switch>
    </div>
  );
}

function RailSkeletons() {
  return (
    <For each={Array.from({ length: 3 })}>
      {() => (
        <section class={styles.rail}>
          <div class={styles.railTitleSkeleton} />
          <div class={styles.railRow}>
            <For each={Array.from({ length: 6 })}>{() => <div class={styles.discoverCardSkeleton} />}</For>
          </div>
        </section>
      )}
    </For>
  );
}

function TopResult(props: {
  item: CatalogItem;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  saving: boolean;
  saved: boolean;
  onPlay: () => void;
  onSave: () => void;
}) {
  const canSave = () => props.item.type === 'track' && !props.saved;
  return (
    <div class={styles.topCard}>
      <button class={styles.topMain} type="button" onClick={props.onPlay}>
        <span class={styles.topCover} style={props.coverStyle(props.item, props.item.type === 'artist')} />
        <span class={styles.topMeta}>
          <span class={styles.topTitle}>{props.item.title}</span>
          <span class={styles.topSub}>{props.item.subtitle || itemArtist(props.item)}</span>
          <span class={styles.pill}>{labelFor(props.item)}</span>
        </span>
      </button>
      <Show when={canSave()}>
        <button class={styles.primaryIcon} type="button" disabled={props.saving} aria-label="Guardar" onClick={props.onSave}>
          <Show when={props.saving} fallback={<PlusIcon />}>
            <span class={styles.spinner} />
          </Show>
        </button>
      </Show>
    </div>
  );
}

function SongResult(props: {
  item: CatalogItem;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  active: boolean;
  saving: boolean;
  saved: boolean;
  onPlay: () => void;
  onSave: () => void;
}) {
  const canSave = () => props.item.type === 'track' && !props.saved;
  return (
    <div classList={{ [styles.songRow]: true, [styles.activeSong]: props.active }} onClick={props.onPlay}>
      <span class={styles.songCover} style={props.coverStyle(props.item)} />
      <span class={styles.songMeta}>
        <span class={styles.songTitle}>{props.item.title}</span>
        <span class={styles.songSub}>{props.item.subtitle || itemArtist(props.item)}</span>
      </span>
      <span class={styles.source}>{props.item.source}</span>
      <span class={styles.duration}>{formatDuration(props.item.duration)}</span>
      <Show when={props.saved}>
        <span class={styles.done} aria-label="En biblioteca">
          <CheckIcon />
        </span>
      </Show>
      <Show when={canSave()}>
        <button
          class={styles.iconBtn}
          type="button"
          disabled={props.saving}
          aria-label="Guardar"
          onClick={(e) => {
            e.stopPropagation();
            props.onSave();
          }}
        >
          <Show when={props.saving} fallback={<PlusIcon />}>
            <span class={styles.spinner} />
          </Show>
        </button>
      </Show>
    </div>
  );
}

function CardSection(props: {
  title: string;
  items: CatalogItem[];
  round?: boolean;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  onPick: (item: CatalogItem) => void;
}) {
  return (
    <section class={styles.section}>
      <h2 class={styles.sectionTitle}>{props.title}</h2>
      <div class={styles.cardGrid}>
        <For each={props.items}>
          {(item) => (
            <button class={styles.card} type="button" onClick={() => props.onPick(item)}>
              <span class={styles.cardCover} style={props.coverStyle(item, props.round)} />
              <span class={styles.cardTitle}>{item.title}</span>
              <span class={styles.cardSub}>{item.subtitle || itemArtist(item)}</span>
            </button>
          )}
        </For>
      </div>
    </section>
  );
}

function labelFor(item: CatalogItem): string {
  if (item.type === 'library_track') return 'En tu biblioteca';
  if (item.type === 'track') return 'Cancion';
  if (item.type === 'artist') return 'Artista';
  if (item.type === 'album') return 'Album';
  return 'Playlist';
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
