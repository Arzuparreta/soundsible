export interface Track {
  id: string;
  title: string;
  artist: string;
  /** Ordered performers when the source provided real structured credits. */
  artists?: string[] | null;
  album?: string;
  album_artist?: string | null;
  disc_number?: number | null;
  disc_total?: number | null;
  is_compilation?: boolean;
  year?: number | null;
  genre?: string | null;
  duration?: number;
  youtube_id?: string | null;
  /** Graph node that discovered this song. Playback may use a better upload. */
  discovery_youtube_id?: string | null;
  /** Trust/timeline class of the YouTube upload currently being played. */
  playback_source_kind?: string | null;
  canonical_identity?: string | null;
  media_kind?: string | null;
  podcast_episode_guid?: string | null;
  /** Original enclosure URL retained only for token refresh during recovery. */
  podcast_enclosure_url?: string | null;
  podcast_feed_id?: string | null;
  podcast_rss_url?: string | null;
  isrc?: string | null;
  musicbrainz_id?: string | null;
  audio_quality?: 'unknown' | 'lossy' | 'lossless';
  audio_source?: 'youtube' | 'jamendo' | 'wikimedia' | 'internet_archive' | 'local' | null;
  audio_source_url?: string | null;
  audio_license_url?: string | null;
  audio_identity_verified?: boolean;
  /** Bytes on disk, and the bitrate the encoder was asked for. What has to
   * cross the network is the first one — on a 24-bit FLAC they differ by a lot,
   * which is exactly when it matters. See `lib/linkQuality.ts`. */
  file_size?: number;
  bitrate?: number;
  /** When this song joined the library, naive UTC ISO-8601 — from the engine
   * for a file, from the saved entry for a song that streams. The one field
   * "recently added" is allowed to be built on; see `lib/libraryOrder.ts`. */
  added_at?: string | null;
  /** EBU R128 integrated loudness, measured once by the engine. Absent until
   * the file has been measured, which is what keeps an unmeasured track at
   * unity gain instead of guessing. */
  loudness_lufs?: number | null;
  /** True peak in dBFS, from the same pass. The player refuses any part of a
   * boost that would push this past the output ceiling. */
  loudness_peak_dbtp?: number | null;
  cover?: string;
  source?: 'preview';
  /** Identity keys of the row this track was resolved from (see
   * `lib/playbackIdentity.ts`). Set when a catalog row resolves into a playable
   * video, so the row keeps recognising itself as "playing" even though the two
   * share no id. Library tracks never carry it. */
  originKeys?: string[];
  /** Present only when a recommendation surface created this playable item. */
  recommendation?: RecommendationContext;
}

/**
 * A song in your library that is not (or not only) a file.
 *
 * Identity is the `keys` set (see `lib/playbackIdentity.ts`), never a single id
 * — a song changes id at every hop, so storing one would mean the entry
 * survives exactly one of them. The rest is a snapshot: enough to render and
 * stream the song when the library has never heard of it.
 *
 * `favourite` is the mark the heart sets. It is a property *of* a saved song,
 * which is why saving and marking cannot be the same act.
 */
export interface SavedEntry {
  keys: string[];
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  thumbnail?: string;
  favourite?: boolean;
  added_at?: string | null;
}

export interface RecommendationContext {
  identity: string;
  source: 'discover' | 'radio' | 'auto_mode' | 'autoplay' | 'podcast';
  reason?: string;
  reason_code?: string;
  discovery_youtube_id?: string;
}

export interface LyricsResponse {
  status: 'pending' | 'ready' | 'not_found' | 'unavailable';
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
  cached: boolean;
  pending?: boolean;
  timing_safe?: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  recommendation_identity?: string;
  recommendation_source?: string;
  reason?: string;
  reason_code?: string;
}

export type CatalogItemType = 'library_track' | 'track' | 'artist' | 'album' | 'playlist';

export interface CatalogActionState {
  in_library?: boolean;
  playable?: boolean;
  downloadable?: boolean;
  needs_resolution?: boolean;
}

