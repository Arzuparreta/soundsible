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
import { itemArtist, itemBusy, playCatalogItem, cancelCatalogResolve } from '../lib/catalogItem';
import SearchResultRow from '../components/SearchResultRow';
import { Spinner } from '../components/Spinner';
import type { CatalogItem, CatalogSaveResponse, SearchResult, Track } from '../types/music';
import styles from './Search.module.css';
import { coverStyle } from '../lib/cover';
import { formatDuration } from '../lib/format';
import { attachContextMenu } from '../lib/contextMenu';
import { trackMenuOptions } from '../components/trackActions';
import type { ActionMenuOptions } from '../components/ActionMenu';
import { SkeletonCards, SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';

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

function candidateVideoId(candidate: Record<string, unknown>): string {
  return String(candidate.video_id || candidate.id || '');
}

export default function Search() {
  const navigate = useNavigate();
  const [domain, setDomain] = createSignal<SearchDomain>('music');
  const [q, setQ] = createSignal('');
  const [tab, setTab] = createSignal<SearchTab>('all');
  const [items, setItems] = createSignal<CatalogItem[]>([]);
  const [interpretedAs, setInterpretedAs] = createSignal('');
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
  const [nodeSaving, setNodeSaving] = createSignal<Set<string>>(new Set());

  let aborter: AbortController | undefined;
  let suggestAborter: AbortController | undefined;
  let debounce: number | undefined;
  let suggestDebounce: number | undefined;
  let requestId = 0;
  let searchInput: HTMLInputElement | undefined;
  const youtubeCache = new Map<string, SearchResult[]>();

  const libYt = createMemo(() => new Set(state.library.map((t) => t.youtube_id).filter((x): x is string => !!x)));
  const songs = createMemo(() =>
    items().filter((item) => ['track', 'library_track'].includes(item.type)),
  );
  onMount(() => ensureNodeFeed());

  const runCatalog = (query: string, nextTab = tab()) => {
    query = query.trim();
    const current = ++requestId;
    aborter?.abort();
    aborter = undefined;
    setSearchError(false);
    setInterpretedAs('');
    setYoutubeError(false);
    setYoutubeDirect(null);
    setYoutubeResults([]);
    setYoutubeLoading(false);
    if (query.length < 2) {
      setItems([]);
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
        setInterpretedAs(res.interpreted_as ?? '');
      })
      .catch((e) => {
        if (current !== requestId || isAbort(e)) return;
        setItems([]);
        setInterpretedAs('');
        setSearchError(true);
      })
      .finally(() => {
        if (current === requestId) setLoading(false);
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
    setInterpretedAs('');
    setLoading(false);
    setItems([]);
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

  const itemCoverStyle = (item: CatalogItem, round = false): JSX.CSSProperties => ({
    ...coverStyle(item.id, item.cover || (item.track_id ? coverUrl(item.track_id) : null)),
    'border-radius': round ? 'var(--radius-full)' : undefined,
  });

  const playItem = (item: CatalogItem) => {
    if (item.type === 'track' || item.type === 'library_track') {
      void playCatalogItem(item);
    } else if (item.type === 'artist') {
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
        confirm_video_id:
          confirmVideoId ||
          (item.external_ids?.youtube_id ? String(item.external_ids.youtube_id) : undefined),
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
    recommendation: rec.recommendation_identity
      ? {
          identity: rec.recommendation_identity,
          source: 'discover',
          reason: rec.seedArtist ? tr('discoverNodes.fromArtist', { artist: rec.seedArtist }) : undefined,
        }
      : undefined,
  });

  const playNodeRec = (rec: NodeRec) => {
    actions.playTrack(nodeTrack(rec));
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
    aborter?.abort();
    cancelCatalogResolve();
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
              menu={(rec) => trackMenuOptions(nodeTrack(rec), { navigate })}
            />
          </Match>
          <Match when={domain() === 'youtube'}>
            <div class={styles.results}>
              <Show when={youtubeLoading() && youtubeResults().length === 0 && !youtubeDirect()}>
                <SkeletonRows count={8} compact />
              </Show>

              <Show when={!youtubeLoading() && !youtubeDirect() && youtubeResults().length === 0 && q().trim().length >= 2}>
                <EmptyState compact tone={youtubeError() ? 'danger' : 'neutral'}>
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
                </EmptyState>
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
            <SkeletonRows count={8} compact />
          </Match>
          <Match when={!loading() && items().length === 0}>
            <EmptyState compact tone={searchError() ? 'danger' : 'neutral'}>
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
            </EmptyState>
          </Match>
          <Match when={true}>
            <div class={styles.results}>
              <section class={styles.section}>
                <h2 class={styles.sectionTitle}>{tr('search.resultsSection')}</h2>
                <Show when={interpretedAs()}>
                  {(name) => (
                    <p class={styles.interpretation}>
                      {tr('search.interpretedAs', { name: name() })}
                    </p>
                  )}
                </Show>
                <For each={items()}>
                  {(item) => (
                    <Switch>
                      <Match when={item.type === 'track' || item.type === 'library_track'}>
                        <SongResult
                          item={item}
                          coverStyle={itemCoverStyle}
                          active={state.playback.currentTrack?.id === (item.track_id || item.id)}
                          saving={saving().has(item.id)}
                          saved={saved().has(item.id) || !!item.action_state?.in_library}
                          busy={itemBusy(item)}
                          onPlay={() => playItem(item)}
                          onSave={() => saveItem(item)}
                        />
                      </Match>
                      <Match when={true}>
                        <EntityResult
                          item={item}
                          coverStyle={itemCoverStyle}
                          onPick={() => playItem(item)}
                        />
                      </Match>
                    </Switch>
                  )}
                </For>
              </section>
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
  menu: (rec: NodeRec) => ActionMenuOptions;
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
                  menu={() => props.menu(rec)}
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
    <button class={styles.seedHint} type="button" onClick={props.onFocusSearch}>
      {tr('search.seedHeading')}
    </button>
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
  menu?: () => ActionMenuOptions | null;
}) {
  const bg = (): JSX.CSSProperties => coverStyle(props.seedKey, props.cover);
  return (
    <div
      class={styles.discoverCard}
      ref={(el) => attachContextMenu(el, () => props.menu?.() ?? null)}
    >
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
              <Spinner size={16} onAccent />
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
  return <SkeletonCards count={12} />;
}

function SongResult(props: {
  item: CatalogItem;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  active: boolean;
  saving: boolean;
  saved: boolean;
  busy: boolean;
  onPlay: () => void;
  onSave: () => void;
}) {
  const canSave = () => props.item.type === 'track' && !props.saved;
  return (
    <div
      classList={{ [styles.songRow]: true, [styles.activeSong]: props.active }}
      aria-busy={props.busy}
      onClick={props.onPlay}
    >
      <span class={styles.songCover} style={props.coverStyle(props.item)}>
        <Show when={props.busy}>
          <span class={styles.coverBusy}>
            <Spinner size={18} />
          </span>
        </Show>
      </span>
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
            <Spinner size={17} />
          </Show>
        </button>
      </Show>
    </div>
  );
}

function EntityResult(props: {
  item: CatalogItem;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  onPick: () => void;
}) {
  return (
    <button class={styles.songRow} type="button" onClick={props.onPick}>
      <span
        class={styles.songCover}
        style={props.coverStyle(props.item, props.item.type === 'artist')}
      />
      <span class={styles.songMeta}>
        <span class={styles.songTitle}>{props.item.title}</span>
        <span class={styles.songSub}>{props.item.subtitle || itemArtist(props.item)}</span>
      </span>
      <span class={styles.source}>{props.item.source}</span>
      <span class={styles.pill}>{labelFor(props.item)}</span>
    </button>
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
