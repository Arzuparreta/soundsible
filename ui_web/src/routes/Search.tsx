import { createEffect, createMemo, createSignal, For, Match, Show, Switch, onCleanup, onMount, untrack, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api } from '../lib/api';
import { actions, state } from '../stores';
import { coverUrl } from '../lib/media';
import { artistPath, albumPath } from '../lib/artistRoute';
import { toast } from '../lib/toast';
import { parseYouTubeInput } from '../lib/youtube';
import { prefetchPreviews } from '../lib/prefetch';
import { ensureNodeFeed, nodeFeed, nodeLoading, refreshNodeFeed, type NodeRec } from '../lib/nodeDiscover';
import { t as tr } from '../lib/i18n';
import { userKey } from '../lib/session';
import SearchResultRow from '../components/SearchResultRow';
import type { CatalogItem, CatalogSaveResponse, SearchResult, Track } from '../types/music';
import styles from './Search.module.css';

type SearchDomain = 'music' | 'youtube';
type SearchTab = 'all' | 'track,library_track' | 'artist' | 'album';

const tabs: Array<{ id: SearchTab; label: () => string }> = [
  { id: 'all', label: () => tr('search.tabAll') },
  { id: 'track,library_track', label: () => tr('search.tabSongs') },
  { id: 'artist', label: () => tr('search.tabArtists') },
  { id: 'album', label: () => tr('search.tabAlbums') },
];

const RECENTS_KEY = 'catalog_search_recents';
const RECENTS_KEY_YOUTUBE = 'youtube_search_recents';

