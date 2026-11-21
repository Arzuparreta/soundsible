import { prioritizeDiscoveries } from '../lib/catalogCollection';
import { CatalogCollectionStatus } from './CatalogCollectionStatus';
import { openCatalogEntityMenu } from './savedEntityActions';
import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api, type DiscoveryMusicFeed } from '../lib/api';
import {
  discoveryBrowseSections,
  discoveryDismissed,
  discoveryError,
  discoveryFeed,
  discoveryLoading,
  discoveryRefreshing,
  discoveryTrackShelves,
  dismissDiscoveryItem,
  filterDiscoveryTrackShelves,
  refreshDiscoveryFeed,
  restoreDiscoveryItem,
  retainDiscoveryFeed,
} from '../lib/discoveryFeedStore';
import { prefetchPreviews } from '../lib/prefetch';
import { catalogPreviewId, itemArtist } from '../lib/catalogItem';
import { discoveryHasVisible, resolveDiscoveryTrackShelves } from '../lib/searchDiscovery';
import { catalogDestination } from '../lib/musicNavigation';
import { navigateBackOr } from '../lib/scrollHistory';
import { MusicLink } from './MusicLinks';
import { CatalogResultRow } from './CatalogResultRow';
import { SearchDiscoveryView } from './SearchDiscoveryView';
import { isPlayingItem, state } from '../stores';
import type { CatalogItem } from '../types/music';

export function SearchDiscovery(props: {
  section?: string;
  onReady: (ready: boolean) => void;
  onRefreshControl?: (control: { canRefresh: boolean; refreshing: boolean; refresh: () => void } | null) => void;
  onPlay: (item: CatalogItem) => void;
  onSave: (item: CatalogItem) => void;
  saving: Set<string>;
}) {
  const navigate = useNavigate();
  let disposed = false;
  const expanded = () => props.section?.trim() || undefined;
  const [snapshot, setSnapshot] = createSignal<DiscoveryMusicFeed | null>(null);

  // Keep the opened section's visible list stable across background pushes.
  createEffect(() => {
    const exp = expanded();
    if (!exp) {
      setSnapshot(null);
      return;
    }
    const current = discoveryFeed();
    if (!untrack(snapshot)) {
      const snapSections = (current.browse_sections ?? []).map(section => ({
        ...section,
        items: prioritizeDiscoveries(section.items),
      }));
      const snapShelves = filterDiscoveryTrackShelves(
        resolveDiscoveryTrackShelves(current, prioritizeDiscoveries),
        untrack(discoveryDismissed),
      );
      if (discoveryHasVisible(snapSections, snapShelves, exp)) {
        setSnapshot(current);
      }
    }
  });

  const sections = createMemo(() => {
    const frozen = snapshot();
    if (frozen && expanded()) {
      return (frozen.browse_sections ?? []).map(section => ({
        ...section,
        items: prioritizeDiscoveries(section.items),
      }));
    }
    return discoveryBrowseSections();
  });
  const trackShelves = createMemo(() => {
    const frozen = snapshot();
    if (frozen && expanded()) {
      return filterDiscoveryTrackShelves(
        resolveDiscoveryTrackShelves(frozen, prioritizeDiscoveries),
        discoveryDismissed(),
      );
    }
    return discoveryTrackShelves();
  });
  // What the listener is looking at: the opened section alone, or the home.
  const hasVisibleContent = () => discoveryHasVisible(sections(), trackShelves(), expanded());

  onMount(() => {
    const release = retainDiscoveryFeed();
    onCleanup(release);
  });
  createEffect(() => props.onReady(!discoveryLoading() || hasVisibleContent()));

  // Speculative warm-up: prefetch the first visible Discover songs so tapping
  // a recommendation starts near-instantly without a cold search/resolve wait.
  const prefetchedCatalog = new Set<string>();
  createEffect(() => {
    if (state.autoMode.active || discoveryLoading()) return;
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

  const refresh = () => {
    setSnapshot(null);
    refreshDiscoveryFeed();
  };
  createEffect(() => {
    props.onRefreshControl?.({
      canRefresh: !expanded() && hasVisibleContent(),
      refreshing: discoveryRefreshing() || !!discoveryFeed().revalidating || discoveryLoading(),
      refresh,
    });
  });

  onCleanup(() => { disposed = true; props.onRefreshControl?.(null); });

  return <SearchDiscoveryView sections={sections()} trackShelves={trackShelves()} expanded={expanded()}
    loading={discoveryLoading()} error={discoveryError()} preparing={!!discoveryFeed().revalidating}
    onBack={() => navigateBackOr(navigate, '/search')}
    onRetry={() => { setSnapshot(null); refreshDiscoveryFeed({ resetLoading: true }); }}
    renderMore={(section, link) => <MusicLink path={`/search?browse=${encodeURIComponent(section)}`} label={link.label} class={link.class}>{link.children}</MusicLink>}
    renderEntity={(item, link) => <MusicLink path={catalogDestination(item)!} class={link.class} label={link.label} onMenu={event => openCatalogEntityMenu(item, event)}>{link.children}</MusicLink>}
    renderStatus={item => <CatalogCollectionStatus item={item} />}
    renderSong={item => <CatalogResultRow showLibraryStatus item={item} active={isPlayingItem(item)} saving={props.saving.has(item.id)}
      onPlay={() => props.onPlay(item)} onDownload={() => props.onSave(item)}
      onNotInterested={() => dismissDiscoveryItem(item.id)}
      onUndoNotInterested={() => restoreDiscoveryItem(item.id)} />} />;
}
