import { createMemo, Show } from 'solid-js';
import { actions, isDownloadingKeys, isSavedKeys, ownedTrackForKeys } from '../stores';
import { t } from '../lib/i18n';
import type { SavedEntry } from '../types/music';
import { Spinner } from './Spinner';
import styles from './CollectionButton.module.css';

export type CollectionState = 'unsaved' | 'streaming' | 'downloading' | 'owned';

export interface CollectionButtonProps {
  /** The song this control acts on — identity plus snapshot, from `lib/saved`. */
  entry: SavedEntry;
  /** Smaller variant for dense rows (search results, album tracklists). */
  compact?: boolean;
  /** Extra class from the host surface, for layout only. */
  class?: string;
  /** Render nothing at all once the song has a file. The library uses this:
   * nearly every row there is downloaded, so a tick on each is noise and its
   * *absence* stops meaning anything. The control takes no space either — an
   * empty box on every downloaded row is a worse trade than letting the few
   * rows that still offer something sit a little wider. */
  hideOwned?: boolean;
  /** How this surface downloads, when it knows better than the store. Catalog
   * rows pass their own: a Deezer row has to be matched to a video first, and
   * the server may come back asking which version the user meant. */
  onDownload?: () => void;
  /** Force the spinner while a surface-owned download is being arranged. */
  busy?: boolean;
  /** Show a pointer tooltip. Worth it on the player surfaces, noise on rows. */
  tooltip?: boolean;
}

/**
 * How a song is held, as one control that always offers the next step.
 *
 * ＋ → ⬇ → spinner → ✓, and nothing else. The state *is* the affordance: a
 * download arrow on a row says "this one has no file" without a second icon
 * saying the same thing more quietly, which is why there is no cloud badge
 * anywhere in the app.
 *
 * Saving and downloading are different acts and this is where that becomes
 * visible: ＋ claims the song (instant, costs nothing, streams), ⬇ makes it
 * yours on disk. The heart is not here at all — it lives on `FavouriteButton`
 * and only appears once a song has passed the first step.
 */
export function CollectionButton(props: CollectionButtonProps) {
  const keys = createMemo(() => props.entry.keys);
  const state = createMemo<CollectionState>(() => {
    if (ownedTrackForKeys(keys())) return 'owned';
    if (props.busy || isDownloadingKeys(keys())) return 'downloading';
    return isSavedKeys(keys()) ? 'streaming' : 'unsaved';
  });

  const label = () => {
    switch (state()) {
      case 'owned':
        return t('collection.owned');
      case 'downloading':
        return t('collection.downloading');
      case 'streaming':
        return t('collection.download');
      default:
        return t('collection.save');
    }
  };

  const act = (event: MouseEvent) => {
    // Rows are buttons themselves; acting on one must not also play it.
    event.stopPropagation();
    if (state() === 'unsaved') actions.toggleSaved(props.entry);
    else if (state() === 'streaming') {
      if (props.onDownload) props.onDownload();
      else void actions.downloadSaved(props.entry);
    }
  };

  const slotClass = () =>
    `${styles.slot}${props.compact ? ` ${styles.compact}` : ''}${props.class ? ` ${props.class}` : ''}`;

  return (
    <Show when={!(props.hideOwned && state() === 'owned')}>
      <Show
        when={state() !== 'downloading'}
        fallback={
          <span class={slotClass()}>
            <Spinner size={props.compact ? 17 : 20} label={t('collection.downloading')} />
          </span>
        }
      >
        <button
          class={slotClass()}
          type="button"
          data-state={state()}
          // The ✓ is a statement, not an offer — deleting a file is the track
          // menu's job, and a tappable tick would be a trap next to it.
          disabled={state() === 'owned'}
          aria-label={label()}
          title={props.tooltip ? label() : undefined}
          onClick={act}
        >
          <Show when={state() === 'unsaved'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </Show>
          <Show when={state() === 'streaming'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
            </svg>
          </Show>
          <Show when={state() === 'owned'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m5 12 5 5L20 7" />
            </svg>
          </Show>
        </button>
      </Show>
    </Show>
  );
}
