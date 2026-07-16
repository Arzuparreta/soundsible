import { createEffect, createMemo, createSignal, For, Match, Show, Switch, onCleanup, untrack, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api } from '../lib/api';
import { actions, state } from '../stores';
import { coverUrl } from '../lib/media';
import { toast } from '../lib/toast';
import { parseYouTubeInput } from '../lib/youtube';
import { ensureDiscover, recentSaved, type RecentlySavedItem } from '../lib/discover';
import { ensureNodeFeed, nodeFeed, nodeLoading, refreshNodeFeed } from '../lib/nodeDiscover';
import { libraryTrackFor, queueIndexOf, resultToTrack } from '../lib/queueDiscovery';
import { prefetchPreviews } from '../lib/prefetch';
import { isPodcastTrack } from '../lib/track';
import { artistPath, albumPath } from '../lib/artistRoute';
import { openTrackMenu } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { LyricsPanel } from './LyricsPanel';
import { t } from '../lib/i18n';
import type { CatalogItem, SearchResult, Track } from '../types/music';
import styles from './SearchPanel.module.css';

export type PanelSide = 'left' | 'right';
export type PanelTab = 'search' | 'discover' | 'lyrics';

/** Search panel visibility + docking side (desktop Now Playing). Persisted so
 * the layout comes back the way the user arranged it. */
const [panelOpen, setPanelOpen] = createSignal(localStorage.getItem('np:panel') !== 'closed');
const [panelSide, setPanelSide] = createSignal<PanelSide>(
  localStorage.getItem('np:panelSide') === 'right' ? 'right' : 'left',
);
export { panelOpen, panelSide };

/** Three modes, three intents: "search" is *I know what I want to hear*;
 * "discover" is *play me something — I don't know what*; "lyrics" follows
 * along with what's playing. Persisted. */
const _storedTab = localStorage.getItem('np:panelTab');
const [panelTab, setPanelTab] = createSignal<PanelTab>(
  _storedTab === 'discover' || _storedTab === 'lyrics' ? _storedTab : 'search',
);
export { panelTab };

export function selectPanelTab(tab: PanelTab): void {
  setPanelTab(tab);
  localStorage.setItem('np:panelTab', tab);
}

export function togglePanel(): void {
  const next = !panelOpen();
  setPanelOpen(next);
  localStorage.setItem('np:panel', next ? 'open' : 'closed');
}

export function swapPanelSide(): void {
  const next: PanelSide = panelSide() === 'right' ? 'left' : 'right';
  setPanelSide(next);
  localStorage.setItem('np:panelSide', next);
}

/* ── Recent searches (the "I know what I want" shortcut memory) ── */
const RECENTS_KEY = 'np:recentSearches';
const RECENTS_MAX = 8;

function readRecents(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}

const [recentQueries, setRecentQueries] = createSignal<string[]>(readRecents());

/** Record a query the moment it produced a play/queue action — that's the
 * signal it was a *good* query worth re-offering. Pasted URLs are excluded. */
