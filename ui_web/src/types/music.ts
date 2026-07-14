export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  album_artist?: string | null;
  duration?: number;
  youtube_id?: string | null;
  media_kind?: string | null;
  podcast_episode_guid?: string | null;
  cover?: string;
  source?: 'preview';
}

export interface SearchResult {
  id: string;
  title: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
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
  title: string;
  item_ids: string[];
}

export interface CatalogSearchResponse {
  query: string;
  generated_at?: number;
  cached?: boolean;
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

export interface AlbumSummary {
  deezer_id: string;
  title: string;
  cover: string;
  year?: number | null;
  track_count?: number;
}

export interface ArtistSummary {
  deezer_id: string;
  name: string;
  picture: string;
  nb_fans: number;
}

export interface LibraryAlbumSummary {
  title: string;
  cover: string;
  track_count: number;
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
  library_tracks: CatalogItem[];
  library_albums: LibraryAlbumSummary[];
  in_library: boolean;
  partial_failures?: Array<{ source: string; error: string }>;
  cached: boolean;
  generated_at?: number;
}

export interface AlbumProfile {
  title: string;
  artist: string;
  cover: string;
  year?: number | null;
  genre?: string;
  tracklist: CatalogItem[];
  library_tracks: CatalogItem[];
  in_library: boolean;
  resolved: boolean;
  partial_failures?: Array<{ source: string; error: string }>;
  cached: boolean;
  generated_at?: number;
}
