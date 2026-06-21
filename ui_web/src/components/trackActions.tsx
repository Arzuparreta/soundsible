import type { JSX } from 'solid-js';
import { type MenuAction, type ActionMenuOptions } from './ActionMenu';
import { openContextMenu } from '../lib/contextMenu';
import type { Track } from '../types/music';
import { actions, state } from '../stores';
import { shareTrack } from '../lib/share';
import { confirmDialog } from '../lib/confirm';

/**
 * Context for building a track's action menu. Optional callbacks let later
 * phases (playlists, metadata, multi-device) plug their handlers in without
 * this module depending on them — an absent handler simply omits its item.
 */
export interface TrackMenuContext {
  navigate?: (path: string) => void;
  /** Present when the row lives inside a playlist; enables "remove from playlist". */
  playlistName?: string;
  onAddToPlaylist?: (track: Track) => void;
  onRemoveFromPlaylist?: (track: Track) => void;
  onEditMetadata?: (track: Track) => void;
  onEditCover?: (track: Track) => void;
  onPlayOnDevice?: (track: Track) => void;
}

const sw = (d: string): JSX.Element => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const icons = {
  playNext: () => sw('M5 4v16M9 5l8 7-8 7z'),
  queue: () => sw('M3 6h13M3 12h9M3 18h9M16 14v6M19 17h-6'),
  playlist: () => sw('M3 6h13M3 12h9M3 18h7M17 12v7M21 14l-4-2v7'),
  radio: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M4 12a8 8 0 018-8M4 12a8 8 0 008 8M8 12a4 4 0 014-4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  artist: () => sw('M16 19a4 4 0 00-8 0M12 11a3 3 0 100-6 3 3 0 000 6M12 2a10 10 0 100 20 10 10 0 000-20'),
  heart: () => sw('M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z'),
  edit: () => sw('M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z'),
  image: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  ),
  share: () => sw('M4 12v8h16v-8M12 16V3M8 7l4-4 4 4'),
  device: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  remove: () => sw('M5 12h14'),
  trash: () => sw('M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14'),
};

/** Build the action list for a track, given its context. */
export function buildTrackMenu(track: Track, ctx: TrackMenuContext = {}): MenuAction[] {
  const isFav = state.favorites.includes(track.id);
  const isLibrary = track.source !== 'preview';
  const list: MenuAction[] = [];

  list.push({ icon: icons.playNext(), label: 'Reproducir a continuación', onSelect: () => actions.playNext(track) });
  list.push({ icon: icons.queue(), label: 'Añadir a la cola', onSelect: () => actions.enqueue(track) });
  if (ctx.onAddToPlaylist)
    list.push({ icon: icons.playlist(), label: 'Añadir a playlist', onSelect: () => ctx.onAddToPlaylist!(track) });
  list.push({ icon: icons.radio(), label: 'Iniciar radio', onSelect: () => void actions.startRadio(track) });
  if (ctx.navigate && track.artist && isLibrary)
    list.push({ icon: icons.artist(), label: 'Ir al artista', onSelect: () => ctx.navigate!(`/artist/${encodeURIComponent(track.artist)}`) });
  list.push({
    icon: icons.heart(),
    label: isFav ? 'Quitar de favoritos' : 'Añadir a favoritos',
    onSelect: () => actions.toggleFavourite(track.id),
  });
  if (ctx.onEditMetadata && isLibrary)
    list.push({ icon: icons.edit(), label: 'Editar datos', onSelect: () => ctx.onEditMetadata!(track) });
  if (ctx.onEditCover && isLibrary)
    list.push({ icon: icons.image(), label: 'Cambiar portada', onSelect: () => ctx.onEditCover!(track) });
  list.push({ icon: icons.share(), label: 'Compartir', onSelect: () => void shareTrack(track) });
  if (ctx.onPlayOnDevice && isLibrary)
    list.push({ icon: icons.device(), label: 'Reproducir en dispositivo', onSelect: () => ctx.onPlayOnDevice!(track) });
  if (ctx.playlistName && ctx.onRemoveFromPlaylist)
    list.push({ icon: icons.remove(), label: 'Quitar de la playlist', danger: true, onSelect: () => ctx.onRemoveFromPlaylist!(track) });
  if (isLibrary)
    list.push({ icon: icons.trash(), label: 'Eliminar de la biblioteca', danger: true, onSelect: () => void confirmDelete(track) });

  return list;
}

async function confirmDelete(track: Track): Promise<void> {
  const ok = await confirmDialog({
    title: 'Eliminar pista',
    message: `Se eliminará «${track.title}» de la biblioteca y del disco.`,
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (ok) void actions.deleteTrack(track.id);
}

/** The full menu definition for a track (for `use:ctxMenu`). */
export function trackMenuOptions(track: Track, ctx: TrackMenuContext = {}): ActionMenuOptions {
  return { title: track.title, subtitle: track.artist, actions: buildTrackMenu(track, ctx) };
}

/** Open the action menu for a track. Pass the triggering event to anchor a
 * cursor popover on desktop (otherwise a bottom sheet). */
export function openTrackMenu(track: Track, ctx: TrackMenuContext = {}, ev?: MouseEvent): void {
  openContextMenu(trackMenuOptions(track, ctx), ev);
}