// Power-user escape hatch: prefixing a query with `yt:` forces the plain-YouTube
// engine (e.g. `yt: some rare bootleg`). Invisible to everyone else.
const YT_PREFIX = /^yt:\s*/i;
function parseSearchInput(raw: string): { query: string; forceYt: boolean } {
  const forceYt = YT_PREFIX.test(raw);
  return { query: forceYt ? raw.replace(YT_PREFIX, '') : raw, forceYt };
}

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
  // Search history is personal, and a browser profile can be shared by the
  // whole household — namespace it by account so nobody reads anyone else's.
  return userKey(domain === 'youtube' ? RECENTS_KEY_YOUTUBE : RECENTS_KEY);
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
  // Inline YouTube fallback revealed under the music results (see expandYouTubeInline).
  const [youtubeInline, setYoutubeInline] = createSignal(false);
  const [suggestions, setSuggestions] = createSignal<string[]>([]);
  const [showSuggest, setShowSuggest] = createSignal(false);
  const [recents, setRecents] = createSignal<string[]>(loadRecents('music'));
  const [saving, setSaving] = createSignal<Set<string>>(new Set());
  const [saved, setSaved] = createSignal<Set<string>>(new Set());
  const [youtubeEnqueued, setYoutubeEnqueued] = createSignal<Set<string>>(new Set());
  const [review, setReview] = createSignal<{ item: CatalogItem; response: CatalogSaveResponse } | null>(null);
  const [nodeSaving, setNodeSaving] = createSignal<Set<string>>(new Set());

  let aborter: AbortController | undefined;
  let suggestAborter: AbortController | undefined;
  let debounce: number | undefined;
  let suggestDebounce: number | undefined;
  let requestId = 0;
  // Independent from the catalog aborter/requestId so the inline YouTube search
  // never cancels or clobbers the music results it renders underneath.
  let ytInlineAborter: AbortController | undefined;
  let ytInlineRequestId = 0;
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
  onMount(() => ensureNodeFeed());

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
    // A fresh music query collapses any inline YouTube section from the last one.
    ytInlineAborter?.abort();
    ytInlineAborter = undefined;
    setYoutubeInline(false);
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

  // Reveal plain-YouTube results underneath the music results, on demand. Runs
  // its own search against the youtube* signals without disturbing the catalog
  // state, so the user keeps their music results and gains YouTube reach in one
  // scroll. Reuses youtubeCache (shared with the full YouTube view).
  const expandYouTubeInline = () => {
    const query = q().trim();
    if (query.length < 2) return;
    setYoutubeInline(true);
    setYoutubeError(false);
    const cached = youtubeCache.get(query);
    if (cached) {
      setYoutubeResults(cached);
      setYoutubeLoading(false);
      return;
    }
    const current = ++ytInlineRequestId;
    ytInlineAborter?.abort();
    ytInlineAborter = new AbortController();
    setYoutubeResults([]);
    setYoutubeLoading(true);
    api
      .searchYouTube(query, ytInlineAborter.signal)
      .then((res) => {
        if (current !== ytInlineRequestId) return;
        youtubeCache.set(query, res);
        setYoutubeResults(res);
      })
      .catch((e) => {
        if (current !== ytInlineRequestId || isAbort(e)) return;
        setYoutubeResults([]);
        setYoutubeError(true);
      })
      .finally(() => {
        if (current === ytInlineRequestId) setYoutubeLoading(false);
      });
  };

  const fallbackDirectResult = (videoId: string): SearchResult => ({
    id: videoId,
    title: tr('search.ytVideoTitle'),
    channel: tr('search.ytVideoChannel'),
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

  // ── Speculative warm-up: resolve the top of the results in the background
  // while the user is still deciding, so the eventual play click starts
  // near-instantly. YouTube rows already carry playable ids; top catalog
  // (Deezer) songs are resolved to a video id first (server-cached forever).
  const prefetchedCatalog = new Set<string>();
  createEffect(() => {
    const directResult = youtubeDirect();
    const ytTop = youtubeResults().slice(0, 3).map((r) => r.id);
    const topSongs = songs().slice(0, 2);
    untrack(() => {
      if (directResult) prefetchPreviews([directResult.id]);
      prefetchPreviews(ytTop);
      for (const item of topSongs) {
        if (item.type !== 'track' || item.track_id) continue;
        if (item.raw?.id && typeof item.raw.id === 'string') {
          prefetchPreviews([item.raw.id]);
          continue;
        }
        const artist = itemArtist(item);
        if (!artist || !item.title || prefetchedCatalog.has(item.id)) continue;
        prefetchedCatalog.add(item.id);
        void api
          .resolveCatalogItem({ artist, title: item.title, duration: item.duration })
          .then((res) => {
            if (res.video_id) prefetchPreviews([res.video_id]);
          })
          .catch(() => {});
      }
    });
  });

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
    const { query: parsed, forceYt } = parseSearchInput(value.trim());
    const query = parsed.trim();
    const nextDomain = forceYt || parseYouTubeInput(query) ? 'youtube' : domain();
    if (nextDomain !== domain()) setDomain(nextDomain);
    setQ(value.trim());
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
    const { query: parsed, forceYt } = parseSearchInput(value);
    const nextDomain = forceYt || parseYouTubeInput(parsed) ? 'youtube' : domain();
    if (nextDomain !== domain()) {
      setDomain(nextDomain);
      setRecents(loadRecents(nextDomain));
    }
    setQ(value);
    setShowSuggest(true);
    clearTimeout(debounce);
    clearTimeout(suggestDebounce);
    debounce = window.setTimeout(() => runSearch(parsed, nextDomain), 220);
    suggestDebounce = window.setTimeout(() => runSuggest(parsed), 120);
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
    const h = toast.loading(tr('search.looking'));
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
      h.update('success', tr('search.playingPreview'));
    } catch {
      h.update('error', tr('search.noPreview'));
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
      const deezerId = item.external_ids?.deezer_artist_id
        ? String(item.external_ids.deezer_artist_id)
        : undefined;
      navigate(artistPath(artist, { view: 'discover', deezerId }));
    } else if (item.type === 'album') {
      const deezerId = item.external_ids?.deezer_album_id
        ? String(item.external_ids.deezer_album_id)
        : undefined;
      navigate(albumPath(item.title, itemArtist(item), { view: 'discover', deezerId }));
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
        toast.success(tr('search.addedToDownloads'));
      } else if (response.status === 'needs_review') {
        setReview({ item, response });
      } else {
        toast.error(tr('search.notSaved'));
      }
    } catch {
      toast.error(tr('search.notSaved'));
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
      toast.info(tr('search.alreadyInLibrary'));
      return;
    }
    const alreadyDownloading = state.downloads.queue.some(
      (item) => item.video_id === result.id && item.status !== 'failed' && item.status !== 'interrupted',
    );
    if (alreadyDownloading || youtubeEnqueued().has(result.id)) {
      toast.info(tr('search.alreadyInQueue'));
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
      toast.success(tr('search.addedToDownloads'));
    } catch {
      setYoutubeEnqueued((s) => {
        const next = new Set(s);
        next.delete(result.id);
        return next;
      });
      toast.error(tr('search.notAddedDownloads'));
    }
  };

  // ── Node feed: play instantly (the video id is already resolved) and save
  // through the standard download pipeline. ──
  const nodeTrack = (rec: NodeRec): Track => ({
    id: rec.id,
    title: rec.title,
    artist: rec.channel ?? '',
    duration: rec.duration,
    cover: rec.thumbnail,
    source: 'preview',
  });

  const playNodeRec = (rec: NodeRec) => {
    actions.playTrack(nodeTrack(rec));
    void api
      .emitDiscoveryEvent('music_search_played', {
        title: rec.title,
        artist: rec.channel,
        source: 'node_discover',
        youtube_id: rec.id,
      })
      .catch(() => {});
  };

  const saveNodeRec = async (rec: NodeRec) => {
    setNodeSaving((current) => new Set(current).add(rec.id));
    try {
      await actions.downloadTrack(nodeTrack(rec));
    } finally {
      setNodeSaving((current) => {
        const next = new Set(current);
        next.delete(rec.id);
        return next;
      });
    }
  };

  const nodeSaved = (rec: NodeRec) =>
    state.library.some((t) => t.id === rec.id || t.youtube_id === rec.id) ||
    state.downloads.queue.some(
      (i) => i.video_id === rec.id && i.status !== 'failed' && i.status !== 'interrupted',
    );

  onCleanup(() => {
    requestId += 1;
    ytInlineRequestId += 1;
    aborter?.abort();
    ytInlineAborter?.abort();
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
            placeholder={tr('search.placeholder')}
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
                {t.label()}
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
              recs={nodeFeed()}
              loading={nodeLoading()}
              onPick={commit}
              onFocusSearch={() => searchInput?.focus()}
              onRefresh={refreshNodeFeed}
              onPlay={playNodeRec}
              onSave={(rec) => void saveNodeRec(rec)}
              saving={(rec) => nodeSaving().has(rec.id)}
              saved={nodeSaved}
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
                      {tr('search.ytErrorHint')}{' '}
                      <button class={styles.retry} type="button" onClick={() => runYouTube(q())}>
                        {tr('common.retry')}
                      </button>
                    </>
                  ) : (
                    tr('search.ytNoResults')
                  )}
                </p>
              </Show>

              <Show when={youtubeDirect()}>
                {(result) => (
                  <section class={styles.section}>
                    <h2 class={styles.sectionTitle}>{tr('search.ytDirectSection')}</h2>
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
                  <h2 class={styles.sectionTitle}>{tr('search.ytResultsSection')}</h2>
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
                  {tr('search.catalogErrorHint')}{' '}
                  <button class={styles.retry} type="button" onClick={() => runCatalog(q())}>
                    {tr('common.retry')}
                  </button>
                </>
              ) : (
                <>
                  {tr('search.catalogNoResults')}{' '}
                  <button class={styles.retry} type="button" onClick={() => setActiveDomain('youtube')}>
                    {tr('search.searchInYt')}
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
                    <h2 class={styles.sectionTitle}>{tr('search.topResultSection')}</h2>
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
                  <h2 class={styles.sectionTitle}>{tr('search.songsSection')}</h2>
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
                <CardSection title={tr('search.artistsSection')} items={artists()} round coverStyle={coverStyle} onPick={playItem} />
              </Show>

              <Show when={albums().length > 0}>
                <CardSection title={tr('search.albumsSection')} items={albums()} coverStyle={coverStyle} onPick={playItem} />
              </Show>

              <Show when={q().trim().length >= 2}>
                <section class={styles.ytFallback}>
                  <Show
                    when={youtubeInline()}
                    fallback={
                      <button class={styles.ytFallbackCta} type="button" onClick={expandYouTubeInline}>
                        <span>{tr('search.ytFallbackCta')}</span>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                      </button>
                    }
                  >
                    <h2 class={styles.sectionTitle}>{tr('search.ytResultsSection')}</h2>
                    <Show when={youtubeLoading() && youtubeResults().length === 0}>
                      <div class={styles.skeletonGrid}>
                        <For each={Array.from({ length: 4 })}>{() => <div class={styles.skeleton} />}</For>
                      </div>
                    </Show>
                    <Show when={!youtubeLoading() && youtubeResults().length === 0}>
                      <p class={styles.hint}>
                        {youtubeError() ? (
                          <>
                            {tr('search.ytErrorHint')}{' '}
                            <button class={styles.retry} type="button" onClick={expandYouTubeInline}>
                              {tr('common.retry')}
                            </button>
                          </>
                        ) : (
                          tr('search.ytNoResults')
                        )}
                      </p>
                    </Show>
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
                  </Show>
                </section>
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
                <h2>{tr('search.chooseVersion')}</h2>
                <button class={styles.closeBtn} type="button" aria-label={tr('common.close')} onClick={() => setReview(null)}>
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

    </div>
  );
}

