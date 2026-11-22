import { catalogCollectionLabel } from '../lib/catalogCollection';
import { ArtistLinks } from './MusicLinks';
import { catalogMusic } from '../lib/musicNavigation';
import { mobileListLayout } from '../lib/listLayout';
import { MusicListRow } from './MusicListRow';
import { openEntryMenu } from './entryActions';
import { createMemo, Show, type JSX } from 'solid-js';
import { itemArtist, itemBusy, itemToTrack } from '../lib/catalogItem';
import { coverStyle } from '../lib/cover';
import { coverUrl } from '../lib/media';
import { createResponsiveTap } from '../lib/responsiveTap';
import { savedFromCatalogItem } from '../lib/saved';
import { formatDuration } from '../lib/format';
import { t } from '../lib/i18n';
import type { MenuEvent } from '../lib/menuEvent';
import { IconButton } from '../design/Control';
import { OverflowIcon } from '../design/OverflowIcon';
import { isSavedItem } from '../stores';
import type { CatalogItem, RecommendationContext } from '../types/music';
import { CollectionButton } from './CollectionButton';
import { FavouriteButton } from './FavouriteButton';
import { Spinner } from './Spinner';
import styles from './CatalogResultRow.module.css';

export interface CatalogResultRowProps {
  item: CatalogItem;
  active?: boolean;
  saving?: boolean;
  index?: number;
  showSource?: boolean;
  showLibraryStatus?: boolean;
  showArtist?: boolean;
  onPlay: () => void;
  onDownload: () => void;
  onNotInterested?: () => void;
  onUndoNotInterested?: () => void;
  onLessFromArtist?: (artist: string) => void;
  onUndoLessFromArtist?: (artist: string) => void;
}

/** Shared external-catalog song row used by Search, Artist and Album. */
export function CatalogResultRow(props: CatalogResultRowProps) {
  const entry = createMemo(() => savedFromCatalogItem(props.item));
  const busy = () => itemBusy(props.item);
  const openMenu = (event?: MenuEvent) => openEntryMenu(entry(), {
    item: props.item,
    music: catalogMusic(props.item),
    track: itemToTrack(props.item) ?? undefined,
    recommendation: props.item.raw?.recommendation as RecommendationContext | undefined,
    onDownload: props.onDownload,
    onNotInterested: props.onNotInterested,
    onUndoNotInterested: props.onUndoNotInterested,
    onLessFromArtist: props.onLessFromArtist,
    onUndoLessFromArtist: props.onUndoLessFromArtist,
    busy: props.saving,
  }, event);
  const tap = createResponsiveTap({
    onTap: (event) => { event.stopPropagation(); props.onPlay(); },
    onLongPress: () => openMenu(),
  });
  const rowTap = createResponsiveTap({
    onTap: (event) => {
      if (!(event.target as Element).closest('a, button, input, [role="button"]')) props.onPlay();
    },
    onLongPress: () => openMenu(),
  });
  const artwork = (): JSX.CSSProperties =>
    coverStyle(
      props.item.id,
      props.item.cover || (props.item.track_id ? coverUrl(props.item.track_id, 'thumb') : null),
    );

  return (
    <Show when={!mobileListLayout()} fallback={<MusicListRow playback title={props.item.title} subtitle={props.showArtist === false ? undefined : props.item.subtitle || itemArtist(props.item)}
      music={props.showArtist === false ? undefined : catalogMusic(props.item)} seed={props.item.id} cover={props.item.cover || (props.item.track_id ? coverUrl(props.item.track_id, 'thumb') : undefined)}
      annotation={props.showLibraryStatus ? catalogCollectionLabel(props.item) : undefined}
      index={props.index} active={props.active} busy={busy() || props.saving} entry={entry()}
      onActivate={props.onPlay} onMenu={openMenu} />}>
    <div
      class={styles.row}
      data-catalog-row
      data-pressable
      data-now-playing={props.active ? '' : undefined}
      aria-busy={busy()}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu(event);
      }}
      {...rowTap}
    >
      <Show when={props.index != null}>
        <span class={styles.index}>{props.index}</span>
      </Show>
      <span class={styles.cover} style={artwork()}>
        <Show when={busy()}>
          <span class={styles.coverBusy}>
            <Spinner size={18} />
          </span>
        </Show>
      </span>
      <span class={styles.meta}>
        {/* WebKit suppresses text selection inside native buttons. Keep this
          * selectable title keyboard-operable, separate from the artist links. */}
        <span class={styles.titleButton} role="button" tabindex="0"
          {...tap}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              openMenu(event);
              return;
            }
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            props.onPlay();
          }}
          aria-label={props.item.title}
          ><span class={styles.title}>{props.item.title}</span></span>
        <span class={styles.subtitleLine}>
          <Show when={props.showArtist !== false}>
            <ArtistLinks class={styles.subtitle} music={catalogMusic(props.item)} fallback={props.item.subtitle || itemArtist(props.item)} />
          </Show>
          <Show when={props.showLibraryStatus && catalogCollectionLabel(props.item)}>{label =>
            <span class={styles.collectionStatus}>{label()}</span>
          }</Show>
        </span>
      </span>
      <Show when={props.showSource}>
        <span class={styles.source}>{props.item.source}</span>
      </Show>
      <span class={styles.duration}>{formatDuration(props.item.duration)}</span>
      <span class={styles.actionStripe}>
        <Show when={isSavedItem(props.item)}>
          <FavouriteButton favourite={entry()} compact />
        </Show>
        <CollectionButton
          entry={entry()}
          compact
          busy={props.saving}
          onDownload={props.onDownload}
        />
        <IconButton
          data-row-menu
          class={styles.iconBtn}
          label={`${t('songRow.ariaMore')}: ${props.item.title}`}
          onClick={(event) => {
            event.stopPropagation();
            openMenu(event);
          }}
        >
          <OverflowIcon />
        </IconButton>
      </span>
    </div>
    </Show>
  );
}
