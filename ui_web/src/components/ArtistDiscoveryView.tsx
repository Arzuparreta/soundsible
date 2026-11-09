import { createSignal, createUniqueId, For, Show, type JSX } from 'solid-js';
import type { AlbumSummary, ArtistSummary, CatalogItem } from '../types/music';
import type { SavedEntity } from '../lib/savedEntityIdentity';
import { albumPath, artistPath } from '../lib/artistRoute';
import { coverGradient } from '../lib/cover';
import { t } from '../lib/i18n';
import { CoverImage } from './CoverImage';
import { EmptyState } from './EmptyState';
import styles from '../routes/Artist.module.css';

export function formatFans(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

/** "125.7K fans", from the same sentence the profile header uses. */
export function fansLabel(n: number): string {
  return t('artist.fans', { n: formatFans(n) });
}

export interface ArtistDiscoveryLink { entity: SavedEntity; class: string; children: JSX.Element }

/** Shelves longer than this offer "See all", which lays every card out in a grid. */
export const SHELF_PEEK = 4;

/** One discography shelf: a swipeable rail that can open into a wrapping grid. */
function Shelf(props: { title: string; count: number; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  const id = createUniqueId();
  return <section class={styles.section}>
    <div class={styles.sectionHead}>
      <h2 class={styles.sectionTitle}>{props.title}</h2>
      <Show when={props.count > SHELF_PEEK}>
        <button type="button" class={styles.shelfToggle} aria-expanded={open()} aria-controls={id}
          aria-label={`${open() ? t('savedEntities.showLess') : t('searchHome.seeAll')}: ${props.title}`}
          onClick={() => setOpen(value => !value)}>
          {open() ? t('savedEntities.showLess') : t('searchHome.seeAll')}
        </button>
      </Show>
    </div>
    <div id={id} class={open() ? styles.shelfGrid : styles.albumRail} data-horizontal-scroll={open() ? undefined : ''}>
      {props.children}
    </div>
  </section>;
}

/** Discography layout shared by the web player and native Android transport. */
export function ArtistDiscoveryView(props: {
  topTracks: CatalogItem[]; albums: AlbumSummary[]; singlesEps: AlbumSummary[]; related: ArtistSummary[];
  loading: boolean; artistName: string;
  renderSong: (item: CatalogItem, index: number, queue: CatalogItem[]) => JSX.Element;
  renderLink: (link: ArtistDiscoveryLink) => JSX.Element;
}) {
  const albumCards = (albums: AlbumSummary[]) => <For each={albums}>{album => props.renderLink({ class: styles.albumCard,
    entity: { kind: 'album', name: album.title, artist: props.artistName, cover: album.cover,
      destination: albumPath(album.title, props.artistName, { view: 'discover', deezerId: album.deezer_id }) },
    children: <><span class={styles.albumCover} style={{ background: coverGradient(album.title) }}><CoverImage src={album.cover} /></span>
      <span class={styles.albumName}>{album.title}</span><span class={styles.albumCount}>{album.year ? `${album.year}` : ''}</span></> })}</For>;
  const topTracks = () => props.topTracks.slice(0, 10);
  // One honest empty state for the whole profile rather than a "nothing here"
  // line under every heading.
  const nothing = () => !props.loading && !props.topTracks.length && !props.albums.length
    && !props.singlesEps.length && !props.related.length;
  return <div class={styles.discoverView}>
    <Show when={nothing()}><div class={styles.section}><EmptyState compact>{t('artist.noCatalogData')}</EmptyState></div></Show>
    <Show when={topTracks().length > 0}>
      <section class={`${styles.section} ${styles.topSection}`}>
        <h2 class={styles.topTitle}>{t('artist.topTracks')}</h2>
        <div class={styles.trackList}><For each={topTracks()}>{(item, index) => props.renderSong(item, index() + 1, topTracks())}</For></div>
      </section>
    </Show>
    <Show when={props.albums.length > 0}>
      <Shelf title={t('artist.albums')} count={props.albums.length}>{albumCards(props.albums)}</Shelf>
    </Show>
    <Show when={props.singlesEps.length > 0}>
      <Shelf title={t('artist.singlesEps')} count={props.singlesEps.length}>{albumCards(props.singlesEps)}</Shelf>
    </Show>
    <Show when={props.related.length > 0}>
      <Shelf title={t('artist.related')} count={props.related.length}>
        <For each={props.related}>{artist => props.renderLink({ class: styles.albumCard,
          entity: { kind: 'artist', name: artist.name, cover: artist.picture, destination: artistPath(artist.name, { view: 'discover', deezerId: artist.deezer_id }) },
          children: <><span classList={{ [styles.albumCover]: true, [styles.roundCover]: true }} style={{ background: coverGradient(artist.name) }}><CoverImage src={artist.picture} /></span>
            <span class={styles.albumName}>{artist.name}</span><span class={styles.albumCount}>{fansLabel(artist.nb_fans)}</span></> })}</For>
      </Shelf>
    </Show>
  </div>;
}
