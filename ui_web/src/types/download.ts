/**
 * Download-queue domain types — mirrors the engine's queue item shape
 * (`shared/api/download_queue.py`) and the `downloader_update` socket payloads,
 * narrowed to the fields the UI renders.
 */

export type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'failed' | 'interrupted';

/** A live item in the engine download queue (`GET /api/downloader/queue/status`). */
export interface DownloadQueueItem {
  id: string;
  status: DownloadStatus;
  source_type?: string;
  song_str?: string;
  video_id?: string;
  /** Client-supplied display fields (Discover sends these on enqueue). */
  display_title?: string;
  display_artist?: string;
  thumbnail_url?: string;
  duration_sec?: number;
  /** Podcast intake variants. */
  podcast_title?: string;
  podcast_show_title?: string;
  /** Live progress (downloading). */
  progress_percent?: number | null;
  speed?: string;
  eta?: string;
  phase?: string;
  total_bytes?: number;
  /** Failure detail. */
  error?: string;
  error_kind?: string;
  error_message?: string;
}

/** A `downloader_update` socket payload (partial item; `completed` also carries `track`). */
export interface DownloadEvent extends Partial<DownloadQueueItem> {
  id?: string;
  track?: { id?: string; title?: string; artist?: string } & Record<string, unknown>;
}

/** Ephemeral "just finished" entry shown briefly after a download completes. */
export interface CompletedDownload {
  id: string;
  title: string;
  artist: string;
}
