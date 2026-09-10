import { ArtistLinks, MusicLink } from './MusicLinks';
import { catalogMusic, catalogDestination } from '../lib/musicNavigation';
import { Show, type JSX } from 'solid-js';
import { itemArtist } from '../lib/catalogItem';
import { createResponsiveTap } from '../lib/responsiveTap';
import { t } from '../lib/i18n';
import type { CatalogItem } from '../types/music';
import styles from './TopResultCard.module.css';

const TYPE_LABEL: Record<string, () => string> = {
  artist: () => t('search.typeArtist'),
  album: () => t('search.typeAlbum'),
  track: () => t('search.typeSong'),
  library_track: () => t('search.typeSong'),
  playlist: () => t('search.labelPlaylist'),
};

export interface TopResultCardProps {
  item: CatalogItem;
  active?: boolean;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  onPick: () => void;
}

/**
 * The one row the server was confident enough to lead with.
 *
 * The whole point is that it says *what kind of thing* it is: searching an
 * artist should land you on the artist, and the results page has to make that
 * obvious before you read a single row. Sized and shaped differently from the
 * rails below so it never reads as "just the first card".
 */
export function TopResultCard(props: TopResultCardProps) {
  const round = () => props.item.type === 'artist';
  const label = () => TYPE_LABEL[props.item.type]?.() ?? '';
  const tap = createResponsiveTap({ onTap: props.onPick });

  return (
    <div
      class={styles.card}
      data-pressable
      data-now-playing={props.active ? '' : undefined}
    >
      <Show when={catalogDestination(props.item)} fallback={<button class={styles.activate} type="button" aria-label={props.item.title} {...tap} />}>{(path) => <MusicLink class={styles.activate} path={path()} label={props.item.title} />}</Show>
      <span
        classList={{ [styles.cover]: true, [styles.coverRound]: round() }}
        style={props.coverStyle(props.item, round())}
      />
      <span class={styles.meta}>
        <span class={styles.title}>{props.item.title}</span>
        <span class={styles.subtitle}>{label()}<Show when={!round() && itemArtist(props.item)}> · <ArtistLinks music={catalogMusic(props.item)} fallback={itemArtist(props.item)} /></Show></span>
      </span>
    </div>
  );
}