function StartPanel(props: {
  recents: string[];
  domain: SearchDomain;
  recs: NodeRec[];
  loading: boolean;
  onPick: (value: string) => void;
  onFocusSearch: () => void;
  onRefresh: () => void;
  onPlay: (rec: NodeRec) => void;
  onSave: (rec: NodeRec) => void;
  saving: (rec: NodeRec) => boolean;
  saved: (rec: NodeRec) => boolean;
}) {
  return (
    <div class={styles.start}>
      <Show
        when={props.recs.length > 0}
        fallback={props.loading ? <RailSkeletons /> : <SeedSearch onFocusSearch={props.onFocusSearch} />}
      >
        <section class={styles.rail}>
          <div class={styles.railHead}>
            <div>
              <h2 class={styles.railTitle}>{tr('discoverNodes.title')}</h2>
            </div>
            <button
              class={styles.railRefresh}
              type="button"
              aria-label={tr('discoverNodes.refresh')}
              title={tr('discoverNodes.refresh')}
              disabled={props.loading}
              onClick={props.onRefresh}
            >
              <svg
                classList={{ [styles.spinning]: props.loading }}
                viewBox="0 0 24 24"
                width="17"
                height="17"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
              </svg>
            </button>
          </div>
          <div class={styles.discoverGrid}>
            <For each={props.recs}>
              {(rec) => (
                <DiscoveryCard
                  title={rec.title}
                  sub={rec.channel ?? ''}
                  cover={rec.thumbnail}
                  seedKey={rec.id}
                  onPlay={() => props.onPlay(rec)}
                  onSave={props.saved(rec) ? undefined : () => props.onSave(rec)}
                  saving={props.saving(rec)}
                  saved={props.saved(rec)}
                />
              )}
            </For>
          </div>
        </section>
      </Show>

      <Show when={props.recents.length > 0}>
        <section>
          <h2 class={styles.sectionTitle}>{props.domain === 'youtube' ? tr('search.ytRecentsSection') : tr('search.recentsSection')}</h2>
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
      <h2>{tr('search.seedHeading')}</h2>
      <p>{tr('search.seedDesc')}</p>
      <button class={styles.seedAction} type="button" onClick={props.onFocusSearch}>
        {tr('search.seedAction')}
      </button>
    </div>
  );
}

