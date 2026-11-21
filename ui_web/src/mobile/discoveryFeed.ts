import { createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { api, type DiscoveryMusicFeed } from '../lib/api';
import { onDiscoveryFeedReady } from '../lib/discoveryEvents';
import { discoveryHasVisible, resolveDiscoveryTrackShelves } from '../lib/searchDiscovery';
import { prioritizeCatalogItems } from '../lib/catalogEntity';
import type { CatalogItem } from '../types/music';

const REVALIDATE_FALLBACK_MS = 15_000;
const MAX_REVALIDATE_ATTEMPTS = 4;

/** A feed lives within one engine identity; delayed providers cannot cross accounts. */
export function createNativeDiscoveryFeed(props: {
  generation: () => number; disconnected: () => boolean; expanded: () => string | undefined;
  known: (item: CatalogItem) => boolean;
  paused?: () => boolean;
}, fetchFeed = api.getDiscoveryMusicFeed) {
  const [feed, setFeed] = createSignal<DiscoveryMusicFeed>({});
  const [loading, setLoading] = createSignal(false), [refreshing, setRefreshing] = createSignal(false), [error, setError] = createSignal(false);
  const sections = createMemo(() => (feed().browse_sections ?? []).map(section => ({ ...section, items: prioritizeCatalogItems(section.items, props.known) })));
  const trackShelves = createMemo(() => resolveDiscoveryTrackShelves(feed(), items => prioritizeCatalogItems(items, props.known)));
  const songs = createMemo(() => {
    const out: CatalogItem[] = [];
    const seen = new Set<string>();
    for (const shelf of trackShelves()) {
      for (const item of shelf.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
        if (out.length >= 10) return out;
      }
    }
    return out;
  });
  const hasContent = () => discoveryHasVisible(sections(), trackShelves());
  const hasVisibleContent = () => discoveryHasVisible(sections(), trackShelves(), props.expanded());
  let request: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, epoch = 0, attempts = 0;
  function cancel() { epoch++; request?.abort(); clearTimeout(timer); }
  async function load(refresh = false) {
    cancel();
    if (disposed || props.disconnected() || props.paused?.()) { setLoading(false); setRefreshing(false); return; }
    const operation = epoch, generation = props.generation();
    const controller = new AbortController(); request = controller;
    const current = () => !disposed && operation === epoch && generation === props.generation() && !controller.signal.aborted && !props.disconnected() && !props.paused?.();
    setLoading(true);
    if (refresh) setRefreshing(true);
    try {
      const next = await fetchFeed(controller.signal, refresh);
      if (!current()) return;
      // A background revalidation must not reorder the section being explored.
      if (!props.expanded() || !hasVisibleContent()) setFeed(next);
      setError(!!next.browse_error || !!next.error);
      if (next.revalidating) {
        setRefreshing(true);
        if (attempts++ < MAX_REVALIDATE_ATTEMPTS) timer = setTimeout(() => void load(), REVALIDATE_FALLBACK_MS);
        else { setError(true); setRefreshing(false); }
      } else {
        setRefreshing(false);
      }
    } catch { if (current()) { setError(true); setRefreshing(false); } }
    finally { if (current()) setLoading(false); }
  }
  const stopPush = onDiscoveryFeedReady(() => {
    if (disposed || props.disconnected() || props.paused?.()) return;
    if (feed().revalidating || refreshing() || !props.expanded() || !hasVisibleContent()) {
      clearTimeout(timer);
      void load(false);
    }
  });
  createEffect(on(() => [props.generation(), props.disconnected(), !!props.paused?.()] as const, ([generation, disconnected, paused], previous) => {
    cancel(); attempts = 0;
    const newAccount = !previous || generation !== previous[0];
    if (newAccount) setFeed({});
    setError(false); setLoading(false); setRefreshing(false);
    if (!disconnected && !paused && (newAccount || previous?.[1] || !hasContent() || feed().revalidating || feed().browse_error)) void load();
  }));
  onCleanup(() => { disposed = true; stopPush(); cancel(); });
  const refresh = () => { attempts = 0; setError(false); void load(true); };
  return { feed, sections, trackShelves, songs, loading, refreshing: () => refreshing() || !!feed().revalidating, error, retry: refresh, refresh };
}