export interface CatalogItem {
  id: string;
  type: CatalogItemType;
  source: string;
  title: string;
  subtitle?: string;
  artist?: string;
  album?: string;
  duration?: number;
  cover?: string;
  popularity?: number;
  track_id?: string | null;
  external_ids?: Record<string, string | number | boolean | null | undefined>;
  attribution_url?: string;
  action_state?: CatalogActionState;
  raw?: Partial<Track> & Record<string, unknown>;
}

export interface CatalogSection {
  id: string;
  /** How the section wants to be drawn. Absent on responses predating the contract. */
  layout?: 'hero' | 'rows' | 'grid' | 'grid_round';
  item_ids: string[];
  /** Pre-cap member count, for "see all N" without a second request. */
  total?: number;
}

export interface CatalogSearchResponse {
  query: string;
  interpreted_as?: string | null;
  generated_at?: number;
  cached?: boolean;
  /** Id of the row confident enough to lead the page, or null when none is. */
  top_result?: string | null;
  items: CatalogItem[];
  sections: CatalogSection[];
  partial_failures?: Array<{ source: string; error: string }>;
}

export interface CatalogResolveResponse {
  status?: 'resolved' | 'failed' | string;
  video_id?: string;
  confidence?: number;
  confidence_level?: string;
  confidence_reason?: string;
  best?: Record<string, unknown>;
  candidates?: Array<Record<string, unknown>>;
  reason?: string;
}

export interface CatalogSaveResponse {
  status?: 'queued' | 'needs_review' | 'failed' | string;
  queue_id?: string;
  video_id?: string;
  confidence?: number;
  confidence_level?: string;
  confidence_reason?: string;
  candidates?: Array<Record<string, unknown>>;
  reason?: string;
}

export type PlaylistMap = Record<string, string[]>;

export interface LibrarySettings {
  playlist_covers?: Record<string, string>;
}

export interface ArtistCandidate {
  deezer_id: string;
  name: string;
  picture: string;
  nb_fans: number;
  nb_album?: number;
}

/** A release on an artist's page. Deezer's artist/<id>/albums rows carry no
 * track count, so none is exposed here; `record_type` is what separates the
 * albums rail from the singles/EPs rail. */
export interface AlbumSummary {
  deezer_id: string;
  title: string;
  cover: string;
  year?: number | null;
  record_type?: string;
}

export interface ArtistSummary {
  deezer_id: string;
  name: string;
  picture: string;
  nb_fans: number;
}

export interface ArtistProfile {
  name: string;
  resolved: boolean;
  deezer_id?: string | null;
  metadata?: { name: string; picture: string; nb_fans: number };
  candidates: ArtistCandidate[];
  top_tracks: CatalogItem[];
  albums: AlbumSummary[];
  singles_eps: AlbumSummary[];
  related_artists: ArtistSummary[];
  in_library: boolean;
  partial_failures?: Array<{ source: string; error: string }>;
  cached: boolean;
  generated_at?: number;
}

/**
 * An entity from the engine's normalized catalog (`/api/library/albums`,
 * `/api/library/artists`).
 *
 * Not to be confused with `AlbumSummary` / `ArtistSummary`, which describe
 * something on Deezer that may not exist here. These are records this library
 * actually holds, identified the way the engine identifies them — so two
 * records sharing a title are two ids, and a compilation is credited to Various
 * Artists rather than to whoever happened to be its first guest.
 */
export interface CatalogAlbum {
  id: string;
  title: string;
  album_artist: string;
  album_artist_id?: string | null;
  year?: number | null;
  genre?: string | null;
  is_compilation: boolean;
  track_count: number;
  duration: number;
  /** The album's opening track — the same artwork `/rest` serves for it. */
  cover_track_id?: string | null;
}

export interface CatalogArtist {
  id: string;
  name: string;
  track_count: number;
  album_count: number;
  cover_track_id?: string | null;
}

export interface CatalogGenre {
  name: string;
  song_count: number;
  album_count: number;
}

export interface CatalogYear {
  year: number;
  album_count: number;
  track_count: number;
}

export interface AlbumProfile {
  title: string;
  artist: string;
  cover: string;
  year?: number | null;
  genre?: string;
  tracklist: CatalogItem[];
  in_library: boolean;
  resolved: boolean;
  partial_failures?: Array<{ source: string; error: string }>;
  cached: boolean;
  generated_at?: number;
}
