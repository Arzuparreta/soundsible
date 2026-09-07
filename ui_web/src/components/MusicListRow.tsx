import { Show, type JSX } from 'solid-js';
import { coverStyle } from '../lib/cover';
import { createResponsiveTap } from '../lib/responsiveTap';
import { t } from '../lib/i18n';
import { isDownloadingKeys, isFavouriteKeys } from '../stores';
import type { SavedEntry } from '../types/music';
import { Spinner } from './Spinner';
import styles from './MusicListRow.module.css';

export interface MusicListRowProps {
  title: string;
  subtitle?: string;
  seed: string;
  cover?: string | null;
  round?: boolean;
  index?: string | number;
  /** Functional metadata (e.g. cued), never another independent control. */
  annotation?: string;
  active?: boolean;
  busy?: boolean;
  busyLabel?: string;
  entry?: SavedEntry;
  /** The list already communicates that every item is a favourite. */
  favouritesKnown?: boolean;
  favourite?: boolean;
  actionLabel?: string;
  /** A named action the row carries in the open, beside the overflow menu.
   * Reserved for placement — asking for a song, putting one in the route —
   * where the whole list exists to be acted on and burying the verb in a menu
   * would cost a tap per item. */
  primaryAction?: { label: string; onSelect: () => void };
  disabled?: boolean;
  onActivate?: () => void;
  onMenu?: (event?: MouseEvent) => void;
  /** Visible controls are reserved for explicit edit/placement mode. */
  editing?: boolean;
  editControls?: JSX.Element;
}

/** Shared content-first row. Primary action and overflow are sibling buttons,
 * so tapping or keyboard-activating a menu can never also play its song. */
export function MusicListRow(props: MusicListRowProps) {
  const downloading = () => Boolean(props.entry && isDownloadingKeys(props.entry.keys));
  const busy = () => props.busy || downloading();
  const favourite = () => !props.favouritesKnown
    && (props.favourite ?? Boolean(props.entry && isFavouriteKeys(props.entry.keys)));
  const busyLabel = () => props.busyLabel ?? (downloading() ? t('collection.downloading') : t('common.loading'));
  const label = () => [props.actionLabel ?? [props.title, props.subtitle].filter(Boolean).join(' — '),
    props.annotation, busy() ? busyLabel() : favourite() ? t('nav.favourites') : undefined].filter(Boolean).join(' · ');
  const tap = createResponsiveTap({
    onTap: (event) => { event.stopPropagation(); if (!props.disabled) props.onActivate?.(); },
    onLongPress: props.onMenu ? () => props.onMenu?.() : undefined,
  });
  const menuTap = createResponsiveTap({ onTap: (event) => { event.stopPropagation(); props.onMenu?.(); } });
  const primaryTap = createResponsiveTap({
    onTap: (event) => { event.stopPropagation(); if (!props.disabled && !busy()) props.primaryAction?.onSelect(); },
  });
  return (
    <div class={styles.row} data-music-list-row data-now-playing={props.active ? '' : undefined}
      data-editing={props.editing ? '' : undefined} aria-busy={busy() || undefined}>
      <button class={styles.main} type="button" data-row-main data-pressable
        aria-label={label()} aria-current={props.active ? 'true' : undefined}
        aria-disabled={props.disabled || !props.onActivate || undefined} {...tap}
        onContextMenu={(event) => { if (props.onMenu) { event.preventDefault(); props.onMenu(event); } }}
        onKeyDown={(event) => {
          if (props.onMenu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
            event.preventDefault(); props.onMenu();
          }
        }}>
        <span class={styles.meta} data-row-meta>
          <span class={styles.title}>{props.title}</span>
          <span class={styles.subtitle}>
            <span class={styles.detail}><Show when={props.index != null}><span class={styles.index}>{props.index} · </span></Show>
              {props.subtitle}</span>
            <Show when={props.annotation}><span class={styles.annotation}>{props.subtitle ? ' · ' : ''}{props.annotation}</span></Show>
          </span>
        </span>
      </button>
      {/* Named by its own text, the way the desktop row names it. The row
        * itself already announces the same verb against the title, and a second
        * control repeating that name verbatim would leave a screen reader with
        * two identical buttons and no way to tell them apart. */}
      <Show when={props.primaryAction}>{(action) => (
        <button class={styles.primary} type="button" data-row-primary data-pressable
          aria-disabled={props.disabled || busy() || undefined}
          {...primaryTap}>{action().label}</button>
      )}</Show>
      <Show when={props.editing && props.editControls} fallback={<Show when={props.onMenu}>
        <button class={styles.menu} type="button" data-row-menu data-pressable
          aria-label={`${t('songRow.ariaMore')}: ${props.title}`} aria-haspopup="dialog" {...menuTap}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </Show>}>
        <span class={styles.edit}>{props.editControls}</span>
      </Show>
      {/* Last in the row and hard against the screen edge, so the covers line
        * up as one column down the list. It sits outside the main button now:
        * decorative, as its `aria-hidden` always said, and no longer part of
        * what a tap on the row's text activates. */}
      <span class={styles.cover} data-row-cover data-round={props.round ? '' : undefined}
        style={coverStyle(props.seed, props.cover)} aria-hidden="true">
        <Show when={busy()} fallback={<Show when={favourite()}>
          <span class={styles.mark} data-row-favourite>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z" /></svg>
          </span>
        </Show>}>
          <span class={styles.busy} data-row-busy><Spinner size={18} /></span>
        </Show>
      </span>
    </div>
  );
}
