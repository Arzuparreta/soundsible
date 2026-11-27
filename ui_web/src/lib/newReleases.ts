import { createSignal, onCleanup } from 'solid-js';
import type { DiscoveryBrowseItem } from './api';
import { albumPath } from './artistRoute';
import { onDiscoveryFeedReady } from './discoveryEvents';
import { newReleasesApi } from './newReleasesApi';

export function releaseDestination(item: DiscoveryBrowseItem): string {
  const deezerId = item.external_ids?.deezer_album_id
    ? String(item.external_ids.deezer_album_id)
    : undefined;
  return albumPath(item.title, item.artist ?? item.subtitle ?? '', { view: 'discover', deezerId });
}

export function createNewReleases(
  context: () => string | number,
  disconnected: () => boolean = () => false,
) {
  const [items, setItems] = createSignal<DiscoveryBrowseItem[]>([]);
  let controller: AbortController | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackUsed = false;
  let awaitingRevalidate = false;
  let disposed = false;
  let stopPush: (() => void) | undefined;

  function clearFallback() {
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  }

  async function load(fromFallback = false) {
    if (disposed || disconnected() || typeof newReleasesApi.getDiscoveryNewReleases !== 'function') return;
    clearFallback();
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const startedFor = context();
    try {
      const response = await newReleasesApi.getDiscoveryNewReleases(request.signal, 12);
      if (disposed || request.signal.aborted || startedFor !== context() || disconnected()) return;
      setItems(Array.isArray(response?.items) ? response.items : []);
      awaitingRevalidate = Boolean(response?.revalidating);
      if (awaitingRevalidate && !fallbackUsed && !fromFallback) {
        fallbackTimer = setTimeout(() => {
          if (disposed || disconnected()) return;
          fallbackUsed = true;
          void load(true);
        }, 5000);
      }
    } catch {
      // Home stays silent when the feed is offline or unavailable.
      awaitingRevalidate = false;
    }
  }

  function reset() {
    setItems([]);
    fallbackUsed = false;
    awaitingRevalidate = false;
    clearFallback();
  }

  function subscribe() {
    stopPush = onDiscoveryFeedReady((data) => {
      if (disposed || disconnected()) return;
      if (data.reason !== 'new_releases' && !(data.reason === undefined && awaitingRevalidate)) return;
      awaitingRevalidate = false;
      void load();
    });
  }

  onCleanup(() => {
    disposed = true;
    clearFallback();
    stopPush?.();
    controller?.abort();
  });

  return { items, load, reset, subscribe };
}
