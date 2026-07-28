import { request } from './api';

export type MigrationJobState =
  | 'analyzed'
  | 'queued'
  | 'running'
  | 'paused'
  | 'needs_review'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed';

export interface MigrationCandidate {
  kind?: 'library' | 'catalog';
  track_id?: string;
  video_id?: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  thumbnail?: string;
  confidence: number;
  confidence_level?: string;
}

export interface MigrationTrack {
  source_key: string;
  source: {
    title: string;
    artist: string;
    album: string;
    local_only?: boolean;
  } | null;
  state: string;
  matched_track_id?: string | null;
  confidence: number;
  candidates: MigrationCandidate[];
  error?: string | null;
}

export interface MigrationJob {
  id: string;
  provider: 'spotify' | 'apple_music' | string;
  source_name: string;
  state: MigrationJobState;
  manifest: {
    track_count: number;
    library_count: number;
    favourite_count: number;
    playlists: {
      source_id: string;
      name: string;
      track_count: number;
      track_keys: string[];
      is_favourites: boolean;
    }[];
    warnings: string[];
  };
  selection: {
    include_library?: boolean;
    playlist_ids?: string[];
  };
  playlist_names: Record<string, string>;
  counts: Record<string, number>;
  selected_counts: Record<string, number>;
  selected_track_count: number;
  estimated_download_bytes: number;
  tracks: MigrationTrack[] | null;
  error?: string | null;
}

export const migrationApi = {
  upload: async (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<{ job: MigrationJob; created: boolean }>('/api/migration/jobs', {
      method: 'POST',
      body,
      timeoutMs: 120_000,
    });
  },
  list: () => request<{ jobs: MigrationJob[] }>('/api/migration/jobs'),
  get: (id: string) => request<{ job: MigrationJob }>(`/api/migration/jobs/${id}`),
  start: (
    id: string,
    selection: { include_library: boolean; playlist_ids: string[] },
  ) =>
    request<{ job: MigrationJob }>(`/api/migration/jobs/${id}/start`, {
      method: 'POST',
      body: selection,
      timeoutMs: 20_000,
    }),
  control: (id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') =>
    request<{ job: MigrationJob }>(`/api/migration/jobs/${id}/control`, {
      method: 'POST',
      body: { action },
    }),
  decide: (
    id: string,
    payload:
      | { source_key: string; decision: 'skip' }
      | { source_key: string; decision: 'use_library_track'; track_id: string }
      | { source_key: string; decision: 'use_candidate'; candidate: MigrationCandidate },
  ) =>
    request<{ job: MigrationJob }>(`/api/migration/jobs/${id}/decision`, {
      method: 'POST',
      body: payload,
    }),
};
