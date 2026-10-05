import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import type { DiscoveryBrowseItem, DiscoveryBrowseSection } from '../lib/api';
import type { CatalogItem } from '../types/music';
import { t } from '../lib/i18n';
import { CoverImage } from './CoverImage';
import { SkeletonCards, SkeletonRows } from './Skeleton';
import styles from './SearchDiscovery.module.css';

export interface DiscoveryLink {
  label: string; class: string; children: JSX.Element;
}

/** Layout is shared; navigation, collection status and playback belong to its runtime. */
export function SearchDiscoveryView(props: {
  sections: DiscoveryBrowseSection[]; songs: CatalogItem[]; expanded?: string;
  loading: boolean; error: boolean; preparing: boolean;
  onBack: () => void; onRetry: () => void;
  renderMore: (section: string, link: DiscoveryLink) => JSX.Element;
  renderEntity: (item: DiscoveryBrowseItem, link: DiscoveryLink) => JSX.Element;
  renderStatus: (item: DiscoveryBrowseItem) => JSX.Element;
  renderSong: (item: CatalogItem) => JSX.Element;
}) {
  const hasContent = () => props.sections.some(section => section.items.length) || props.songs.length > 0;
  const title = (id: string, popular = false) => id === 'artists'
    ? t(popular ? 'searchHome.popularArtists' : 'searchHome.artists')
    : id === 'albums' ? t(popular ? 'searchHome.popularAlbums' : 'searchHome.albums') : t('searchHome.songs');
  const header = (id: string, name: string, more: boolean) => <div class={styles.heading}><h2>{name}</h2><Show when={more}>
    {props.renderMore(id, { label: `${t('searchHome.seeAll')}: ${name}`, class: styles.more, children: t('searchHome.seeAll') })}
  </Show></div>;
  return <div class={styles.home} data-testid="search-discovery">
    <Show when={props.expanded}><button class={styles.back} type="button" onClick={props.onBack}>← {t('searchHome.back')}</button></Show>
    <Show when={props.loading && !hasContent()}><SkeletonCards count={3} shape="round" /><SkeletonCards count={3} /><SkeletonRows count={5} compact /></Show>
    <For each={props.sections.filter(section => !props.expanded || props.expanded === section.id)}>{section => <section aria-label={title(section.id, section.popular)}>
      {header(section.id, title(section.id, section.popular), !props.expanded && section.items.length > 2)}
      <DiscoveryEntityRail items={section.items} round={section.id === 'artists'} expanded={!!props.expanded} label={title(section.id, section.popular)}
        renderEntity={props.renderEntity} renderStatus={props.renderStatus} />
    </section>}</For>
    <Show when={props.songs.length > 0 && (!props.expanded || props.expanded === 'songs')}><section aria-label={title('songs')}>
      {header('songs', title('songs'), !props.expanded && props.songs.length > 5)}
      <div class={styles.songs}><For each={props.expanded ? props.songs : props.songs.slice(0, 5)}>{props.renderSong}</For></div>
    </section></Show>
    <Show when={!props.loading && !hasContent() && !props.error}><p class={styles.notice}>{t(props.preparing ? 'searchHome.preparing' : 'searchHome.empty')}</p></Show>
    <Show when={props.error}><div class={styles.notice} role="status">{t('searchHome.error')}{' '}
      <button type="button" class={styles.retry} onClick={props.onRetry}>{t('common.retry')}</button>
    </div></Show>
  </div>;
}

function DiscoveryEntityRail(props: {
  items: DiscoveryBrowseItem[]; round: boolean; expanded: boolean; label: string;
  renderEntity: (item: DiscoveryBrowseItem, link: DiscoveryLink) => JSX.Element;
  renderStatus: (item: DiscoveryBrowseItem) => JSX.Element;
}) {
  let rail: HTMLDivElement | undefined;
  const [left, setLeft] = createSignal(false), [right, setRight] = createSignal(false);
  const update = () => {
    if (!rail) return;
    setLeft(rail.scrollLeft > 1);
    setRight(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1);
  };
  onMount(() => {
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : undefined;
    if (rail) observer?.observe(rail);
    update(); onCleanup(() => observer?.disconnect());
  });
  return <>
    <Show when={!props.expanded}><div class={styles.controls}>
      <button type="button" disabled={!left()} aria-label={`${t('searchHome.previous')}: ${props.label}`} onClick={() => rail?.scrollBy({ left: -rail.clientWidth * .8 })}>←</button>
      <button type="button" disabled={!right()} aria-label={`${t('searchHome.next')}: ${props.label}`} onClick={() => rail?.scrollBy({ left: rail.clientWidth * .8 })}>→</button>
    </div></Show>
    <div ref={rail} onScroll={update} classList={{ [styles.rail]: !props.expanded, [styles.grid]: props.expanded && !props.round, [styles.artistList]: props.expanded && props.round }}>
      <For each={props.items}>{item => props.renderEntity(item, { label: item.title, class: styles.entity, children: <>
        <span classList={{ [styles.cover]: true, [styles.round]: props.round }}><CoverImage src={item.cover} /></span>
        <span class={styles.meta}><span class={styles.name}>{item.title}</span><Show when={!props.round}><span class={styles.subtitle}>{item.artist}</span></Show>{props.renderStatus(item)}</span>
      </> })}</For>
    </div>
  </>;
}