function DiscoveryCard(props: {
  title: string;
  sub: string;
  cover?: string;
  seedKey: string;
  onPlay: () => void;
  onSave?: () => void;
  saving: boolean;
  saved: boolean;
}) {
  const bg = (): JSX.CSSProperties => {
    const grad = gradientFor(props.seedKey);
    return props.cover ? { background: `url("${props.cover}") center / cover no-repeat, ${grad}` } : { background: grad };
  };
  return (
    <div class={styles.discoverCard}>
      <button class={styles.discoverCardBtn} type="button" onClick={props.onPlay}>
        <span class={styles.discoverCardCover} style={bg()} />
        <span class={styles.discoverCardTitle}>{props.title}</span>
        <span class={styles.discoverCardSub}>{props.sub}</span>
      </button>
      <Switch>
        <Match when={props.onSave && !props.saved}>
          <button
            class={styles.discoverSaveBtn}
            type="button"
            aria-label={tr('search.ariaSaveToLibrary')}
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
        <Match when={props.saved}>
          <span class={styles.discoverSavedBadge} aria-label={tr('search.ariaSaved')}>
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
        <button class={styles.primaryIcon} type="button" disabled={props.saving} aria-label={tr('search.ariaSave')} onClick={props.onSave}>
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
        <span class={styles.done} aria-label={tr('search.ariaInLibrary')}>
          <CheckIcon />
        </span>
      </Show>
      <Show when={canSave()}>
        <button
          class={styles.iconBtn}
          type="button"
          disabled={props.saving}
          aria-label={tr('search.ariaSave')}
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
  if (item.type === 'library_track') return tr('search.labelLibraryTrack');
  if (item.type === 'track') return tr('search.labelTrack');
  if (item.type === 'artist') return tr('search.labelArtist');
  if (item.type === 'album') return tr('search.labelAlbum');
  return tr('search.labelPlaylist');
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
