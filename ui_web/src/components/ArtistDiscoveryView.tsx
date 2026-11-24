import { CollectionSearch, NoCollectionMatches, createCollectionSearch } from './CollectionSearch';
import { trackSearchFields } from '../lib/librarySearch';
import { createEffect, createMemo, createSignal, on, createUniqueId, For, Show, type JSX } from 'solid-js';
import type { AlbumSummary, ArtistSummary, CatalogItem } from '../types/music';
import type { SavedEntity } from '../lib/savedEntityIdentity';
import { albumPath, artistPath } from '../lib/artistRoute';
import { coverGradient } from '../lib/cover';
import { formatRecordType, formatReleaseDate } from '../lib/releaseFormat';
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

/** Reusable release shelf (Albums, Singles & EPs, More by artist) shared across web and Android. */
export function ReleaseShelf(props: {
  title: string;
  artistName: string;
  releases: AlbumSummary[];
  renderLink: (link: ArtistDiscoveryLink) => JSX.Element;
}) {
  return <Shelf title={props.title} count={props.releases.length}>
    <For each={props.releases}>{album => props.renderLink({
      class: styles.albumCard,
      entity: {
        kind: 'album', name: album.title, artist: props.artistName, cover: album.cover,
        destination: albumPath(album.title, props.artistName, { view: 'discover', deezerId: album.deezer_id }),
      },
      children: <>
        <span class={styles.albumCover} style={{ background: coverGradient(album.title) }}><CoverImage src={album.cover} /></span>
        <span class={styles.albumName}>{album.title}</span>
        <span class={styles.albumCount}>{album.year ? `${album.year}` : ''}</span>
      </>,
    })}</For>
  </Shelf>;
}

/** Discography layout shared by the web player and native Android transport. */
export function ArtistDiscoveryView(props: {
  topTracks: CatalogItem[]; albums: AlbumSummary[]; singlesEps: AlbumSummary[]; related: ArtistSummary[];
  latestRelease?: AlbumSummary | null;
  loading: boolean; artistName: string;
  /** `index` is the row's 1-based place in `queue`, the rows on screen; `rank`
   * is its place among the top tracks, which filtering does not change. */
  renderSong: (item: CatalogItem, index: () => number, queue: () => CatalogItem[], rank: number) => JSX.Element;
  renderLink: (link: ArtistDiscoveryLink) => JSX.Element;
}) {
  const search = createCollectionSearch();
  const topTracks = createMemo(() => props.topTracks.slice(0, 10));
  const shown = search.filter(topTracks, trackSearchFields);
  const rank = search.positions(topTracks);
  createEffect(on(() => props.artistName, () => search.setValue(''), { defer: true }));
  // One honest empty state for the whole profile rather than a "nothing here"
  // line under every heading.
  const nothing = () => !props.loading && !props.latestRelease && !props.topTracks.length && !props.albums.length
    && !props.singlesEps.length && !props.related.length;
  const latestMeta = (release: AlbumSummary) =>
    [formatRecordType(release.record_type || 'album'), formatReleaseDate(release.release_date, release.year)].filter(Boolean).join(' · ');
  return <div class={styles.discoverView}>
    <Show when={nothing()}><div class={styles.section}><EmptyState compact>{t('artist.noCatalogData')}</EmptyState></div></Show>
    <Show when={props.latestRelease}>
      {(latest) => (
        <section class={styles.section} data-testid="artist-latest-release">
          <div class={styles.sectionHead}>
            <h2 class={styles.sectionTitle}>{t('artist.latestRelease')}</h2>
          </div>
          {props.renderLink({
            class: styles.latestCard,
            entity: {
              kind: 'album', name: latest().title, artist: props.artistName, cover: latest().cover,
              destination: albumPath(latest().title, props.artistName, { view: 'discover', deezerId: latest().deezer_id }),
            },
            children: <>
              <span class={styles.latestCover} style={{ background: coverGradient(latest().title) }}>
                <CoverImage src={latest().cover} />
              </span>
              <span class={styles.latestBody}>
                <span class={styles.latestTitle}>{latest().title}</span>
                <Show when={latestMeta(latest())}>{(meta) => <span class={styles.latestMeta}>{meta()}</span>}</Show>
              </span>
            </>,
          })}
        </section>
      )}
    </Show>
    <Show when={topTracks().length > 0}>
      <section class={`${styles.section} ${styles.topSection}`}>
        <h2 class={styles.topTitle}>{t('artist.topTracks')}</h2>
        <CollectionSearch search={search} />
        <Show when={shown().length} fallback={<NoCollectionMatches />}>
          <div class={styles.trackList}>
            <For each={shown()}>{(item, index) => props.renderSong(item, () => index() + 1, shown, rank(item))}</For>
          </div>
        </Show>
      </section>
    </Show>
    <Show when={props.albums.length > 0}>
      <ReleaseShelf title={t('artist.albums')} artistName={props.artistName} releases={props.albums} renderLink={props.renderLink} />
    </Show>
    <Show when={props.singlesEps.length > 0}>
      <ReleaseShelf title={t('artist.singlesEps')} artistName={props.artistName} releases={props.singlesEps} renderLink={props.renderLink} />
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
