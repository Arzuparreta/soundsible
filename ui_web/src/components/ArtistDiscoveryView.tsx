import { For, Show, type JSX } from 'solid-js';
import type { AlbumSummary, ArtistSummary, CatalogItem } from '../types/music';
import type { SavedEntity } from '../lib/savedEntityIdentity';
import { albumPath, artistPath } from '../lib/artistRoute';
import { coverGradient } from '../lib/cover';
import { t } from '../lib/i18n';
import { CoverImage } from './CoverImage';
import styles from '../routes/Artist.module.css';

export function formatFans(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}
export interface ArtistDiscoveryLink { entity: SavedEntity; class: string; children: JSX.Element }

/** Discography layout shared by the web player and native Android transport. */
export function ArtistDiscoveryView(props: {
  topTracks: CatalogItem[]; albums: AlbumSummary[]; singlesEps: AlbumSummary[]; related: ArtistSummary[];
  loading: boolean; artistName: string;
  renderSong: (item: CatalogItem, index: number, queue: CatalogItem[]) => JSX.Element;
  renderLink: (link: ArtistDiscoveryLink) => JSX.Element;
}) {
  const albumRail = (albums: AlbumSummary[]) => <div class={styles.albumRail} data-horizontal-scroll>
    <For each={albums}>{album => props.renderLink({ class: styles.albumCard,
      entity: { kind: 'album', name: album.title, artist: props.artistName, cover: album.cover,
        destination: albumPath(album.title, props.artistName, { view: 'discover', deezerId: album.deezer_id }) },
      children: <><span class={styles.albumCover} style={{ position: 'relative', background: coverGradient(album.title) }}><CoverImage src={album.cover} /></span>
        <span class={styles.albumName}>{album.title}</span><span class={styles.albumCount}>{album.year ? `${album.year}` : ''}</span></> })}</For>
  </div>;
  return <div class={styles.discoverView}>
    <Show when={props.topTracks.length > 0} fallback={<Show when={!props.loading}><p class={styles.sectionEmpty}>{t('artist.noTopTracks')}</p></Show>}>
      <section class={styles.section}><h2 class={styles.sectionTitle}>{t('artist.topTracks')}</h2>
        <div class={styles.trackList}><For each={props.topTracks.slice(0, 10)}>{(item, index) => props.renderSong(item, index() + 1, props.topTracks.slice(0, 10))}</For></div>
      </section>
    </Show>
    <Show when={props.albums.length > 0} fallback={<Show when={!props.loading && props.topTracks.length > 0}><p class={styles.sectionEmpty}>{t('artist.noAlbums')}</p></Show>}>
      <section class={styles.section}><h2 class={styles.sectionTitle}>{t('artist.albums')}</h2>{albumRail(props.albums)}</section>
    </Show>
    <Show when={props.singlesEps.length > 0}><section class={styles.section}><h2 class={styles.sectionTitle}>{t('artist.singlesEps')}</h2>{albumRail(props.singlesEps)}</section></Show>
    <Show when={props.related.length > 0} fallback={<Show when={!props.loading && props.topTracks.length === 0 && props.albums.length === 0}><p class={styles.sectionEmpty}>{t('artist.noRelated')}</p></Show>}>
      <section class={styles.section}><h2 class={styles.sectionTitle}>{t('artist.related')}</h2><div class={styles.albumRail} data-horizontal-scroll>
        <For each={props.related}>{artist => props.renderLink({ class: styles.albumCard,
          entity: { kind: 'artist', name: artist.name, cover: artist.picture, destination: artistPath(artist.name, { view: 'discover', deezerId: artist.deezer_id }) },
          children: <><span classList={{ [styles.albumCover]: true, [styles.roundCover]: true }} style={{ position: 'relative', background: coverGradient(artist.name) }}><CoverImage src={artist.picture} /></span>
            <span class={styles.albumName}>{artist.name}</span><span class={styles.albumCount}>{formatFans(artist.nb_fans)} {t('artist.fans').replace('{n}', '').trim()}</span></> })}</For>
      </div></section>
    </Show>
  </div>;
}
