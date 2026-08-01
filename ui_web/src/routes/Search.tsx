import { createEffect, createMemo, createSignal, For, Match, Show, Switch, onCleanup, onMount, untrack, type JSX } from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { api } from '../lib/api';
import {
  actions,
  state,
  isDownloadingKeys,
  isPlayingItem,
  isPlayingResult,
  isSavedKeys,
  ownedTrackForKeys,
} from '../stores';
import { coverUrl } from '../lib/media';
import { artistPath, albumPath } from '../lib/artistRoute';
import { toast } from '../lib/toast';
import { parseYouTubeInput } from '../lib/youtube';
import { prefetchPreviews } from '../lib/prefetch';
import { ensureNodeFeed, nodeFeed, nodeLoading, refreshNodeFeed, type NodeRec } from '../lib/nodeDiscover';
import { t as tr } from '../lib/i18n';
import { userKey } from '../lib/session';
import {
  catalogPreviewId,
  itemArtist,
  playCatalogItem,
  cancelCatalogResolve,
} from '../lib/catalogItem';
import SearchResultRow from '../components/SearchResultRow';
import { savedFromTrack } from '../lib/saved';
import { Spinner } from '../components/Spinner';
import type { CatalogItem, CatalogSaveResponse, CatalogSection, SavedEntry, SearchResult, Track } from '../types/music';
import styles from './Search.module.css';
import { coverStyle } from '../lib/cover';
import { attachContextMenu } from '../lib/contextMenu';
import { trackMenuOptions } from '../components/trackActions';
import type { ActionMenuOptions } from '../components/ActionMenu';
import { SkeletonCards, SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { sharedCapsuleFromHash, type TrackShareCapsuleV1 } from '../lib/trackShare';
import { createResponsiveTap } from '../lib/responsiveTap';
import { SearchField } from '../components/SearchField';
import { CatalogResultRow } from '../components/CatalogResultRow';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { readSearchCache, writeSearchCache } from '../lib/searchCache';
import {
  bodySections,
  itemsForTypes,
  resolveSections,
  topResultItem,
  CATALOG_CACHE_NS,
  type CachedCatalog,
  type ResolvedSection,
} from '../lib/searchSections';
import { TopResultCard } from '../components/TopResultCard';

type SearchDomain = 'music' | 'youtube';
type SearchTab = 'all' | 'track,library_track' | 'artist' | 'album';

const tabs: Array<{ id: SearchTab; label: () => string }> = [
  { id: 'all', label: () => tr('search.tabAll') },
  { id: 'track,library_track', label: () => tr('search.tabSongs') },
  { id: 'artist', label: () => tr('search.tabArtists') },
  { id: 'album', label: () => tr('search.tabAlbums') },
];

const TAB_SECTION_ID: Record<SearchTab, string> = {
  all: 'songs',
  'track,library_track': 'songs',
  artist: 'artists',
  album: 'albums',
};

/** Section headings, by the server's stable ids — never its English strings. */
const SECTION_TITLE: Record<string, () => string> = {
  top: () => tr('search.topResultSection'),
  songs: () => tr('search.tabSongs'),
  artists: () => tr('search.tabArtists'),
  albums: () => tr('search.tabAlbums'),
  playlists: () => tr('search.labelPlaylist'),
};

/**
 * How many songs the All tab shows before handing off to the Songs tab.
 *
 * It used to show every one of them, which is what buried the artist and album
 * rails under a wall of tracks.
 */
const SONGS_PREVIEW = 5;

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
  const [searchParams, setSearchParams] = useSearchParams();
  const initialDomain: SearchDomain = searchParams.domain === 'youtube' ? 'youtube' : 'music';
  const initialTab: SearchTab = tabs.some((candidate) => candidate.id === searchParams.tab)
    ? searchParams.tab as SearchTab
    : 'all';
  const initialQuery = typeof searchParams.q === 'string' ? searchParams.q : '';
  const [domain, setDomain] = createSignal<SearchDomain>(initialDomain);
  const [q, setQ] = createSignal(initialQuery);
  const [tab, setTab] = createSignal<SearchTab>(initialTab);
  const [items, setItems] = createSignal<CatalogItem[]>([]);
  const [sections, setSections] = createSignal<CatalogSection[]>([]);
  const [interpretedAs, setInterpretedAs] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [youtubeResults, setYoutubeResults] = createSignal<SearchResult[]>([]);
  const [youtubeDirect, setYoutubeDirect] = createSignal<SearchResult | null>(null);
  const [youtubeLoading, setYoutubeLoading] = createSignal(false);
  const [youtubeError, setYoutubeError] = createSignal(false);
  const [suggestions, setSuggestions] = createSignal<string[]>([]);
  const [showSuggest, setShowSuggest] = createSignal(false);
  const [lastRun, setLastRun] = createSignal('');
  const [recents, setRecents] = createSignal<string[]>(loadRecents(initialDomain));
  const [saving, setSaving] = createSignal<Set<string>>(new Set());
  const [review, setReview] = createSignal<{ item: CatalogItem; response: CatalogSaveResponse } | null>(null);
  const [sharedCapsule, setSharedCapsule] = createSignal<TrackShareCapsuleV1 | null>(null);
  const [sharedItem, setSharedItem] = createSignal<CatalogItem | null>(null);
  const [sharedLoading, setSharedLoading] = createSignal(false);
  const [sharedError, setSharedError] = createSignal(false);
  const [sharedInvalid, setSharedInvalid] = createSignal(false);

  let aborter: AbortController | undefined;
  let suggestAborter: AbortController | undefined;
  let debounce: number | undefined;
  let suggestDebounce: number | undefined;
  let requestId = 0;
  let searchInput: HTMLInputElement | undefined;

  // One response, laid out by the server. The tabs slice it rather than each
  // asking for their own — a `type=artist` request re-ran the whole provider
  // fan-out just to filter what `type=all` already had.
  const resolved = createMemo(() => resolveSections(items(), sections()));
  const topResult = createMemo(() => topResultItem(resolved()));
  const songs = createMemo(() => itemsForTypes(items(), ['track', 'library_track']));
  const songsSection = createMemo(() => resolved().find((section) => section.id === 'songs'));
  const songsPreview = createMemo(() => (songsSection()?.items ?? []).slice(0, SONGS_PREVIEW));
  const songsTotal = createMemo(() => songsSection()?.total ?? songs().length);

  /** The sections rendered below the hero + songs block, for the active tab. */
  const visibleSections = createMemo<ResolvedSection[]>(() => {
    const active = tab();
    if (active === 'all') {
      // Songs already appear in the pinned block above.
      return bodySections(resolved()).filter((section) => section.id !== 'songs');
    }
    const members = itemsForTypes(items(), active.split(','));
    if (!members.length) return [];
    const layout: ResolvedSection['layout'] =
      active === 'artist' ? 'grid_round' : active === 'album' ? 'grid' : 'rows';
    return [{ id: TAB_SECTION_ID[active], layout, items: members, total: members.length }];
  });

  const sectionTitle = (id: string) => SECTION_TITLE[id]?.() ?? id;
  const openSharedTrack = (capsule: TrackShareCapsuleV1) => {
    const current = ++requestId;
    aborter?.abort();
    aborter = new AbortController();
    setSharedCapsule(capsule);
    setQ(`${capsule.title} — ${capsule.artist}`);
    setDomain('music');
    setItems([]);
    setSections([]);
    setSharedItem(null);
    setSharedError(false);
    setSharedInvalid(false);
    setSharedLoading(true);
    setShowSuggest(false);
    const local = state.library.find((track) => track.youtube_id === capsule.yt);
    if (local) {
      setSharedItem({
        id: `library:${local.id}`,
        type: 'library_track',
        source: 'library',
        title: local.title || capsule.title,
        artist: local.artist || capsule.artist,
        subtitle: local.artist || capsule.artist,
        album: local.album || capsule.album,
        duration: local.duration ?? capsule.duration,
        cover: local.cover,
        track_id: local.id,
        external_ids: { youtube_id: capsule.yt },
        action_state: { in_library: true, playable: true },
      });
      setSharedLoading(false);
      return;
    }
    api
      .peekYouTube(`https://www.youtube.com/watch?v=${capsule.yt}`, aborter.signal)
      .then((result) => {
        if (current !== requestId) return;
        if (!result || result.id !== capsule.yt) throw new Error('shared-track-unavailable');
        const title = result.title || capsule.title;
        const artist = result.channel || capsule.artist;
        setSharedItem({
          id: `youtube:${capsule.yt}`,
          type: 'track',
          source: 'youtube',
          title,
          artist,
          subtitle: artist,
          album: capsule.album,
          duration: result.duration ?? capsule.duration,
          cover: result.thumbnail,
          external_ids: { youtube_id: capsule.yt },
          raw: {
            id: capsule.yt,
            title,
            artist,
            album: capsule.album,
            duration: result.duration ?? capsule.duration,
            youtube_id: capsule.yt,
            source: 'preview',
          },
          action_state: { playable: true, downloadable: true },
        });
      })
      .catch((error) => {
        if (current !== requestId || isAbort(error)) return;
        setSharedError(true);
      })
      .finally(() => {
        if (current === requestId) setSharedLoading(false);
      });
  };

  onMount(() => {
    ensureNodeFeed();
    const shared = sharedCapsuleFromHash(window.location.hash);
    if (shared) openSharedTrack(shared.capsule);
    else if (/[?&]shared=/.test(window.location.hash)) {
      setQ(tr('search.sharedLink'));
      setSharedInvalid(true);
    }
    else if (initialQuery.trim().length >= 2) {
      runSearch(parseSearchInput(initialQuery).query, initialDomain, initialTab);
    }
    // Mobile navigation should land on Search without summoning the keyboard.
    // Fine pointers retain the fast desktop workflow.
    if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
      requestAnimationFrame(() => searchInput?.focus());
    }
  });

  const runCatalog = (query: string) => {
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
      setSections([]);
      setLoading(false);
      return;
    }
    // Catalog results had no cache at all, so returning to Search re-ran the
    // query the user had just made. One namespace, not one per tab, so the
    // Now Playing panel shares the entry too.
    const cachedCatalog = readSearchCache<CachedCatalog>(CATALOG_CACHE_NS, query);
    if (cachedCatalog) {
      setItems(cachedCatalog.items);
      setSections(cachedCatalog.sections);
      setInterpretedAs(cachedCatalog.interpretedAs);
      setLoading(false);
      return;
    }
    aborter = new AbortController();
    setLoading(true);
    api
      .searchCatalog(query, aborter.signal)
      .then((res) => {
        if (current !== requestId) return;
        const items = res.items ?? [];
        const sections = res.sections ?? [];
        const interpretedAs = res.interpreted_as ?? '';
        writeSearchCache(CATALOG_CACHE_NS, query, { items, sections, interpretedAs });
        setItems(items);
        setSections(sections);
        setInterpretedAs(interpretedAs);
      })
      .catch((e) => {
        if (current !== requestId || isAbort(e)) return;
        setItems([]);
        setSections([]);
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
    setSections([]);
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
    const cached = readSearchCache<SearchResult[]>('youtube', query);
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
        writeSearchCache('youtube', query, res);
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
    setLastRun(query.trim());
    setSearchParams(
      {
        q: q().trim() || query.trim() || undefined,
        domain: nextDomain === 'youtube' ? 'youtube' : undefined,
        tab: nextDomain === 'music' && nextTab !== 'all' ? nextTab : undefined,
      },
      { replace: true },
    );
    if (nextDomain === 'youtube') runYouTube(query);
    else runCatalog(query);
  };

  // True while the YouTube box holds a query nobody has confirmed yet. The
  // results below are the previous search, so "no results" would be a lie.
  const ytPending = createMemo(() => {
    if (domain() !== 'youtube') return false;
    return parseSearchInput(q()).query.trim() !== lastRun();
  });

  // ── Speculative warm-up: resolve the top of the results in the background
  // while the user is still deciding, so the eventual play click starts
  // near-instantly. YouTube rows already carry playable ids; top catalog
  // (Deezer) songs are resolved to a video id first (server-cached forever).
  const prefetchedCatalog = new Set<string>();
  createEffect(() => {
    const directResult = youtubeDirect();
    const playableIds = [
      ...(directResult ? [directResult.id] : []),
      ...youtubeResults().map((r) => r.id),
      ...songs().map(catalogPreviewId).filter((id): id is string => !!id),
    ].slice(0, 8);
    const unresolvedSongs = songs()
      .filter((item) => item.type === 'track' && !item.track_id && !catalogPreviewId(item))
      .slice(0, 2);
    untrack(() => {
      prefetchPreviews(playableIds);
      for (const item of unresolvedSongs) {
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
    api.suggest(query, suggestAborter.signal).then((s) => setSuggestions(s)).catch(() => {});
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
    if (sharedCapsule() || sharedInvalid()) {
      setSharedCapsule(null);
      setSharedItem(null);
      setSharedError(false);
      setSharedInvalid(false);
      setSharedLoading(false);
      setSearchParams({ shared: undefined }, { replace: true });
    }
    const { query: parsed, forceYt } = parseSearchInput(value);
    const nextDomain = forceYt || parseYouTubeInput(parsed) ? 'youtube' : domain();
    if (nextDomain !== domain()) {
      setDomain(nextDomain);
      setRecents(loadRecents(nextDomain));
    }
    setQ(value);
    clearTimeout(debounce);
    clearTimeout(suggestDebounce);
    // One model per domain, never both at once — a suggestion dropdown floating
    // over live results is offering to ask a question that is already answered.
    if (nextDomain === 'youtube' && !parseYouTubeInput(parsed)) {
      // Unbounded external corpus: guess the query, search only on commit.
      setShowSuggest(true);
      suggestDebounce = window.setTimeout(() => runSuggest(parsed), 120);
    } else {
      // Finite local catalog (and pasted URLs, which are unambiguous): the live
      // results are the prediction.
      setShowSuggest(false);
      setSuggestions([]);
      debounce = window.setTimeout(() => runSearch(parsed, nextDomain), 220);
    }
  };

  // Filtering, not fetching. Every tab is a view of the one `type=all` response
  // the server already ranked, so switching is instant and the orders agree.
  const setActiveTab = (next: SearchTab) => {
    if (next === tab()) return;
    setTab(next);
    setSearchParams(
      { q: q().trim() || undefined, domain: undefined, tab: next === 'all' ? undefined : next },
      { replace: true },
    );
  };

  const setActiveDomain = (next: SearchDomain) => {
    setDomain(next);
    setRecents(loadRecents(next));
    setShowSuggest(false);
    setSuggestions([]);
    runSearch(parseSearchInput(q()).query, next);
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
        // The row and the download now share a video id. Recording it is what
        // lets this row flip to ✓ — and light up if it is what's playing — the
        // moment the download lands, instead of waiting for a fresh search.
        if (response.video_id) actions.linkCatalogItem(item.id, response.video_id);
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
          <SearchField
            placeholder={tr('search.placeholder')}
            clearLabel={tr('searchPanel.clear')}
            value={q()}
            global
            inputRef={(element) => {
              searchInput = element;
            }}
            onInput={onInput}
            onFocus={() => setShowSuggest(domain() === 'youtube')}
            onBlur={() => setShowSuggest(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value);
              if (e.key === 'Escape') setShowSuggest(false);
            }}
          />
        </div>
        <Show when={domain() === 'youtube' && showSuggest() && q().trim().length >= 2 && suggestions().length > 0}>
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

      <Show when={!sharedCapsule() && !sharedInvalid() && domain() === 'music' && q().trim().length >= 2}>
        <div class={styles.tabs} role="tablist" aria-label={tr('search.resultsSection')}>
          <For each={tabs}>
            {(t) => (
              <button
                classList={{ [styles.tab]: true, [styles.activeTab]: tab() === t.id }}
                type="button"
                role="tab"
                aria-selected={tab() === t.id}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label()}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div
        ref={(element) => registerPrimaryScroll(
          element,
          () => !loading() && !youtubeLoading() && !sharedLoading() && !nodeLoading(),
        )}
        class={styles.scroll}
        data-primary-scroll
      >
        <Show when={loading() && items().length > 0 && domain() === 'music'}>
          <div class={styles.loadingBar} role="status" aria-live="polite" aria-label={tr('common.loading')}>
            <span>{tr('common.loading')}</span>
          </div>
        </Show>
        <Switch>
          <Match when={sharedInvalid()}>
            <EmptyState compact tone="danger">{tr('search.sharedInvalid')}</EmptyState>
          </Match>
          <Match when={sharedCapsule()}>
            <div class={styles.results}>
              <Show when={sharedLoading()}>
                <SkeletonRows count={1} compact />
              </Show>
              <Show when={!sharedLoading() && sharedError()}>
                <EmptyState compact tone="danger">
                  {tr('search.sharedUnavailable')}{' '}
                  <button
                    class={styles.retry}
                    type="button"
                    onClick={() => {
                      const capsule = sharedCapsule();
                      if (capsule) openSharedTrack(capsule);
                    }}
                  >
                    {tr('common.retry')}
                  </button>
                </EmptyState>
              </Show>
              <Show when={sharedItem()}>
                {(item) => (
                  <section class={styles.section}>
                    <h2 class={styles.sectionTitle}>{tr('search.sharedSection')}</h2>
                    <CatalogResultRow
                      item={item()}
                      active={isPlayingItem(item())}
                      saving={saving().has(item().id)}
                      onPlay={() => playItem(item())}
                      onDownload={() => void saveItem(item())}
                    />
                  </section>
                )}
              </Show>
            </div>
          </Match>
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
              entry={(rec) => savedFromTrack(nodeTrack(rec))}
              menu={(rec) => trackMenuOptions(nodeTrack(rec), { navigate })}
            />
          </Match>
          <Match when={domain() === 'youtube'}>
            <div class={styles.results}>
              <Show when={youtubeLoading() && youtubeResults().length === 0 && !youtubeDirect()}>
                <SkeletonRows count={8} compact />
              </Show>

              <Show when={ytPending() && !youtubeLoading() && !youtubeDirect() && youtubeResults().length === 0 && q().trim().length >= 2}>
                <EmptyState compact>{tr('search.ytPressEnter')}</EmptyState>
              </Show>

              <Show when={!ytPending() && !youtubeLoading() && !youtubeDirect() && youtubeResults().length === 0 && q().trim().length >= 2}>
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
                      active={isPlayingResult(result())}
                      onPreview={() => previewYouTube(result())}
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
                        active={isPlayingResult(result)}
                        onPreview={() => previewYouTube(result)}
                      />
                    )}
                  </For>
                </section>
              </Show>
            </div>
          </Match>
          <Match when={loading() && items().length === 0}>
            <SearchLoading tab={tab()} />
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
            <div
              classList={{ [styles.results]: true, [styles.resultsRefreshing]: loading() }}
              aria-busy={loading()}
              aria-disabled={loading()}
              inert={loading() ? true : undefined}
            >
              <Show when={interpretedAs()}>
                {(name) => (
                  <p class={styles.interpretation}>
                    {tr('search.interpretedAs', { name: name() })}
                  </p>
                )}
              </Show>
              {/* The hero and the songs preview sit side by side on a wide
                  screen and stack on a narrow one — the one part of the layout
                  that is fixed, because a search always wants to answer
                  "which one?" and "what can I play right now?" together. */}
              <Show when={tab() === 'all' && (topResult() || songsPreview().length > 0)}>
                <div class={styles.topBlock}>
                  <Show when={topResult()}>
                    {(item) => (
                      <section class={styles.section}>
                        <h2 class={styles.sectionTitle}>{tr('search.topResultSection')}</h2>
                        <TopResultCard
                          item={item()}
                          active={isPlayingItem(item())}
                          coverStyle={itemCoverStyle}
                          onPick={() => playItem(item())}
                        />
                      </section>
                    )}
                  </Show>
                  <Show when={songsPreview().length > 0}>
                    <section class={styles.section}>
                      <h2 class={styles.sectionTitle}>{tr('search.tabSongs')}</h2>
                      <For each={songsPreview()}>
                        {(item) => (
                          <CatalogResultRow
                            item={item}
                            active={isPlayingItem(item)}
                            saving={saving().has(item.id)}
                            showSource
                            onPlay={() => playItem(item)}
                            onDownload={() => void saveItem(item)}
                          />
                        )}
                      </For>
                      <Show when={songsTotal() > songsPreview().length}>
                        <button
                          class={styles.seeAll}
                          type="button"
                          onClick={() => setActiveTab('track,library_track')}
                        >
                          {tr('search.seeAllSongs', { count: String(songsTotal()) })}
                        </button>
                      </Show>
                    </section>
                  </Show>
                </div>
              </Show>
              {/* Everything else in the order the server decided. An album
                  search leads with albums; an artist search leads with the
                  artist. It used to be songs, then artists, then albums, every
                  single time. */}
              <For each={visibleSections()}>
                {(section) => (
                  <Switch>
                    <Match when={section.layout === 'rows'}>
                      <section class={styles.section}>
                        <h2 class={styles.sectionTitle}>{sectionTitle(section.id)}</h2>
                        <For each={section.items}>
                          {(item) => (
                            <CatalogResultRow
                              item={item}
                              active={isPlayingItem(item)}
                              saving={saving().has(item.id)}
                              showSource
                              onPlay={() => playItem(item)}
                              onDownload={() => void saveItem(item)}
                            />
                          )}
                        </For>
                      </section>
                    </Match>
                    <Match when={true}>
                      <EntitySection
                        title={sectionTitle(section.id)}
                        items={section.items}
                        round={section.layout === 'grid_round'}
                        coverStyle={itemCoverStyle}
                        onPick={playItem}
                      />
                    </Match>
                  </Switch>
                )}
              </For>
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
  entry: (rec: NodeRec) => SavedEntry;
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
                  entry={props.entry(rec)}
                  onPlay={() => props.onPlay(rec)}
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
              {(value) => {
                const tap = createResponsiveTap({ onTap: () => props.onPick(value) });
                return (
                  <button class={styles.recent} type="button" data-pressable {...tap}>
                    <SearchIcon />
                    <span>{value}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
}

function SeedSearch(props: { onFocusSearch: () => void }) {
  return (
    <>
      <div class={styles.seedState}>
        <h2>{tr('search.seedHeading')}</h2>
        <p>{tr('search.seedDesc')}</p>
        <button class={styles.seedAction} type="button" onClick={props.onFocusSearch}>
          {tr('search.seedAction')}
        </button>
      </div>
      <button class={styles.seedHint} type="button" onClick={props.onFocusSearch}>
        {tr('search.seedHeading')}
      </button>
    </>
  );
}

function DiscoveryCard(props: {
  title: string;
  sub: string;
  cover?: string;
  seedKey: string;
  /** What the card's corner control acts on. */
  entry: SavedEntry;
  onPlay: () => void;
  menu?: () => ActionMenuOptions | null;
}) {
  const bg = (): JSX.CSSProperties => coverStyle(props.seedKey, props.cover);
  const tap = createResponsiveTap({ onTap: props.onPlay });
  // Same four states as every row, in the card's own corner slot: claim it,
  // then give it a file. The heart lives in this card's context menu, which
  // offers it from the moment the song is yours.
  const owned = () => !!ownedTrackForKeys(props.entry.keys);
  const downloading = () => isDownloadingKeys(props.entry.keys);
  const saved = () => isSavedKeys(props.entry.keys);
  return (
    <div
      class={styles.discoverCard}
      ref={(el) => attachContextMenu(el, () => props.menu?.() ?? null)}
    >
      <button class={styles.discoverCardBtn} type="button" data-pressable {...tap}>
        <span class={styles.discoverCardCover} style={bg()} />
        <span class={styles.discoverCardTitle}>{props.title}</span>
        <span class={styles.discoverCardSub}>{props.sub}</span>
      </button>
      <Switch>
        <Match when={owned()}>
          <span class={styles.discoverSavedBadge} aria-label={tr('collection.owned')}>
            <CheckIcon />
          </span>
        </Match>
        <Match when={downloading()}>
          <span class={styles.discoverSavedBadge} aria-label={tr('collection.downloading')}>
            <Spinner size={16} onAccent />
          </span>
        </Match>
        <Match when={saved()}>
          <button
            class={styles.discoverSaveBtn}
            type="button"
            aria-label={tr('collection.download')}
            onClick={(e) => {
              e.stopPropagation();
              void actions.downloadSaved(props.entry, 'discover');
            }}
          >
            <DownloadIcon />
          </button>
        </Match>
        <Match when={true}>
          <button
            class={styles.discoverSaveBtn}
            type="button"
            aria-label={tr('collection.save')}
            onClick={(e) => {
              e.stopPropagation();
              actions.toggleSaved(props.entry);
            }}
          >
            <PlusIcon />
          </button>
        </Match>
      </Switch>
    </div>
  );
}

function RailSkeletons() {
  return <SkeletonCards count={12} />;
}

function SearchLoading(props: { tab: SearchTab }) {
  return (
    <Switch>
      <Match when={props.tab === 'artist'}>
        <SkeletonCards count={8} shape="round" />
      </Match>
      <Match when={props.tab === 'album'}>
        <SkeletonCards count={8} />
      </Match>
      <Match when={props.tab === 'track,library_track'}>
        <SkeletonRows count={8} compact />
      </Match>
      <Match when={true}>
        <div class={styles.mixedSkeleton}>
          <SkeletonRows count={4} compact />
          <SkeletonCards count={4} shape="round" />
          <SkeletonCards count={4} />
        </div>
      </Match>
    </Switch>
  );
}

function EntitySection(props: {
  title: string;
  items: CatalogItem[];
  round?: boolean;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  onPick: (item: CatalogItem) => void;
}) {
  return (
    <section class={styles.section}>
      <h2 class={styles.sectionTitle}>{props.title}</h2>
      <div class={styles.entityGrid}>
        <For each={props.items}>
          {(item) => (
            <EntityCard
              item={item}
              round={props.round}
              coverStyle={props.coverStyle}
              onPick={() => props.onPick(item)}
            />
          )}
        </For>
      </div>
    </section>
  );
}

function EntityCard(props: {
  item: CatalogItem;
  round?: boolean;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  onPick: () => void;
}) {
  const tap = createResponsiveTap({ onTap: props.onPick });
  return (
    <button class={styles.entityCard} type="button" data-pressable {...tap}>
      <span
        classList={{ [styles.entityCover]: true, [styles.entityCoverRound]: props.round }}
        style={props.coverStyle(props.item, props.round)}
      />
      <span class={styles.entityTitle}>{props.item.title}</span>
      <span class={styles.entitySub}>{props.item.subtitle || itemArtist(props.item)}</span>
    </button>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
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
