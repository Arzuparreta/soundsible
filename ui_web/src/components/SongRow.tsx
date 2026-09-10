import { ArtistLinks } from './MusicLinks';
import { trackMusic, type MusicMetadata } from '../lib/musicNavigation';
import { mobileListLayout } from '../lib/listLayout';
import { MusicListRow } from './MusicListRow';
import { openTrackMenu } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { createMemo, Show, type JSX } from 'solid-js';
import type { Track } from '../types/music';
import { t } from '../lib/i18n';
import styles from './SongRow.module.css';
import { coverStyle } from '../lib/cover';
import { formatDuration } from '../lib/format';
import { createResponsiveTap } from '../lib/responsiveTap';
import { savedFromTrack } from '../lib/saved';
import { isSavedTrack, state } from '../stores';
import { FavouriteButton } from './FavouriteButton';
import { Spinner } from './Spinner';
import { CollectionButton } from './CollectionButton';

export interface SongRowProps {
  track: Track;
  music?: MusicMetadata;
  /** 1-based list position; omit to hide the index column. */
  index?: number;
  /** Resolved cover URL; falls back to track.cover, then a gradient placeholder. */
  cover?: string;
  /** Optional compact type marker used by mixed result lists. */
  badge?: string;
  active?: boolean;
  favouritesKnown?: boolean;
  /** When false, the row hides its heart (podcast episodes). */
  favouritable?: boolean;
  onPlay?: (track: Track) => void;
  compact?: boolean;
  actionLabel?: string;
  primaryAction?: { label: string; onSelect: () => void };
  busy?: boolean;
  onDragStart?: (event: DragEvent) => void;
  /** When set, exposes the context menu (⋯ button, long-press, right-click).
   * The event (when present) lets the menu anchor a popover at the cursor. */
  onMenu?: (track: Track, ev?: MouseEvent) => void;
}

/** Layered background: cover on top, deterministic gradient underneath, so a
 * missing/404 cover degrades gracefully instead of showing a broken image. */
function rowCoverStyle(props: SongRowProps): JSX.CSSProperties {
  return coverStyle(props.track.id, props.cover ?? props.track.cover);
}

/**
 * Dense, pro song row. Fine-grained reactivity: toggling `active`/`favorite`
 * updates only the affected node — no row or list re-render.
 *
 * Context menu: a ⋯ button (always), plus long-press (touch) and right-click
 * (pointer) — restoring the action menu the legacy UI had on every row.
 */
