import { createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { api, type DiscoveryMusicFeed } from '../lib/api';
import { discoveryCatalogItem } from '../lib/searchDiscovery';
import { prioritizeCatalogItems } from '../lib/catalogEntity';
import type { CatalogItem } from '../types/music';

/** A feed lives within one engine identity; delayed providers cannot cross accounts. */
export function createNativeDiscoveryFeed(props: {
  generation: () => number; disconnected: () => boolean; expanded: () => string | undefined;
  known: (item: CatalogItem) => boolean;
  paused?: () => boolean;
}, fetchFeed = api.getDiscoveryMusicFeed) {
  const [feed, setFeed] = createSignal<DiscoveryMusicFeed>({});
  const [loading, setLoading] = createSignal(false), [error, setError] = createSignal(false);
  const sections = createMemo(() => (feed().browse_sections ?? []).map(section => ({ ...section, items: prioritizeCatalogItems(section.items, props.known) })));
  const songs = createMemo(() => prioritizeCatalogItems((feed().items ?? []).map(discoveryCatalogItem), props.known).slice(0, 10));
  const hasContent = () => sections().some(section => section.items.length) || songs().length > 0;
  let request: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, epoch = 0, attempts = 0;
  function cancel() { epoch++; request?.abort(); clearTimeout(timer); }
  async function load(refresh = false) {
    cancel();
    if (disposed || props.disconnected() || props.paused?.()) { setLoading(false); return; }
    const operation = epoch, generation = props.generation();
    const controller = new AbortController(); request = controller;
    const current = () => !disposed && operation === epoch && generation === props.generation() && !controller.signal.aborted && !props.disconnected() && !props.paused?.();
    setLoading(true);
    try {
      const next = await fetchFeed(controller.signal, refresh);
      if (!current()) return;
      // A background revalidation must not reorder the section being explored.
      if (!props.expanded() || !hasContent()) setFeed(next);
      setError(!!next.browse_error || !!next.error);
      if (next.revalidating) {
        if (attempts++ < 12) timer = setTimeout(() => void load(), 5000);
        else setError(true);
      }
    } catch { if (current()) setError(true); }
    finally { if (current()) setLoading(false); }
  }
  createEffect(on(() => [props.generation(), props.disconnected(), !!props.paused?.()] as const, ([generation, disconnected, paused], previous) => {
    cancel(); attempts = 0;
    const newAccount = !previous || generation !== previous[0];
    if (newAccount) setFeed({});
    setError(false); setLoading(false);
    if (!disconnected && !paused && (newAccount || previous?.[1] || !hasContent() || feed().revalidating || feed().browse_error)) void load();
  }));
  onCleanup(() => { disposed = true; cancel(); });
  return { feed, sections, songs, loading, error, retry: () => { attempts = 0; setError(false); void load(true); } };
}
