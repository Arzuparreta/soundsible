import { prioritizeDiscoveries } from '../lib/catalogCollection';
import { CatalogCollectionStatus } from './CatalogCollectionStatus';
import { openCatalogEntityMenu } from './savedEntityActions';
import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api, type DiscoveryMusicFeed } from '../lib/api';
import { onDiscoveryFeedReady } from '../lib/discoveryEvents';
import { prefetchPreviews } from '../lib/prefetch';
import { catalogPreviewId, itemArtist } from '../lib/catalogItem';
import { userKey } from '../lib/session';
import { readSearchCache, writeSearchCache } from '../lib/searchCache';
import { discoveryHasVisible, resolveDiscoveryTrackShelves } from '../lib/searchDiscovery';
import { catalogDestination } from '../lib/musicNavigation';
import { navigateBackOr } from '../lib/scrollHistory';
import { MusicLink } from './MusicLinks';
import { CatalogResultRow } from './CatalogResultRow';
import { SearchDiscoveryView } from './SearchDiscoveryView';
import { isPlayingItem, state } from '../stores';
import type { CatalogItem } from '../types/music';

const CACHE = 'search-discovery';
const REVALIDATE_FALLBACK_MS = 15_000;
const MAX_REVALIDATE_ATTEMPTS = 4;

export function SearchDiscovery(props: {
  section?: string;
  onReady: (ready: boolean) => void;
  onPlay: (item: CatalogItem) => void;
  onSave: (item: CatalogItem) => void;
  saving: Set<string>;
}) {
  const navigate = useNavigate();
  const cacheKey = userKey('home');
  const cached = readSearchCache<DiscoveryMusicFeed>(CACHE, cacheKey);
  const [feed, setFeed] = createSignal<DiscoveryMusicFeed>(cached ?? {});
  const [loading, setLoading] = createSignal(!cached);
  const [refreshing, setRefreshing] = createSignal(false);
  const [error, setError] = createSignal(false);
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let attempts = 0;
  const sections = createMemo(() => (feed().browse_sections ?? []).map(section => ({ ...section, items: prioritizeDiscoveries(section.items) })));
  const trackShelves = createMemo(() => resolveDiscoveryTrackShelves(feed(), prioritizeDiscoveries));
  const expanded = () => props.section?.trim() || undefined;
  // What the listener is looking at: the opened section alone, or the home.
  const hasVisibleContent = () => discoveryHasVisible(sections(), trackShelves(), expanded());

  async function load(refresh = false) {
    clearTimeout(timer);
    controller?.abort();
    const request = new AbortController();
    controller = request;
    if (refresh) setRefreshing(true);
    try {
      const next = await api.getDiscoveryMusicFeed(request.signal, refresh);
      if (disposed || request.signal.aborted) return;
      // Keep the visible selection stable while browsing a section.
      if (!expanded() || !hasVisibleContent()) setFeed(next);
      writeSearchCache(CACHE, cacheKey, expanded() && hasVisibleContent() ? feed() : next);
      setError(!!next.browse_error || !!next.error);
      if (next.revalidating) {
        setRefreshing(true);
        if (attempts++ < MAX_REVALIDATE_ATTEMPTS) timer = setTimeout(() => void load(), REVALIDATE_FALLBACK_MS);
        else {
          setError(true);
          setRefreshing(false);
        }
      } else {
        setRefreshing(false);
      }
    } catch {
      if (!disposed && !request.signal.aborted) {
        setError(true);
        setRefreshing(false);
      }
    } finally {
      if (!disposed && !request.signal.aborted) setLoading(false);
    }
  }
  const stopPush = onDiscoveryFeedReady(() => {
    if (disposed) return;
    if (feed().revalidating || refreshing() || !expanded() || !hasVisibleContent()) {
      clearTimeout(timer);
      void load(false);
    }
  });
  onMount(() => { if (!cached || cached.revalidating || cached.browse_error) void load(); });
  createEffect(() => props.onReady(!loading() || hasVisibleContent()));

  // Speculative warm-up: prefetch the first visible Discover songs so tapping
  // a recommendation starts near-instantly without a cold search/resolve wait.
  const prefetchedCatalog = new Set<string>();
  createEffect(() => {
    if (state.autoMode.active || loading()) return;
    const currentExpanded = expanded();
    const shelves = trackShelves();
    const visible = currentExpanded
      ? (shelves.find(shelf => shelf.id === currentExpanded)?.items ?? []).slice(0, 6)
      : shelves.slice(0, 2).flatMap(shelf => shelf.items.slice(0, 5));
    const playableIds = visible
      .map(catalogPreviewId)
      .filter((id): id is string => !!id)
      .slice(0, 6);
    const unresolved = visible
      .filter(item => item.type === 'track' && !item.track_id && !catalogPreviewId(item))
      .slice(0, 3);
    untrack(() => {
      if (playableIds.length) prefetchPreviews(playableIds);
      for (const item of unresolved) {
        const artist = itemArtist(item);
        if (!artist || !item.title || prefetchedCatalog.has(item.id)) continue;
        prefetchedCatalog.add(item.id);
        void api
          .resolveCatalogItem({ artist, title: item.title, duration: item.duration })
          .then(res => {
            if (!disposed && res.video_id) prefetchPreviews([res.video_id]);
          })
          .catch(() => {});
      }
    });
  });

  onCleanup(() => { disposed = true; stopPush(); controller?.abort(); clearTimeout(timer); });

  return <SearchDiscoveryView sections={sections()} trackShelves={trackShelves()} expanded={expanded()}
    loading={loading()} error={error()} preparing={!!feed().revalidating}
    refreshing={refreshing() || !!feed().revalidating}
    onBack={() => navigateBackOr(navigate, '/search')}
    onRetry={() => { attempts = 0; setLoading(true); setError(false); void load(true); }}
    onRefresh={() => { attempts = 0; setError(false); void load(true); }}
    renderMore={(section, link) => <MusicLink path={`/search?browse=${encodeURIComponent(section)}`} label={link.label} class={link.class}>{link.children}</MusicLink>}
    renderEntity={(item, link) => <MusicLink path={catalogDestination(item)!} class={link.class} label={link.label} onMenu={event => openCatalogEntityMenu(item, event)}>{link.children}</MusicLink>}
    renderStatus={item => <CatalogCollectionStatus item={item} />}
    renderSong={item => <CatalogResultRow showLibraryStatus item={item} active={isPlayingItem(item)} saving={props.saving.has(item.id)}
      onPlay={() => props.onPlay(item)} onDownload={() => props.onSave(item)} />} />;
}