export default function SongRow(props: SongRowProps) {
  const openMenu = (ev?: MouseEvent) => props.onMenu?.(props.track, ev);
  /** Identity plus snapshot, shared by the heart and the collection control so
   * the two can never disagree about which song this row is. */
  const entry = createMemo(() => savedFromTrack(props.track));

  const onRowClick = () => {
    props.onPlay?.(props.track);
  };
  const tap = createResponsiveTap({
    onTap: (event) => { event.stopPropagation(); onRowClick(); },
    onLongPress: props.onMenu ? () => openMenu() : undefined,
  });

  const rowTap = createResponsiveTap({
    onTap: (event) => {
      if ((event.target as Element).closest('a, button, input, [role="button"]')) return;
      onRowClick();
    },
    onLongPress: props.onMenu ? () => openMenu() : undefined,
  });

  const onContext = (e: MouseEvent) => {
    if (!props.onMenu) return;
    e.preventDefault();
    openMenu(e);
  };

  /** The row is the play button, so it has to answer the keys a button answers.
   * Without this the whole library was mouse-only: nothing in a list of
   * thousands of songs could be reached, let alone played, from the keyboard. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); // Space would scroll the list out from under the user
      props.onPlay?.(props.track);
      return;
    }
    // The context menu's keyboard equivalent, matching the ⋯ button and
    // long-press. No cursor to anchor to, so it opens as the sheet.
    if (props.onMenu && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
      e.preventDefault();
      openMenu();
    }
  };

  /** What a screen reader announces for the row: what it is, then what
   * activating it does. The nested artist/menu buttons name themselves. */
  const label = () =>
    props.actionLabel ?? (props.track.artist
      ? t('songRow.ariaPlay', { title: props.track.title, artist: props.track.artist })
      : props.track.title);

  return (
    <Show when={!mobileListLayout()} fallback={<MusicListRow title={props.track.title} subtitle={props.track.artist} music={props.music ?? trackMusic(props.track)} seed={props.track.id}
      cover={props.cover ?? props.track.cover} index={props.index} annotation={props.badge}
      active={props.active} busy={props.busy || (props.active && state.playback.isLoading)}
      // A compact row carries no collection marks — the same trim the desktop
      // row makes — so the shared row is told there is no entry to mark.
      entry={props.compact || props.favouritable === false ? undefined : entry()}
      favouritesKnown={props.favouritesKnown} actionLabel={label()} primaryAction={props.primaryAction}
      onActivate={() => props.onPlay?.(props.track)} onMenu={(event) => props.onMenu
        ? props.onMenu(props.track, event)
        : openTrackMenu(props.track, { music: props.music, onAddToPlaylist: openPlaylistPicker, onEditMetadata: openMetadataEditor,
            onPlayOnDevice: openPlayOnDevice }, event)} />}>
    <div
      class={styles.row}
      data-song-row
      data-compact={props.compact ? '' : undefined}
      draggable={Boolean(props.onDragStart)}
      onDragStart={props.onDragStart}
      data-pressable
      data-now-playing={props.active ? '' : undefined}
      onContextMenu={onContext}
      {...rowTap}
    >
      <Show when={props.index != null}>
        <span class={styles.index}>{props.index}</span>
      </Show>
      <div class={styles.cover} style={rowCoverStyle(props)} />
      <div class={styles.meta}>
        {/* WebKit suppresses text selection inside native buttons. Keep this
          * selectable title keyboard-operable, separate from the artist links. */}
        <span class={styles.titleButton} role="button" tabindex="0"
          aria-label={label()}
          // Announces which row is the one currently playing, so a screen-reader
          // user can find "where am I" without listening through the whole list.
          aria-current={props.active ? 'true' : undefined}
          {...tap}
          onKeyDown={onKeyDown}
          ><span class={styles.title}>{props.track.title}</span></span>
        <ArtistLinks class={styles.artist} music={props.music ?? trackMusic(props.track)} />
      </div>
      <Show when={props.badge}>
        <span class={styles.badge}>{props.badge}</span>
      </Show>
      {/* The one row control that changes state: an arrow while the song has no
        * file, a spinner while it lands, nothing once it is on disk. Its
        * presence is how a streamed song announces itself — there is no second
        * badge saying the same thing. It deliberately sits before the stable
        * duration/heart/menu stripe, so appearing never shifts those controls. */}
      <Show when={!props.compact && props.favouritable !== false}>
        <CollectionButton entry={entry()} class={styles.rowCollect} hideOwned />
      </Show>
      <div class={styles.actionStripe}>
        <Show when={props.busy}><Spinner size={14} /></Show>
        <Show when={props.primaryAction}>{(action) => <button type="button" class={styles.primaryAction} disabled={props.busy} onClick={(event) => { event.stopPropagation(); action().onSelect(); }}>{action().label}</button>}</Show>
        <Show when={!props.compact}><span class={styles.duration}>{formatDuration(props.track.duration)}</span></Show>
        {/* Downloaded or not, a song in the library gets a heart — the mark is
          * about which of your songs stand out, not about where they live. What
          * it never gets is a heart before it is yours: `entry()` is only saved
          * once the row is part of the collection. */}
        <Show when={!props.compact && props.favouritable !== false && isSavedTrack(props.track)}>
          <FavouriteButton favourite={entry()} class={styles.rowHeart} />
        </Show>
        <Show when={props.onMenu}>
          <button
            class={styles.iconBtn}
            aria-label={t('songRow.ariaMore')}
            onClick={(e) => {
              e.stopPropagation();
              openMenu(e);
            }}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>
        </Show>
      </div>
    </div>
    </Show>
  );
}
