import { prioritizeDiscoveries } from '../lib/catalogCollection';
import { CatalogCollectionStatus } from './CatalogCollectionStatus';
import { openCatalogEntityMenu } from './savedEntityActions';
import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api, type DiscoveryMusicFeed } from '../lib/api';
import { userKey } from '../lib/session';
import { readSearchCache, writeSearchCache } from '../lib/searchCache';
import { discoveryCatalogItem } from '../lib/searchDiscovery';
import { catalogDestination } from '../lib/musicNavigation';
import { navigateBackOr } from '../lib/scrollHistory';
import { MusicLink } from './MusicLinks';
import { CatalogResultRow } from './CatalogResultRow';
import { SearchDiscoveryView } from './SearchDiscoveryView';
import { isPlayingItem } from '../stores';
import type { CatalogItem } from '../types/music';

const CACHE = 'search-discovery';

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
  const [error, setError] = createSignal(false);
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let attempts = 0;
  const sections = createMemo(() => (feed().browse_sections ?? []).map(section => ({ ...section, items: prioritizeDiscoveries(section.items) })));
  const songs = createMemo(() => prioritizeDiscoveries((feed().items ?? []).map(discoveryCatalogItem)).slice(0, 10));
  const hasContent = () => sections().some((section) => section.items.length) || songs().length > 0;
  const expanded = () => ['artists', 'albums', 'songs'].includes(props.section ?? '') ? props.section : undefined;

  async function load(refresh = false) {
    clearTimeout(timer);
    controller?.abort();
    const request = new AbortController();
    controller = request;
    try {
      const next = await api.getDiscoveryMusicFeed(request.signal, refresh);
      if (disposed || request.signal.aborted) return;
      // Keep the visible selection stable while browsing a section.
      if (!expanded() || !hasContent()) setFeed(next);
      writeSearchCache(CACHE, cacheKey, expanded() && hasContent() ? feed() : next);
      setError(!!next.browse_error || !!next.error);
      if (next.revalidating) {
        if (attempts++ < 12) timer = setTimeout(() => void load(), 5000);
        else setError(true);
      }
    } catch {
      if (!disposed && !request.signal.aborted) setError(true);
    } finally {
      if (!disposed && !request.signal.aborted) setLoading(false);
    }
  }
  onMount(() => { if (!cached || cached.revalidating || cached.browse_error) void load(); });
  createEffect(() => props.onReady(!loading() || !!hasContent()));
  onCleanup(() => { disposed = true; controller?.abort(); clearTimeout(timer); });

  return <SearchDiscoveryView sections={sections()} songs={songs()} expanded={expanded()}
    loading={loading()} error={error()} preparing={!!feed().revalidating}
    onBack={() => navigateBackOr(navigate, '/search')}
    onRetry={() => { attempts = 0; setLoading(true); setError(false); void load(true); }}
    renderMore={(section, link) => <MusicLink path={`/search?browse=${section}`} label={link.label} class={link.class}>{link.children}</MusicLink>}
    renderEntity={(item, link) => <MusicLink path={catalogDestination(item)!} class={link.class} label={link.label} onMenu={event => openCatalogEntityMenu(item, event)}>{link.children}</MusicLink>}
    renderStatus={item => <CatalogCollectionStatus item={item} />}
    renderSong={item => <CatalogResultRow showLibraryStatus item={item} active={isPlayingItem(item)} saving={props.saving.has(item.id)}
      onPlay={() => props.onPlay(item)} onDownload={() => props.onSave(item)} />} />;
}
