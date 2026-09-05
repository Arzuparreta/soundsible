import type { Track, LibrarySettings } from '../types/music';
import { hasCoverArt } from './media';

/**
 * The track whose artwork stands for a playlist.
 *
 * Two rules, in order:
 *
 * 1. A cover you picked by hand wins. It is a deliberate choice about *this*
 *    playlist, so it outranks anything automatic — including the artwork check
 *    below. Clearing it (the picker's "auto") is how you ask for rule 2 back.
 * 2. Otherwise, the first track in the list that actually has artwork.
 *
 * "Has artwork" is the part that used to be missing. This walked to the first
 * track that merely *resolved* in the library index, and a song you saved
 * without downloading resolves perfectly well while having nothing at
 * `/api/static/cover/<its id>` — the engine has never heard of that id. A
 * playlist that happened to open on such a song drew a blank card even though
 * every other song in it had art. `hasCoverArt` is the whole fix: keep walking
 * until something can actually be drawn.
 *
 * Returns the `Track`, not its id, because an id cannot say *where* the art is:
 * the caller needs `trackCoverUrl` to tell the engine endpoint apart from a
 * saved song's own thumbnail. `byId` is a prebuilt library index.
 */
export function pickPlaylistCoverTrack(
  name: string,
  trackIds: string[],
  byId: ReadonlyMap<string, Track>,
  settings: LibrarySettings,
): Track | null {
  if (!trackIds.length || byId.size === 0) return null;
  const pref = settings.playlist_covers?.[name];
  if (pref && trackIds.includes(pref)) {
    const chosen = byId.get(pref);
    if (chosen) return chosen;
  }
  for (const id of trackIds) {
    const track = byId.get(id);
    if (track && hasCoverArt(track)) return track;
  }
  return null;
}
