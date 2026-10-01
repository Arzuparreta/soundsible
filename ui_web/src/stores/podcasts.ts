import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { PodcastProgress } from "../lib/podcastProgress";
import { user } from "../lib/session";
import { api } from "../lib/api";
import { audioService } from "../lib/audio";
import { type MediaSessionSyncReason } from "../lib/mediaSession";
import { podcastStreamUrl } from "../lib/media";
import { toast } from "../lib/toast";
import { isPodcastTrack, podcastEpisodeToTrack } from "../lib/track";
import { t as tr } from "../lib/i18n";
import { createQueueEntry } from "../lib/playbackQueue";
import type { Track } from "../types/music";
import type { PodcastShowInfo, PodcastEpisode } from "../types/podcast";
import { state, setState } from "./core";
import type { PlayerActions, PlaybackTrigger, PlaybackAttempt } from "./contracts";
export interface PodcastsPorts {
  activeAttempt: PlaybackAttempt | null;
  confirmNormalMode: (kind: 'podcast' | 'radio', proceed: () => void | Promise<void>) => Promise<void>;
  actions: Pick<PlayerActions, 'loadDownloads' | 'playEpisode'>;
  discardFutureAutoplay: () => void;
  cancelPendingRadio: () => void;
  userPlaybackStartedThisSession: boolean;
  beginLoad: () => number;
  releasePreparation: () => void;
  runWhenAudible: (() => void) | null;
  createPlaybackAttempt: (track: Track, generation: number, trigger: PlaybackTrigger, id?: string) => PlaybackAttempt;
  updateMediaSession: (track: Track | null, reason?: MediaSessionSyncReason, forceMetadata?: boolean) => void;
  loadGeneration: number;
  onPlaybackFailed: (generation: number, reason?: string, media?: Record<string, number | boolean>) => void;
}

/** Owns podcasts behaviour; cross-domain work enters through explicit ports. */
export function createPodcasts(ports: PodcastsPorts, lifetime: RuntimeLifetime) {
  const podcastProgress = new PodcastProgress();
  let podcastProgressSavedAt = 0;
  let podcastProgressOwner: string | undefined;
  let podcastSourcePending = false;
  function savePodcastProgress(completed = false, position?: number): void {
    const track = state.playback.currentTrack;
    if (!track || !isPodcastTrack(track) || podcastSourcePending || user()?.id !== podcastProgressOwner) return;
    // A source awaiting metadata must not erase the position it is restoring.
    const snapshot = audioService.snapshot();
    if (position === undefined && snapshot.readyState < 1) return;
    if (position === undefined && ports.activeAttempt && ports.activeAttempt.audibleAt === null && state.playback.isLoading) return;
    podcastProgress.save(track, user()?.id, position ?? snapshot.position, snapshot.duration || state.playback.duration, completed);
    podcastProgressSavedAt = Date.now();
  }
  const domainActions = {
    async playEpisode(ep: PodcastEpisode, showTitle?: string, feedId?: string, showImage?: string | null): Promise<void> {
      const isCurrent = lifetime.capture();
      if (state.autoMode.active) {
        await ports.confirmNormalMode('podcast', () => ports.actions.playEpisode(ep, showTitle, feedId, showImage));
        if (!isCurrent()) {
          return;
        }
        return;
      }
      ports.discardFutureAutoplay();
      ports.cancelPendingRadio();
      const track = podcastEpisodeToTrack(ep, showTitle, feedId, showImage);
      // Tapping the same episode again while its token is still being minted must
      // not mint a second one.
      const pb = state.playback;
      if (pb.currentTrack?.id === track.id && (pb.isLoading || pb.isPlaying)) return;
      ports.userPlaybackStartedThisSession = true;
      const generation = ports.beginLoad();
      podcastProgressOwner = user()?.id;
      podcastSourcePending = true;
      ports.releasePreparation();
      ports.runWhenAudible = null;
      ports.createPlaybackAttempt(track, generation, 'podcast');
      setState('playback', {
        currentTrack: track,
        queue: [createQueueEntry(track, 'context', 'podcast', {
          id: feedId || ep.guid,
          kind: 'podcast',
          label: showTitle || track.artist
        })],
        index: 0,
        isPlaying: true,
        isLoading: true,
        loadError: false,
        phase: 'loading',
        currentTime: 0,
        duration: 0,
        radioMode: false,
        radioLoading: false,
        radioSeedId: null
      });
      ports.updateMediaSession(track);
      try {
        const {
          stream_token
        } = await api.podcastPeek(ep.enclosure_url);
        if (!isCurrent()) {
          return;
        }
        if (generation !== ports.loadGeneration) return;
        if (!stream_token) throw new Error('no token');
        podcastSourcePending = false;
        await audioService.load(podcastStreamUrl(stream_token), 1, podcastProgress.position(track, user()?.id));
        if (!isCurrent()) {
          return;
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        ports.onPlaybackFailed(generation, 'load');
      }
    },
    async downloadEpisode(ep: PodcastEpisode, sub: PodcastShowInfo | null): Promise<void> {
      const isCurrent = lifetime.capture();
      const t = toast.loading(tr('toast.addingDownloads'));
      try {
        await api.enqueuePodcastEpisode({
          enclosure_url: ep.enclosure_url,
          guid: ep.guid,
          title: ep.title,
          show_title: sub?.title,
          // The episode's own art when it has any, else the show's: the engine
          // embeds this into the downloaded file, and a cover missed here is one
          // the library never gets back without a manual edit.
          thumbnail_url: ep.image || sub?.image_url || undefined,
          duration_sec: ep.duration_sec,
          podcast_feed_id: sub?.id,
          podcast_rss_url: sub?.rss_url
        });
        if (!isCurrent()) {
          return;
        }
        void ports.actions.loadDownloads();
        t.update('success', tr('toast.episodeInDownloads'));
      } catch {
        if (!isCurrent()) {
          return;
        }
        t.update('error', tr('toast.downloadFailed'));
      }
    }
  };
  return {
    actions: domainActions,
    get podcastProgressOwner() {
      return podcastProgressOwner;
    },
    set podcastProgressOwner(value: string | undefined) {
      podcastProgressOwner = value;
    },
    get podcastSourcePending() {
      return podcastSourcePending;
    },
    set podcastSourcePending(value: boolean) {
      podcastSourcePending = value;
    },
    get podcastProgress() {
      return podcastProgress;
    },
    savePodcastProgress,
    get podcastProgressSavedAt() {
      return podcastProgressSavedAt;
    },
    set podcastProgressSavedAt(value: number) {
      podcastProgressSavedAt = value;
    }
  };
}
