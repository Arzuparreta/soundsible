import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { isPodcastTrack } from "../lib/track";
import { savedVideoId } from "../lib/saved";
import { trackKeys } from "../lib/playbackIdentity";
import { t as tr } from "../lib/i18n";
import type { Track, SavedEntry } from "../types/music";
import { state, setState } from "./core";
import type { PlayerActions } from "./contracts";
export interface DownloadActionsPorts {
  actions: Pick<PlayerActions, 'downloadTrack' | 'loadDownloads'>;
}

/** Owns downloadActions behaviour; cross-domain work enters through explicit ports. */
export function createDownloadActions(ports: DownloadActionsPorts, lifetime: RuntimeLifetime) {
  const domainActions = {
    async downloadTrack(track: Track, source = 'library'): Promise<void> {
      const isCurrent = lifetime.capture();
      if (track.source !== 'preview') return;
      // Exclude podcast episodes (handled by downloadEpisode).
      if (isPodcastTrack(track)) return;
      const alreadySaved = state.library.some(t => t.youtube_id === track.id || t.id === track.id);
      if (alreadySaved) {
        toast.info(tr('toast.alreadyInLibrary'));
        return;
      }
      const alreadyDownloading = state.downloads.queue.some(i => i.video_id === track.id && i.status !== 'failed' && i.status !== 'interrupted');
      if (alreadyDownloading) {
        toast.info(tr('toast.alreadyInDownloadsQueue'));
        return;
      }
      const t = toast.loading(tr('toast.addingDownloads'));
      try {
        await api.enqueueDownload([{
          source_type: 'youtube_url',
          song_str: `https://www.youtube.com/watch?v=${track.id}`,
          video_id: track.id,
          display_title: track.title,
          display_artist: track.artist,
          thumbnail_url: track.cover,
          duration_sec: track.duration,
          metadata_evidence: null,
          // Everything this song answers to, including the saved entry it was
          // opened from: the file joins that song instead of arriving as new.
          identity_keys: trackKeys(track)
        }]);
        if (!isCurrent()) {
          return;
        }
        void ports.actions.loadDownloads();
        void api.emitDiscoveryEvent('music_added_to_queue', {
          title: track.title,
          artist: track.artist,
          source,
          youtube_id: track.id
        }).catch(lifetime.guard(() => {}));
        t.update('success', tr('toast.addedToDownloads'));
      } catch {
        if (!isCurrent()) {
          return;
        }
        t.update('error', tr('toast.addToDownloadsFailed'));
      }
    },
    async downloadSaved(entry: SavedEntry, source = 'library'): Promise<void> {
      const isCurrent = lifetime.capture();
      const preview = (videoId: string): Track => ({
        id: videoId,
        title: entry.title ?? '',
        artist: entry.artist ?? '',
        album: entry.album,
        duration: entry.duration,
        cover: entry.thumbnail,
        source: 'preview',
        // The entry's own identity rides along with the download, so the file
        // lands as this saved song even before the entry has learned its video.
        originKeys: entry.keys
      });
      const known = savedVideoId(entry);
      if (known) {
        await ports.actions.downloadTrack(preview(known), source);
        if (!isCurrent()) {
          return;
        }
        return;
      }
      if (!entry.title || !entry.artist) {
        toast.error(tr('search.noPreview'));
        return;
      }
      const t = toast.loading(tr('collection.resolving'));
      try {
        const resolved = await api.resolveCatalogItem({
          artist: entry.artist,
          title: entry.title,
          duration: entry.duration
        });
        if (!isCurrent()) {
          return;
        }
        if (!resolved.video_id) throw new Error('not-found');
        t.dismiss();
        await ports.actions.downloadTrack(preview(resolved.video_id), source);
        if (!isCurrent()) {
          return;
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        t.update('error', tr('search.noPreview'));
      }
    },
    async loadDownloads(): Promise<boolean> {
      const isCurrent = lifetime.capture();
      try {
        const d = await api.getDownloadQueue();
        if (!isCurrent()) {
          return false;
        }
        setState('downloads', {
          queue: d.queue ?? [],
          isProcessing: !!d.is_processing
        });
        return true;
      } catch {
        if (!isCurrent()) {
          return false;
        }

        // Engine down or unauthorized — leave whatever we have.
        return false;
      }
    },
    async retryDownload(id: string): Promise<void> {
      const isCurrent = lifetime.capture();
      try {
        await api.retryDownload(id);
        if (!isCurrent()) {
          return;
        }
        await ports.actions.loadDownloads();
        if (!isCurrent()) {
          return;
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        toast.error(tr('toast.downloadOperationFailed'));
        void ports.actions.loadDownloads();
      }
    },
    async removeDownload(id: string): Promise<void> {
      const isCurrent = lifetime.capture();
      try {
        await api.removeDownload(id);
        if (!isCurrent()) {
          return;
        }
        setState('downloads', 'queue', q => q.filter(i => i.id !== id));
      } catch {
        if (!isCurrent()) {
          return;
        }
        toast.error(tr('toast.downloadOperationFailed'));
        void ports.actions.loadDownloads();
      }
    },
    async clearFailedDownloads(): Promise<void> {
      const isCurrent = lifetime.capture();
      try {
        await api.clearFailedDownloads();
        if (!isCurrent()) {
          return;
        }
        await ports.actions.loadDownloads();
        if (!isCurrent()) {
          return;
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        toast.error(tr('toast.downloadOperationFailed'));
        void ports.actions.loadDownloads();
      }
    },
    async clearDownloads(): Promise<void> {
      const isCurrent = lifetime.capture();
      try {
        await api.clearDownloads();
        if (!isCurrent()) {
          return;
        }
        await ports.actions.loadDownloads();
        if (!isCurrent()) {
          return;
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        toast.error(tr('toast.downloadOperationFailed'));
        void ports.actions.loadDownloads();
      }
    }
  };
  return {
    actions: domainActions
  };
}
