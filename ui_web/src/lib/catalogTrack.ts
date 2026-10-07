import type { CatalogItem, Track } from '../types/music';
import { catalogItemKeys } from './playbackIdentity';

/** Artist name for a catalog row, wherever the source put it. */
export function itemArtist(item: CatalogItem): string {
  return item.artist || item.subtitle || '';
}

/** Exact playable YouTube identity already carried by a catalog row. */
export function catalogPreviewId(item: CatalogItem): string | null {
  const id = item.source === 'youtube' ? item.raw?.id : null;
  return typeof id === 'string' && id ? id : null;
}

/**
 * The playable track behind a catalog row, if there already is one.
 *
 * Two ways a row is playable without asking the engine: it is a track we own
 * (`track_id` resolves in the library), or the search layer already attached a
 * raw YouTube payload. Otherwise `null` — the row needs `playCatalogItem`.
 */
export function catalogTrack(item: CatalogItem, library: readonly Track[]): Track | null {
  if (item.track_id) {
    const found = library.find((tr) => tr.id === item.track_id);
    if (found) {
      return item.raw?.recommendation
        ? { ...found, recommendation: item.raw.recommendation }
        : found;
    }
  }
  const previewId = catalogPreviewId(item);
  if (previewId) {
    const raw = item.raw ?? {};
    return {
      id: previewId,
      title: String(raw.title || item.title),
      artist: String(raw.artist || itemArtist(item)),
      artist_is_channel: raw.artist_is_channel ?? true,
      artists: raw.artists,
      source_title: raw.source_title,
      source_artist: raw.source_artist,
      album: typeof raw.album === 'string' ? raw.album : item.album,
      duration: typeof raw.duration === 'number' ? raw.duration : item.duration,
      youtube_id: typeof raw.youtube_id === 'string' ? raw.youtube_id : undefined,
      cover: item.cover,
      source: 'preview',
      originKeys: catalogItemKeys(item),
      recommendation: raw.recommendation,
    };
  }
  return null;
}

/** Where a catalog song sits on its record and when the record came out —
 * what a download files it under. Only rows listed from a record carry them. */
export function releasePosition(item: CatalogItem): Pick<Track, 'track_number' | 'disc_number' | 'year'> {
  const whole = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined);
  return { track_number: whole(item.raw?.track_number), disc_number: whole(item.raw?.disc_number), year: whole(item.raw?.year) };
}

/** The record a catalog song is saved from, for `/api/catalog/save` to file
 * the download under: every surface that saves a row sends the same facts.
 * Nothing without an album; the engine bounds the rest. */
export function catalogReleaseEvidence(item: CatalogItem): {
  album?: string; album_artist?: string; track_number?: number; disc_number?: number; year?: number;
} {
  const album = item.album?.trim();
  if (!album) return {};
  const albumArtist = typeof item.raw?.album_artist === 'string' ? item.raw.album_artist.trim() : '';
  const position = releasePosition(item);
  return {
    album,
    ...(albumArtist ? { album_artist: albumArtist } : {}),
    ...(position.track_number ? { track_number: position.track_number } : {}),
    ...(position.disc_number ? { disc_number: position.disc_number } : {}),
    ...(position.year ? { year: position.year } : {}),
  };
}