function pushRecentQuery(query: string): void {
  const v = query.trim();
  if (!v || parseYouTubeInput(v)) return;
  const next = [v, ...recentQueries().filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, RECENTS_MAX);
  setRecentQueries(next);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage full / disabled */
  }
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 46% 31%), hsl(${(h + 42) % 360} 54% 18%))`;
}

function itemArtist(item: CatalogItem): string {
  return item.artist || item.subtitle || '';
}

/**
 * Soundsible navigation side panel for the Now Playing view. Two tabs:
 *
 * - Search — one box searches everything: your library and new music from the
 *   internet (unified catalog, YouTube fallback, direct URL support). Its
 *   empty state offers recent successful searches and recently saved tracks.
 * - Discover — for when you don't know what to play: one-tap song radio and
 *   surprise-me seeds, live "similar to what's playing" suggestions, and the
 *   node feed — radio-style recommendations branching out from the library,
 *   recency-weighted and interleaved (see lib/nodeDiscover.ts).
 *
 * Every row, whatever its source, plugs into the same playback pipeline: tap
 * plays it right now without discarding the queue (actions.playNow), ＋
 * appends to the queue, and ⋯ opens the full track menu once the item is
 * resolved to a playable track.
 */
export function SearchPanel() {
  const navigate = useNavigate();
  const [q, setQ] = createSignal('');
  const [items, setItems] = createSignal<CatalogItem[]>([]);
  const [sectionIds, setSectionIds] = createSignal<Record<string, string[]>>({});
  const [loading, setLoading] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [ytResults, setYtResults] = createSignal<SearchResult[]>([]);
  const [ytLoading, setYtLoading] = createSignal(false);
  const [direct, setDirect] = createSignal<SearchResult | null>(null);
  const [resolving, setResolving] = createSignal<Set<string>>(new Set());

  let inputEl: HTMLInputElement | undefined;
  let debounce: number | undefined;
  let aborter: AbortController | undefined;
  let requestId = 0;
  /** External items resolved to playable preview tracks (catalog id / discovery key). */
  const resolvedCache = new Map<string, Track>();

  ensureDiscover();
  // Re-check the node feed's freshness whenever the discover tab comes into view.
  createEffect(() => {
    if (panelTab() === 'discover') ensureNodeFeed();
  });

  const byId = createMemo(() => new Map(items().map((item) => [item.id, item] as const)));
  const songs = createMemo(() =>
    (sectionIds().songs ?? [])
      .map((id) => byId().get(id))
      .filter((item): item is CatalogItem => !!item)
      .concat(items().filter((item) => item.type === 'track' || item.type === 'library_track'))
      .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
      .slice(0, 20),
  );
  const chips = createMemo(() =>
    items()
      .filter((item) => item.type === 'artist' || item.type === 'album')
      .slice(0, 6),
  );
  const searching = createMemo(() => q().trim().length >= 2 || !!parseYouTubeInput(q()));

  // ── Search: unified catalog first, YouTube as fallback, URLs direct ──
  const runYouTubeFallback = (query: string, currentReq: number, signal: AbortSignal) => {
    setYtLoading(true);
    api
      .searchYouTube(query, signal)
      .then((res) => {
        if (currentReq !== requestId) return;
        setYtResults(res);
      })
      .catch((e) => {
        if (currentReq !== requestId || isAbort(e)) return;
        setSearchError(true);
      })
      .finally(() => {
        if (currentReq === requestId) setYtLoading(false);
      });
  };

  const runSearch = (raw: string) => {
    const query = raw.trim();
    const currentReq = ++requestId;
    aborter?.abort();
    aborter = undefined;
    setSearchError(false);
    setDirect(null);
    setYtResults([]);
    setYtLoading(false);

    const url = parseYouTubeInput(query);
    if (url) {
      setItems([]);
      setSectionIds({});
      setLoading(false);
      aborter = new AbortController();
      setYtLoading(true);
      api
        .peekYouTube(url.url, aborter.signal)
        .then((res) => {
          if (currentReq !== requestId) return;
          setDirect(
            res ?? {
              id: url.videoId,
              title: t('searchPanel.fallbackTitle'),
              channel: t('searchPanel.fallbackChannel'),
              thumbnail: `https://img.youtube.com/vi/${url.videoId}/mqdefault.jpg`,
            },
          );
        })
        .catch((e) => {
          if (currentReq !== requestId || isAbort(e)) return;
          setDirect({ id: url.videoId, title: t('searchPanel.fallbackTitle'), channel: t('searchPanel.fallbackChannel') });
        })
        .finally(() => {
          if (currentReq === requestId) setYtLoading(false);
        });
      return;
    }

    if (query.length < 2) {
      setItems([]);
      setSectionIds({});
      setLoading(false);
      return;
    }
    aborter = new AbortController();
    const { signal } = aborter;
    setLoading(true);
    api
      .searchCatalog(query, signal, 'all')
      .then((res) => {
        if (currentReq !== requestId) return;
        setItems(res.items ?? []);
        const next: Record<string, string[]> = {};
        for (const section of res.sections ?? []) next[section.id] = section.item_ids ?? [];
        setSectionIds(next);
        // No playable songs in the catalog → widen the net to YouTube.
        const hasSongs = (res.items ?? []).some((i) => i.type === 'track' || i.type === 'library_track');
        if (!hasSongs) runYouTubeFallback(query, currentReq, signal);
      })
      .catch((e) => {
        if (currentReq !== requestId || isAbort(e)) return;
        setItems([]);
        setSectionIds({});
        runYouTubeFallback(query, currentReq, signal);
      })
      .finally(() => {
        if (currentReq === requestId) setLoading(false);
      });
  };

  const onInput = (value: string) => {
    setQ(value);
    clearTimeout(debounce);
    debounce = window.setTimeout(() => runSearch(value), 250);
  };

  const commit = (value: string) => {
    setQ(value);
    clearTimeout(debounce);
    runSearch(value);
    inputEl?.focus();
  };

  const clearQuery = () => {
    clearTimeout(debounce);
    requestId += 1;
    aborter?.abort();
    setQ('');
    setItems([]);
    setSectionIds({});
    setYtResults([]);
    setDirect(null);
    setLoading(false);
    setYtLoading(false);
    setSearchError(false);
    inputEl?.focus();
  };

  onCleanup(() => {
    clearTimeout(debounce);
    aborter?.abort();
  });

  // ── Source → Track resolution (everything becomes a playable Track) ──
  const markResolving = (key: string, on: boolean) =>
    setResolving((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const trackForCatalog = async (item: CatalogItem): Promise<Track | null> => {
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
    const cached = resolvedCache.get(item.id);
    if (cached) return cached;
    const artist = itemArtist(item);
    if (!artist || !item.title) return null;
    const res = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration });
    if (!res.video_id) return null;
    const track: Track = {
      id: res.video_id,
      title: item.title,
      artist,
      album: item.album,
      duration: item.duration,
      cover: item.cover,
      source: 'preview',
    };
    resolvedCache.set(item.id, track);
    return track;
  };

  const trackForResult = (r: SearchResult): Track => libraryTrackFor(state.library, r) ?? resultToTrack(r);

  // ── Speculative warm-up: while the user is still deciding, resolve the top
  // of the results in the background so the eventual play click starts
  // near-instantly. YouTube rows already carry playable ids; top catalog
  // (Deezer) songs are resolved to a video id first (server-cached forever).
  const prefetchedCatalog = new Set<string>();
  createEffect(() => {
    if (!searching()) return;
    const directResult = direct();
    const ytTop = ytResults().slice(0, 3).map((r) => r.id);
    const topSongs = songs().slice(0, 2);
    untrack(() => {
      if (directResult) prefetchPreviews([directResult.id]);
      prefetchPreviews(ytTop);
      for (const item of topSongs) {
        if (item.track_id || item.type === 'library_track') continue;
        if (item.raw?.id && typeof item.raw.id === 'string') {
          prefetchPreviews([item.raw.id]);
          continue;
        }
        if (prefetchedCatalog.has(item.id)) continue;
        prefetchedCatalog.add(item.id);
        void trackForCatalog(item)
          .then((t) => {
            if (t && t.source === 'preview') prefetchPreviews([t.id]);
          })
          .catch(() => {});
      }
    });
  });

  // ── Row actions: play now (queue-preserving) / add to queue / full menu ──
  const withTrack = async (key: string, get: () => Promise<Track | null>, use: (t: Track) => void) => {
    markResolving(key, true);
    try {
      const track = await get();
      if (!track) throw new Error('not-found');
      use(track);
    } catch {
      toast.error(t('searchPanel.noResolve'));
    } finally {
      markResolving(key, false);
    }
  };

  const playNow = (track: Track) => {
    if (panelTab() === 'search' && searching()) pushRecentQuery(q());
    actions.playNow(track);
    if (track.source === 'preview') {
      void api
        .emitDiscoveryEvent('music_search_played', {
          title: track.title,
          artist: track.artist,
          source: 'now_playing_panel',
          youtube_id: track.id,
          query: q().trim() || undefined,
        })
        .catch(() => {});
    }
  };

  const addToQueue = (track: Track) => {
    if (queueIndexOf(state.playback.queue, track) !== -1) {
      toast.info(t('searchPanel.inQueue'));
      return;
    }
    if (panelTab() === 'search' && searching()) pushRecentQuery(q());
    actions.enqueue(track);
    if (track.source === 'preview') {
      void api
        .emitDiscoveryEvent('music_added_to_queue', {
          title: track.title,
          artist: track.artist,
          source: 'now_playing_panel',
          youtube_id: track.id,
          query: q().trim() || undefined,
        })
        .catch(() => {});
    }
  };

  const openMenu = (track: Track, ev?: MouseEvent) =>
    openTrackMenu(
      track,
      {
        navigate,
        onAddToPlaylist: openPlaylistPicker,
        onEditMetadata: openMetadataEditor,
        onPlayOnDevice: openPlayOnDevice,
      },
      ev,
    );

  // Known ids let rows show live "playing / queued" state without resolving.
  const knownId = (item: CatalogItem): string | null =>
    item.track_id ?? (typeof item.raw?.id === 'string' ? item.raw.id : null) ?? resolvedCache.get(item.id)?.id ?? null;

  const isActive = (id: string | null) => !!id && state.playback.currentTrack?.id === id;
  const isQueued = (id: string | null) =>
    !!id && state.playback.queue.some((t) => t.id === id || t.youtube_id === id);

  const coverStyle = (cover: string | undefined, seed: string): JSX.CSSProperties => {
    const grad = gradientFor(seed);
    return cover ? { background: `url("${cover}") center / cover no-repeat, ${grad}` } : { background: grad };
  };

  // ── Discover: "similar to what's playing" (live, per-track cached) ──
  const [similar, setSimilar] = createSignal<SearchResult[]>([]);
  const [similarLoading, setSimilarLoading] = createSignal(false);
  const similarCache = new Map<string, SearchResult[]>();
  let similarReq = 0;

  const ytIdFor = async (track: Track): Promise<string | null> => {
    if (track.youtube_id) return track.youtube_id;
    if (track.source === 'preview') return track.id;
    if (!track.artist || !track.title) return null;
    try {
      const res = await api.resolveCatalogItem({ artist: track.artist, title: track.title, duration: track.duration });
      return res.video_id ?? null;
    } catch {
      return null;
    }
  };

  const loadSimilar = async (cur: Track | null) => {
    const req = ++similarReq;
    if (!cur || isPodcastTrack(cur)) {
      setSimilar([]);
      setSimilarLoading(false);
      return;
    }
    const cached = similarCache.get(cur.id);
    if (cached) {
      setSimilar(cached);
      setSimilarLoading(false);
      return;
    }
    setSimilar([]);
    setSimilarLoading(true);
    try {
      const yt = await ytIdFor(cur);
      if (req !== similarReq) return;
      if (!yt) return;
      const res = await api.relatedYouTube(yt);
      if (req !== similarReq) return;
      const rows = res.filter((r) => r.id !== yt && r.id !== cur.id).slice(0, 8);
      similarCache.set(cur.id, rows);
      setSimilar(rows);
    } catch {
      /* the section simply stays hidden */
    } finally {
      if (req === similarReq) setSimilarLoading(false);
    }
  };

  createEffect(() => {
    if (panelTab() !== 'discover') return;
    const cur = state.playback.currentTrack;
    untrack(() => void loadSimilar(cur ?? null));
  });

  // ── Discover: one-tap seeds ──
  const currentSeed = createMemo(() => {
    const cur = state.playback.currentTrack;
    return cur && !isPodcastTrack(cur) ? cur : null;
  });

  /** Favourites make the best surprise seeds; fall back to the whole library
   * while the taste signal is still thin. */
  const surprisePool = createMemo(() => {
    const favs = state.library.filter((tk) => state.favorites.includes(tk.id));
    return favs.length >= 3 ? favs : state.library;
  });

  const surpriseMe = () => {
    const pool = surprisePool();
    if (pool.length === 0) return;
    void actions.startRadio(pool[Math.floor(Math.random() * pool.length)]);
  };

  // ── Search tab empty state: recently saved as playable rows ──
  const savedAsTrack = (item: RecentlySavedItem): Track | null => {
    if (item.in_library) {
      const found = state.library.find((tk) => tk.id === item.track_id);
      if (found) return found;
    }
    if (!item.youtube_id) return null;
    return { id: item.youtube_id, title: item.title, artist: item.artist, cover: item.cover, source: 'preview' };
  };

  const savedRows = createMemo(() =>
    recentSaved()
      .map((item) => ({ item, track: savedAsTrack(item) }))
      .filter((row): row is { item: RecentlySavedItem; track: Track } => !!row.track)
      .slice(0, 6),
  );

  return (
    <aside
      classList={{ [styles.panel]: true, [styles.closed]: !panelOpen() }}
      data-side={panelSide()}
      aria-label={t('searchPanel.ariaSearch')}
    >
      <header class={styles.head}>
        <div class={styles.tabs} role="tablist">
          <button
            classList={{ [styles.tab]: true, [styles.tabOn]: panelTab() === 'search' }}
            type="button"
            role="tab"
            aria-selected={panelTab() === 'search'}
            onClick={() => selectPanelTab('search')}
          >
            {t('searchPanel.tabSearch')}
          </button>
          <button
            classList={{ [styles.tab]: true, [styles.tabOn]: panelTab() === 'discover' }}
            type="button"
            role="tab"
            aria-selected={panelTab() === 'discover'}
            onClick={() => selectPanelTab('discover')}
          >
            {t('searchPanel.tabDiscover')}
          </button>
          <button
            classList={{ [styles.tab]: true, [styles.tabOn]: panelTab() === 'lyrics' }}
            type="button"
            role="tab"
            aria-selected={panelTab() === 'lyrics'}
            onClick={() => selectPanelTab('lyrics')}
          >
            {t('searchPanel.tabLyrics')}
          </button>
        </div>
        <div class={styles.headActions}>
          <button
            class={styles.headBtn}
            type="button"
            aria-label={panelSide() === 'right' ? t('searchPanel.moveLeft') : t('searchPanel.moveRight')}
            title={t('searchPanel.moveTitle')}
            onClick={swapPanelSide}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M8 7L4 12l4 5M16 7l4 5-4 5" />
            </svg>
          </button>
          <button class={styles.headBtn} type="button" aria-label={t('searchPanel.closePanel')} onClick={togglePanel}>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>

      <Show
        when={panelTab() === 'search'}
        fallback={
          <Show when={panelTab() === 'discover'} fallback={<LyricsPanel />}>
          {/* ── Discover: "I don't know what to play" ── */}
          <div class={styles.body}>
            <div class={styles.tiles}>
              <button
                classList={{ [styles.tile]: true, [styles.tilePulse]: state.playback.radioLoading }}
                type="button"
                disabled={!currentSeed()}
                onClick={() => {
                  const seed = currentSeed();
                  if (seed) void actions.startRadio(seed);
                }}
              >
                <span class={styles.tileIcon}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M4 12a8 8 0 018-8M4 12a8 8 0 008 8M8 12a4 4 0 014-4" />
                    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
                  </svg>
                </span>
                <span class={styles.tileMeta}>
                  <span class={styles.tileTitle}>{t('searchPanel.radioTile')}</span>
                  <span class={styles.tileSub}>{t('searchPanel.radioTileSub')}</span>
                </span>
              </button>

              <button class={styles.tile} type="button" disabled={surprisePool().length === 0} onClick={surpriseMe}>
                <span class={styles.tileIcon}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" />
                  </svg>
                </span>
                <span class={styles.tileMeta}>
                  <span class={styles.tileTitle}>{t('searchPanel.surpriseTile')}</span>
                  <span class={styles.tileSub}>{t('searchPanel.surpriseTileSub')}</span>
                </span>
              </button>
            </div>

            <Show when={similarLoading()}>
              <section class={styles.section}>
                <h3 class={styles.sectionTitle}>{t('searchPanel.similarSection')}</h3>
                <SkeletonRows count={4} />
              </section>
            </Show>

            <Show when={!similarLoading() && similar().length > 0}>
              <section class={styles.section}>
                <h3 class={styles.sectionTitle}>{t('searchPanel.similarSection')}</h3>
                <For each={similar()}>
                  {(r) => (
                    <PanelRow
                      title={r.title}
                      sub={r.channel ?? ''}
                      coverStyle={coverStyle(r.thumbnail, r.id)}
                      inLibrary={!!libraryTrackFor(state.library, r)}
                      active={isActive(trackForResult(r).id)}
                      queued={isQueued(r.id)}
                      resolving={false}
                      onPlay={() => playNow(trackForResult(r))}
                      onQueue={() => addToQueue(trackForResult(r))}
                      onMenu={(ev) => openMenu(trackForResult(r), ev)}
                    />
                  )}
                </For>
              </section>
            </Show>

            <Show when={nodeFeed().length > 0}>
              <section class={styles.section}>
                <div class={styles.sectionHead}>
                  <h3 class={styles.sectionTitle}>{t('discoverNodes.title')}</h3>
                  <button
                    class={styles.headBtn}
                    type="button"
                    aria-label={t('discoverNodes.refresh')}
                    title={t('discoverNodes.refresh')}
                    disabled={nodeLoading()}
                    onClick={refreshNodeFeed}
                  >
                    <svg
                      classList={{ [styles.spinning]: nodeLoading() }}
                      viewBox="0 0 24 24"
                      width="15"
                      height="15"
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
                <For each={nodeFeed()}>
                  {(rec) => (
                    <PanelRow
                      title={rec.title}
                      sub={rec.channel ?? ''}
                      coverStyle={coverStyle(rec.thumbnail, rec.id)}
                      inLibrary={!!libraryTrackFor(state.library, rec)}
                      active={isActive(trackForResult(rec).id)}
                      queued={isQueued(rec.id)}
                      resolving={false}
                      onPlay={() => playNow(trackForResult(rec))}
                      onQueue={() => addToQueue(trackForResult(rec))}
                      onMenu={(ev) => openMenu(trackForResult(rec), ev)}
                    />
                  )}
                </For>
              </section>
            </Show>

            <Show when={nodeLoading() && nodeFeed().length === 0}>
              <section class={styles.section}>
                <h3 class={styles.sectionTitle}>{t('discoverNodes.title')}</h3>
                <SkeletonRows count={6} />
              </section>
            </Show>

            <Show
              when={
                !nodeLoading() && nodeFeed().length === 0 && !similarLoading() && similar().length === 0
              }
            >
              <p class={styles.hint}>{t('searchPanel.discoverHint')}</p>
            </Show>
          </div>
          </Show>
        }
      >
        {/* ── Search: "I know what I want to hear" ── */}
        <div class={styles.searchBar}>
          <svg class={styles.searchIcon} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputEl}
            class={styles.input}
            type="search"
            placeholder={t('searchPanel.placeholder')}
            value={q()}
            onInput={(e) => onInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && q()) {
                e.stopPropagation();
                clearQuery();
              }
            }}
          />
          <Show when={q()}>
            <button class={styles.clearBtn} type="button" aria-label={t('searchPanel.clear')} onClick={clearQuery}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </Show>
        </div>

        <div class={styles.body}>
          <Switch>
            <Match when={!searching()}>
              <Show when={recentQueries().length > 0}>
                <section class={styles.section}>
                  <h3 class={styles.sectionTitle}>{t('searchPanel.recentSearches')}</h3>
                  <div class={styles.recentWrap}>
                    <For each={recentQueries()}>
                      {(rq) => (
                        <button class={styles.recentChip} type="button" onClick={() => commit(rq)}>
                          {rq}
                        </button>
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              <Show when={savedRows().length > 0}>
                <section class={styles.section}>
                  <h3 class={styles.sectionTitle}>{t('searchPanel.recentlySaved')}</h3>
                  <For each={savedRows()}>
                    {(row) => (
                      <PanelRow
                        title={row.track.title}
                        sub={row.track.artist}
                        coverStyle={coverStyle(
                          row.item.in_library ? coverUrl(row.item.track_id) : row.item.cover,
                          row.item.track_id,
                        )}
                        inLibrary={row.item.in_library}
                        active={isActive(row.track.id)}
                        queued={isQueued(row.track.id)}
                        resolving={false}
                        onPlay={() => playNow(row.track)}
                        onQueue={() => addToQueue(row.track)}
                        onMenu={(ev) => openMenu(row.track, ev)}
                      />
                    )}
                  </For>
                </section>
              </Show>

              <Show when={recentQueries().length === 0 && savedRows().length === 0}>
                <p class={styles.hint}>{t('searchPanel.hint')}</p>
              </Show>
            </Match>

            <Match when={loading() && songs().length === 0}>
              <SkeletonRows count={8} />
            </Match>

            <Match when={true}>
              <Show when={chips().length > 0}>
                <div class={styles.chips}>
                  <For each={chips()}>
                    {(item) => (
                      <button
                        class={styles.chip}
                        type="button"
                        onClick={() => {
                          if (item.type === 'artist') {
                            const deezerId = item.external_ids?.deezer_artist_id
                              ? String(item.external_ids.deezer_artist_id)
                              : undefined;
                            navigate(artistPath(item.title, { view: 'discover', deezerId }));
                          } else if (item.type === 'album') {
                            const deezerId = item.external_ids?.deezer_album_id
                              ? String(item.external_ids.deezer_album_id)
                              : undefined;
                            navigate(albumPath(item.title, itemArtist(item), { view: 'discover', deezerId }));
                          } else {
                            commit(item.title);
                          }
                        }}
                      >
                        <span class={styles.chipCover} style={coverStyle(item.cover, item.id)} data-round={item.type === 'artist' ? '' : undefined} />
                        <span class={styles.chipMeta}>
                          <span class={styles.chipTitle}>{item.title}</span>
                          <span class={styles.chipSub}>{item.type === 'artist' ? t('searchPanel.chipArtist') : t('searchPanel.chipAlbum')}</span>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={direct()}>
                {(r) => (
                  <section class={styles.section}>
                    <h3 class={styles.sectionTitle}>{t('searchPanel.directSection')}</h3>
                    <PanelRow
                      title={r().title}
                      sub={r().channel ?? ''}
                      coverStyle={coverStyle(r().thumbnail, r().id)}
                      inLibrary={!!libraryTrackFor(state.library, r())}
                      active={isActive(trackForResult(r()).id)}
                      queued={isQueued(r().id)}
                      resolving={false}
                      onPlay={() => playNow(trackForResult(r()))}
                      onQueue={() => addToQueue(trackForResult(r()))}
                      onMenu={(ev) => openMenu(trackForResult(r()), ev)}
                    />
                  </section>
                )}
              </Show>

              <Show when={songs().length > 0}>
                <section class={styles.section}>
                  <h3 class={styles.sectionTitle}>{t('searchPanel.songsSection')}</h3>
                  <For each={songs()}>
                    {(item) => (
                      <PanelRow
                        title={item.title}
                        sub={item.subtitle || itemArtist(item)}
                        coverStyle={coverStyle(item.cover || (item.track_id ? coverUrl(item.track_id) : undefined), item.id)}
                        inLibrary={item.type === 'library_track' || !!item.action_state?.in_library}
                        active={isActive(knownId(item))}
                        queued={isQueued(knownId(item))}
                        resolving={resolving().has(item.id)}
                        onPlay={() => void withTrack(item.id, () => trackForCatalog(item), playNow)}
                        onQueue={() => void withTrack(item.id, () => trackForCatalog(item), addToQueue)}
                        onMenu={(ev) => void withTrack(item.id, () => trackForCatalog(item), (t) => openMenu(t, ev))}
                      />
                    )}
                  </For>
                </section>
              </Show>

              <Show when={ytLoading() && ytResults().length === 0 && !direct()}>
                <SkeletonRows count={6} />
              </Show>

              <Show when={ytResults().length > 0}>
                <section class={styles.section}>
                  <h3 class={styles.sectionTitle}>{t('searchPanel.ytSection')}</h3>
                  <For each={ytResults()}>
                    {(r) => (
                      <PanelRow
                        title={r.title}
                        sub={r.channel ?? ''}
                        coverStyle={coverStyle(r.thumbnail, r.id)}
                        inLibrary={!!libraryTrackFor(state.library, r)}
                        active={isActive(trackForResult(r).id)}
                        queued={isQueued(r.id)}
                        resolving={false}
                        onPlay={() => playNow(trackForResult(r))}
                        onQueue={() => addToQueue(trackForResult(r))}
                        onMenu={(ev) => openMenu(trackForResult(r), ev)}
                      />
                    )}
                  </For>
                </section>
              </Show>

              <Show when={!loading() && !ytLoading() && !direct() && songs().length === 0 && ytResults().length === 0 && chips().length === 0}>
                <p class={styles.hint}>
                  {searchError() ? (
                    <>
                      {t('searchPanel.searchError')}{' '}
                      <button class={styles.retry} type="button" onClick={() => runSearch(q())}>
                        {t('searchPanel.retry')}
                      </button>
                    </>
                  ) : (
                    t('searchPanel.noResults')
                  )}
                </p>
              </Show>
            </Match>
          </Switch>
        </div>
      </Show>
    </aside>
  );
}

function PanelRow(props: {
  title: string;
  sub: string;
  coverStyle: JSX.CSSProperties;
  inLibrary: boolean;
  active: boolean;
  queued: boolean;
  resolving: boolean;
  onPlay: () => void;
  onQueue: () => void;
  onMenu: (ev: MouseEvent) => void;
}) {
  return (
    <div
      classList={{ [styles.row]: true, [styles.rowActive]: props.active }}
      onClick={() => props.onPlay()}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e);
      }}
    >
      <span class={styles.cover} style={props.coverStyle} />
      <span class={styles.meta}>
        <span class={styles.rowTitle}>{props.title}</span>
        <span class={styles.rowSub}>
          <Show when={props.inLibrary}>
            <svg class={styles.libMark} viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" aria-label={t('searchPanel.ariaInLibrary')}>
              <path d="M5 12l5 5L20 7" />
            </svg>
          </Show>
          {props.sub}
        </span>
      </span>
      <Show when={props.resolving}>
        <span class={styles.spinner} aria-label={t('searchPanel.ariaLoading')} />
      </Show>
      <Show
        when={!props.queued}
        fallback={
          <span class={styles.queuedMark} aria-label={t('searchPanel.ariaQueued')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
              <path d="M5 12l5 5L20 7" />
            </svg>
          </span>
        }
      >
        <button
          class={styles.rowBtn}
          type="button"
          aria-label={t('searchPanel.ariaAddQueue')}
          title={t('searchPanel.ariaAddQueue')}
          onClick={(e) => {
            e.stopPropagation();
            props.onQueue();
          }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </Show>
      <button
        class={styles.rowBtn}
        type="button"
        aria-label={t('searchPanel.ariaMore')}
        onClick={(e) => {
          e.stopPropagation();
          props.onMenu(e);
        }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
    </div>
  );
}

function SkeletonRows(props: { count: number }) {
  return (
    <div class={styles.skeletons} aria-hidden="true">
      <For each={Array.from({ length: props.count })}>{() => <div class={styles.skeleton} />}</For>
    </div>
  );
}
