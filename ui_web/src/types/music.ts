/** Track as served by the engine (`Track.to_dict()`), narrowed to the fields the UI uses. */
export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  album_artist?: string | null;
  /** Duration in seconds. */
  duration?: number;
  youtube_id?: string | null;
  media_kind?: string | null;
  /** Optional explicit cover URL; otherwise resolved from id or a gradient placeholder. */
  cover?: string;
  /** Playback source: undefined/library = local stream; 'preview' = yt-dlp preview stream. */
  source?: 'preview';
}

/** A YouTube/YouTube-Music search result (Discover), normalized. */
export interface SearchResult {
  /** YouTube video id. */
  id: string;
  title: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
}

/** Playlists map: name → ordered list of track ids (engine shape). */
export type PlaylistMap = Record<string, string[]>;

export interface LibrarySettings {
  /** Optional explicit cover track id per playlist name. */
  playlist_covers?: Record<string, string>;
}
