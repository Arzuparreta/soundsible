import { createEffect, createSignal, createUniqueId, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import type { DiscoveryBrowseItem, DiscoveryBrowseSection } from '../lib/api';
import type { CatalogItem } from '../types/music';
import { t } from '../lib/i18n';
import { discoveryHasVisible } from '../lib/searchDiscovery';
import { CoverImage } from './CoverImage';
import { SkeletonCards, SkeletonRows } from './Skeleton';
import styles from './SearchDiscovery.module.css';

export interface DiscoveryLink {
  label: string; class: string; children: JSX.Element;
}

/** How many songs the home shows before "See all" opens the whole list. */
const SONGS_PREVIEW = 5;

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
  let root: HTMLDivElement | undefined;
  let disposed = false;
  onCleanup(() => { disposed = true; });
  // The activated link disappears during expansion. Keep keyboard position
  // inside the new content, and restore its own link when returning home.
  createEffect(on(() => props.expanded, (next, previous) => {
    queueMicrotask(() => {
      if (disposed || !root?.isConnected) return;
      const target = next ? root.querySelector<HTMLElement>('h2')
        : [...root.querySelectorAll<HTMLElement>('[data-discovery-more]')]
          .find(element => element.dataset.discoveryMore === previous)?.querySelector<HTMLElement>('a, button');
      (target ?? root.querySelector<HTMLElement>('h2'))?.focus({ preventScroll: true });
    });
  }, { defer: true }));
  const sections = () => props.sections.filter(section => section.items.length && (!props.expanded || props.expanded === section.id));
  const showSongs = () => props.songs.length > 0 && (!props.expanded || props.expanded === 'songs');
  // Judged by what this view draws: an opened section is empty when it is,
  // whatever the rest of the feed holds.
  const hasVisible = () => discoveryHasVisible(props.sections, props.songs, props.expanded);
  const title = (id: string, popular = false) => id === 'artists'
    ? t(popular ? 'searchHome.popularArtists' : 'searchHome.artists')
    : id === 'albums' ? t(popular ? 'searchHome.popularAlbums' : 'searchHome.albums') : t('searchHome.songs');
  const more = (id: string, name: string) => <span data-discovery-more={id}>{props.renderMore(id, { label: `${t('searchHome.seeAll')}: ${name}`, class: styles.more, children: t('searchHome.seeAll') })}</span>;
  return <div ref={root} class={styles.home} data-testid="search-discovery">
    <Show when={props.expanded}><button class={styles.back} type="button" onClick={props.onBack}>
      <ChevronIcon direction="left" />{t('searchHome.back')}
    </button></Show>
    <Show when={props.loading && !hasVisible()}>
      <Show when={props.expanded} fallback={<><SkeletonCards count={3} shape="round" /><SkeletonCards count={3} /><SkeletonRows count={5} compact /></>}>
        <Show when={props.expanded === 'songs'} fallback={<SkeletonCards count={8} shape={props.expanded === 'artists' ? 'round' : 'square'} />}><SkeletonRows count={8} compact /></Show>
      </Show>
    </Show>
    <For each={sections()}>{section => <DiscoveryEntitySection title={title(section.id, section.popular)} items={section.items}
      round={section.id === 'artists'} expanded={!!props.expanded}
      more={!props.expanded && section.items.length > 2 ? more(section.id, title(section.id, section.popular)) : undefined}
      renderEntity={props.renderEntity} renderStatus={props.renderStatus} />}</For>
    <Show when={showSongs()}><DiscoverySection title={title('songs')}
      actions={!props.expanded && props.songs.length > SONGS_PREVIEW ? more('songs', title('songs')) : undefined}>
      <div class={styles.songs}><For each={props.expanded ? props.songs : props.songs.slice(0, SONGS_PREVIEW)}>{props.renderSong}</For></div>
    </DiscoverySection></Show>
    <Show when={!props.loading && !hasVisible() && !props.error}>
      <p class={styles.notice} role="status">{t(props.preparing ? 'searchHome.preparing' : props.expanded ? 'searchHome.sectionEmpty' : 'searchHome.empty')}</p>
    </Show>
    <Show when={props.error}><div class={styles.notice} role="status">{t('searchHome.error')}{' '}
      <button type="button" class={styles.retry} onClick={props.onRetry}>{t('common.retry')}</button>
    </div></Show>
  </div>;
}

/** A titled block: heading on the left, its own commands on the right. */
function DiscoverySection(props: { title: string; actions?: JSX.Element; children: JSX.Element }) {
  const id = createUniqueId();
  return <section class={styles.section} aria-labelledby={id}>
    <div class={styles.heading}>
      <h2 id={id} tabindex="-1">{props.title}</h2>
      <div class={styles.actions}>{props.actions}</div>
    </div>
    {props.children}
  </section>;
}

function DiscoveryEntitySection(props: {
  title: string; items: DiscoveryBrowseItem[]; round: boolean; expanded: boolean; more?: JSX.Element;
  renderEntity: (item: DiscoveryBrowseItem, link: DiscoveryLink) => JSX.Element;
  renderStatus: (item: DiscoveryBrowseItem) => JSX.Element;
}) {
  let rail: HTMLDivElement | undefined;
  const [left, setLeft] = createSignal(false), [right, setRight] = createSignal(false);
  const update = () => {
    if (!rail || props.expanded) return;
    setLeft(rail.scrollLeft > 1);
    setRight(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1);
  };
  onMount(() => {
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : undefined;
    if (rail) observer?.observe(rail);
    update(); onCleanup(() => observer?.disconnect());
  });
  const page = (direction: 1 | -1) => rail?.scrollBy({ left: direction * rail.clientWidth * .8 });
  return <DiscoverySection title={props.title} actions={<>
    {props.more}
    {/* Only a rail that can actually move offers the arrows. */}
    <Show when={!props.expanded && (left() || right())}><div class={styles.controls}>
      <button type="button" disabled={!left()} aria-label={`${t('searchHome.previous')}: ${props.title}`} onClick={() => page(-1)}><ChevronIcon direction="left" /></button>
      <button type="button" disabled={!right()} aria-label={`${t('searchHome.next')}: ${props.title}`} onClick={() => page(1)}><ChevronIcon direction="right" /></button>
    </div></Show>
  </>}>
    <div ref={rail} onScroll={update} class={props.expanded ? styles.grid : styles.rail}>
      <For each={props.items}>{item => props.renderEntity(item, { label: item.title, class: styles.entity, children: <>
        <span classList={{ [styles.cover]: true, [styles.round]: props.round }}><CoverImage src={item.cover} /></span>
        <span class={styles.meta}>
          <span class={styles.name}>{item.title}</span>
          <Show when={!props.round && item.artist}><span class={styles.subtitle}>{item.artist}</span></Show>
          {props.renderStatus(item)}
        </span>
      </> })}</For>
    </div>
  </DiscoverySection>;
}

function ChevronIcon(props: { direction: 'left' | 'right' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={props.direction === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
  </svg>;
}
