import { createMemo } from 'solid-js';
import { actions, isFavouriteKeys } from '../stores';
import { t } from '../lib/i18n';
import type { FavouriteEntry } from '../types/music';
import styles from './FavouriteButton.module.css';

export interface FavouriteButtonProps {
  /** The song this heart saves — identity plus snapshot, built by `lib/favourites`. */
  favourite: FavouriteEntry;
  /** Smaller variant for dense rows (search results, album tracklists). */
  compact?: boolean;
  /** Extra class from the host surface, for layout only. */
  class?: string;
  /** Show a pointer tooltip. Worth it on the player surfaces, noise on rows. */
  tooltip?: boolean;
}

/**
 * The heart. One component for every surface, because the whole point is that a
 * song behaves the same whether or not you have it downloaded — and five
 * hand-rolled hearts would drift apart the moment one of them learned something
 * the others did not.
 *
 * It never asks whether the song is in the library: it matches identities, so it
 * lights up for the Deezer row, the YouTube result, the preview that is playing
 * and the downloaded file alike.
 */
export function FavouriteButton(props: FavouriteButtonProps) {
  const saved = createMemo(() => isFavouriteKeys(props.favourite.keys));
  const label = () => (saved() ? t('trackActions.removeFav') : t('trackActions.addFav'));

  return (
    <button
      class={`${styles.heart}${props.compact ? ` ${styles.compact}` : ''}${props.class ? ` ${props.class}` : ''}`}
      type="button"
      data-saved={saved() ? '' : undefined}
      aria-pressed={saved()}
      aria-label={label()}
      title={props.tooltip ? label() : undefined}
      onClick={(e) => {
        // Rows are buttons themselves; hearting one must not also play it.
        e.stopPropagation();
        actions.toggleFavourite(props.favourite);
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill={saved() ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z" />
      </svg>
    </button>
  );
}
