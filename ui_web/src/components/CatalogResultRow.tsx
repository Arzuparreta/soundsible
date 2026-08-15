import { createMemo, Show, type JSX } from 'solid-js';
import { itemArtist, itemBusy } from '../lib/catalogItem';
import { coverStyle } from '../lib/cover';
import { coverUrl } from '../lib/media';
import { createResponsiveTap } from '../lib/responsiveTap';
import { savedFromCatalogItem } from '../lib/saved';
import { formatDuration } from '../lib/format';
import { isSavedItem } from '../stores';
import type { CatalogItem } from '../types/music';
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
  showArtist?: boolean;
  onPlay: () => void;
  onDownload: () => void;
}

/** Shared external-catalog song row used by Search, Artist and Album. */
export function CatalogResultRow(props: CatalogResultRowProps) {
  const entry = createMemo(() => savedFromCatalogItem(props.item));
  const busy = () => itemBusy(props.item);
  const tap = createResponsiveTap({ onTap: props.onPlay });
  const artwork = (): JSX.CSSProperties =>
    coverStyle(
      props.item.id,
      props.item.cover || (props.item.track_id ? coverUrl(props.item.track_id, 'thumb') : null),
    );

  return (
    <div
      class={styles.row}
      data-pressable
      data-now-playing={props.active ? '' : undefined}
      aria-busy={busy()}
      role="button"
      tabindex="0"
      {...tap}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        props.onPlay();
      }}
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
        <span class={styles.title}>{props.item.title}</span>
        <Show when={props.showArtist !== false}>
          <span class={styles.subtitle}>{props.item.subtitle || itemArtist(props.item)}</span>
        </Show>
      </span>
      <Show when={props.showSource}>
        <span class={styles.source}>{props.item.source}</span>
      </Show>
      <span class={styles.duration}>{formatDuration(props.item.duration)}</span>
      <Show when={isSavedItem(props.item)}>
        <FavouriteButton favourite={entry()} compact />
      </Show>
      <CollectionButton
        entry={entry()}
        compact
        busy={props.saving}
        onDownload={props.onDownload}
      />
    </div>
  );
}
