import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api, type DiscoveryBrowseItem, type DiscoveryMusicFeed } from '../lib/api';
import { t } from '../lib/i18n';
import { userKey } from '../lib/session';
import { readSearchCache, writeSearchCache } from '../lib/searchCache';
import { discoveryCatalogItem } from '../lib/searchDiscovery';
import { catalogDestination } from '../lib/musicNavigation';
import { navigateBackOr } from '../lib/scrollHistory';
import { MusicLink } from './MusicLinks';
import { CoverImage } from './CoverImage';
import { CatalogResultRow } from './CatalogResultRow';
import { SkeletonCards, SkeletonRows } from './Skeleton';
import { isPlayingItem } from '../stores';
import type { CatalogItem } from '../types/music';
import styles from './SearchDiscovery.module.css';

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
  const sections = createMemo(() => feed().browse_sections ?? []);
  const songs = createMemo(() => (feed().items ?? []).slice(0, 10).map(discoveryCatalogItem));
  const hasContent = () => sections().some((section) => section.items.length) || songs().length > 0;
  const expanded = () => ['artists', 'albums', 'songs'].includes(props.section ?? '') ? props.section : undefined;
  const title = (id: string, popular = false) => id === 'artists'
    ? t(popular ? 'searchHome.popularArtists' : 'searchHome.artists')
    : id === 'albums' ? t(popular ? 'searchHome.popularAlbums' : 'searchHome.albums') : t('searchHome.songs');

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

  return <div class={styles.home} data-testid="search-discovery">
    <Show when={expanded()}>
      <button class={styles.back} type="button" onClick={() => navigateBackOr(navigate, '/search')}>← {t('searchHome.back')}</button>
    </Show>
    <Show when={loading() && !hasContent()}>
      <SkeletonCards count={3} shape="round" /><SkeletonCards count={3} /><SkeletonRows count={5} compact />
    </Show>
    <For each={sections().filter((section) => !expanded() || expanded() === section.id)}>{(section) =>
      <section aria-label={title(section.id, section.popular)}>
        <SectionHeader title={title(section.id, section.popular)} id={section.id} more={!expanded() && section.items.length > 2} />
        <EntityRail items={section.items} round={section.id === 'artists'} expanded={!!expanded()} label={title(section.id, section.popular)} />
      </section>
    }</For>
    <Show when={songs().length > 0 && (!expanded() || expanded() === 'songs')}>
      <section aria-label={title('songs')}>
        <SectionHeader title={title('songs')} id="songs" more={!expanded() && songs().length > 5} />
        <div class={styles.songs}><For each={expanded() ? songs() : songs().slice(0, 5)}>{(item) =>
          <CatalogResultRow item={item} active={isPlayingItem(item)} saving={props.saving.has(item.id)}
            onPlay={() => props.onPlay(item)} onDownload={() => props.onSave(item)} />
        }</For></div>
      </section>
    </Show>
    <Show when={!loading() && !hasContent() && !error()}>
      <p class={styles.notice}>{t(feed().revalidating ? 'searchHome.preparing' : 'searchHome.empty')}</p>
    </Show>
    <Show when={error()}>
      <div class={styles.notice} role="status">{t('searchHome.error')}{' '}
        <button type="button" class={styles.retry} onClick={() => { attempts = 0; setLoading(true); setError(false); void load(true); }}>{t('common.retry')}</button>
      </div>
    </Show>
  </div>;
}

function SectionHeader(props: { title: string; id: string; more: boolean }) {
  return <div class={styles.heading}><h2>{props.title}</h2><Show when={props.more}>
    <MusicLink path={`/search?browse=${props.id}`} label={`${t('searchHome.seeAll')}: ${props.title}`} class={styles.more}>{t('searchHome.seeAll')}</MusicLink>
  </Show></div>;
}

function EntityRail(props: { items: DiscoveryBrowseItem[]; round: boolean; expanded: boolean; label: string }) {
  let rail: HTMLDivElement | undefined;
  const [left, setLeft] = createSignal(false);
  const [right, setRight] = createSignal(false);
  const update = () => {
    if (!rail) return;
    setLeft(rail.scrollLeft > 1);
    setRight(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1);
  };
  onMount(() => {
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : undefined;
    if (rail) observer?.observe(rail);
    update();
    onCleanup(() => observer?.disconnect());
  });
  return <>
    <Show when={!props.expanded}><div class={styles.controls}>
      <button type="button" disabled={!left()} aria-label={`${t('searchHome.previous')}: ${props.label}`} onClick={() => rail?.scrollBy({ left: -rail.clientWidth * .8 })}>←</button>
      <button type="button" disabled={!right()} aria-label={`${t('searchHome.next')}: ${props.label}`} onClick={() => rail?.scrollBy({ left: rail.clientWidth * .8 })}>→</button>
    </div></Show>
    <div ref={rail} onScroll={update} classList={{ [styles.rail]: !props.expanded, [styles.grid]: props.expanded && !props.round,
      [styles.artistList]: props.expanded && props.round }}>
      <For each={props.items}>{(item) => <MusicLink path={catalogDestination(item)!} class={styles.entity} label={item.title}>
        <span classList={{ [styles.cover]: true, [styles.round]: props.round }}><CoverImage src={item.cover} /></span>
        <span class={styles.meta}><span class={styles.name}>{item.title}</span>
          <span class={styles.subtitle}>{props.round
            ? item.reason_artist ? t('searchHome.related', { artist: item.reason_artist }) : t('search.tabArtists')
            : item.artist}</span>
        </span>
      </MusicLink>}</For>
    </div>
  </>;
}
