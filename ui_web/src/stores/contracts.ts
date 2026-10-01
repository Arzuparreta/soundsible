

import { type DjDirection, type DjProfile, type LibraryScanStatus } from "../lib/api";
import { type ProgramTransportOrigin } from "../lib/audio";

import { type AutoActivity, type AutoProfile } from "../lib/generatedQueue";

import { type ContextTrack, type PlaybackContextDescriptor } from "../lib/playbackQueue";
import { type PlaybackSessionSnapshot } from "../lib/playbackSession";

import type { Track, SavedEntry } from "../types/music";
import type { PodcastShowInfo, PodcastEpisode } from "../types/podcast";

import { type InterfaceSize } from "../lib/visualPreferences";

import { type Theme } from "./core";

export type PlaybackTrigger = 'selection' | 'next' | 'ended' | 'retry' | 'resume' | 'recovery' | 'podcast' | 'handoff';

export type PlaybackSourceKind = 'local' | 'preview' | 'podcast';

export interface PlaybackAttempt {
  id: string;
  trackId: string;
  sourceKind: PlaybackSourceKind;
  trigger: PlaybackTrigger;
  queueLane: string;
  startedAt: number;
  loadedMetadataAt: number | null;
  canPlayAt: number | null;
  audibleAt: number | null;
  /** When the current buffering spell began, or null between spells. */
  bufferStartedAt: number | null;
  /**
   * Buffering before the first sound, and buffering after it, kept apart.
   *
   * They used to be one counter reported on `ui_click_to_playing`, which fires at
   * the moment of first sound — so the only spell it could ever contain was the
   * opening one, which every cold start has. It read 1 on 56 of 58 plays before
   * the chunk change and 8 of 9 after, and a metric that cannot move is not
   * measuring anything. The opening wait is already `click_to_playing_ms`; what
   * `rebuffer` counts is playback that was running and stopped, which is the only
   * one of the two that means delivery failed.
   */
  startupStallMs: number;
  rebufferCount: number;
  rebufferMs: number;
  /**
   * Rebuffers that follow a seek the listener asked for.
   *
   * Dragging the scrubber into un-buffered audio stops the sound, and the element
   * reports that the same way it reports a stream that died. One is the listener
   * getting what they asked for and the other is a fault, so they are counted
   * apart rather than summed into a number that flatters or damns the change
   * depending on how much anyone scrubbed that day.
   */
  seekRebufferCount: number;
  seekPending: boolean;
  /** Times this attempt's stall timer found the deck still fetching and waited
   * again instead of reloading it. See `scheduleStallRecovery`. */
  stallReprieves: number;
  /** Last server spool position observed by startup supervision. */
  spoolBytes: number;
  recoveryCount: number;
  reportedRecoveryCount: number;
  concluded: boolean;
  generation: number;
}

export type ContextMatchOutcome = 'resolved' | 'unavailable' | 'gone';

export type LoadOptions = { restart?: boolean; trigger?: PlaybackTrigger; freshDeck?: boolean };

export interface CommittedTransition {
  queueId: string;
  fromKey: string;
  toKey: string;
}

export type PublishedPlaybackState = { track_id: string | null; track: Track | null; position_sec: number; is_playing: boolean; device_id: string; device_name: string; device_type: string; session?: PlaybackSessionSnapshot | null };

export interface PlayerActions {
  syncLibrary: () => Promise<void>;
  syncLibrarySoon: () => void;
  linkCatalogItem: (itemId: string, videoId: string) => void;
  toggleSaved: (entry: SavedEntry) => void;
  setSongsSaved: (entries: SavedEntry[], saved: boolean) => Promise<boolean>;
  toggleSavedTrack: (track: Track) => void;
  toggleFavourite: (entry: SavedEntry) => void;
  toggleFavouriteTrack: (track: Track) => void;
  enterAutoMode: (options?: { source: Track; deferPlanning: boolean }) => void;
  exitAutoMode: () => void;
  addAutoSource: (tracks: Track[], label: string) => void;
  beginAutoSessionChange: () => number;
  startDjFromTrack: (track: Track) => Promise<boolean>;
  changeAutoSession: (tracks: Track[], label: string) => Promise<boolean>;
  retryAutoRoute: () => void;
  useAutoTrackAsSource: (track: Track) => void;
  removeAutoSource: (id: string) => void;
  removeAutoRouteOccurrence: (queueId: string) => void;
  avoidAutoTrackForSession: (queueId: string) => void;
  setAutoProfile: (profile: AutoProfile) => void;
  setAutoDjProfile: (profile: DjProfile) => void;
  setAutoDirection: (direction: Partial<DjDirection>, note?: string) => void;
  reportAutoActivity: (key: string, status: AutoActivity['status'], values?: Record<string, string | number>) => void;
  autoSessionToken: () => number;
  placeAutoTracks: (tracks: Track[], beforeQueueId?: string, requestGroup?: string) => Promise<void>;
  placeAutoTrack: (track: Track, beforeQueueId?: string, requestGroup?: string) => Promise<void>;
  repairAutoRoute: () => Promise<void>;
  autoSkip: () => Promise<void>;
  playFrom: (tracks: ContextTrack[], i: number, opts?: {
      radio?: boolean;
      context?: PlaybackContextDescriptor;
      shuffled?: boolean;
      preserveManual?: boolean;
    }) => void;
  playTrack: (track: Track) => void;
  playShuffled: (tracks: Track[], context?: PlaybackContextDescriptor) => void;
  playEpisode: (ep: PodcastEpisode, showTitle?: string, feedId?: string, showImage?: string | null) => Promise<void>;
  downloadEpisode: (ep: PodcastEpisode, sub: PodcastShowInfo | null) => Promise<void>;
  togglePlay: () => void;
  resumePlayback: (origin?: ProgramTransportOrigin) => void;
  pausePlayback: (origin?: ProgramTransportOrigin) => void;
  dismissPlayback: () => void;
  retryCurrent: () => void;
  next: (trigger?: PlaybackTrigger) => void;
  prev: () => void;
  seekBy: (delta: number) => void;
  seek: (t: number) => void;
  jumpTo: (i: number) => void;
  enqueue: (track: Track) => void;
  playNow: (track: Track) => void;
  playNext: (track: Track) => void;
  removeFromQueue: (i: number) => void;
  moveInQueue: (from: number, to: number) => void;
  promoteInAutoRoute: (queueId: string) => void;
  moveAutoRoute: (queueId: string, beforeQueueId?: string) => void;
  clearManualQueue: () => void;
  clearQueue: () => void;
  removeContext: () => void;
  removeQueueEntry: (queueId: string) => void;
  playQueueEntry: (queueId: string) => void;
  startRadio: (seed: Track) => Promise<void>;
  stopRadio: () => void;
  deleteTrack: (id: string) => Promise<void>;
  updateTrackMetadata: (id: string, meta: { title?: string; artist?: string; album?: string; album_artist?: string | null }) => Promise<boolean>;
  uploadTrackCover: (id: string, file: File) => Promise<void>;
  clearTrackCover: (id: string) => Promise<void>;
  toggleShuffle: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  cycleRepeat: () => void;
  setAutoplayEnabled: (enabled: boolean) => Promise<boolean>;
  setVolumeLeveling: (enabled: boolean) => Promise<boolean>;
  setDjMixing: (enabled: boolean) => Promise<boolean>;
  downloadTrack: (track: Track, source?: string) => Promise<void>;
  downloadSaved: (entry: SavedEntry, source?: string) => Promise<void>;
  loadDownloads: () => Promise<boolean>;
  retryDownload: (id: string) => Promise<void>;
  removeDownload: (id: string) => Promise<void>;
  clearFailedDownloads: () => Promise<void>;
  clearDownloads: () => Promise<void>;
  rescanLibrary: () => Promise<LibraryScanStatus>;
  createPlaylist: (name: string) => Promise<boolean>;
  deletePlaylist: (name: string) => Promise<boolean>;
  renamePlaylist: (name: string, newName: string) => Promise<boolean>;
  duplicatePlaylist: (name: string) => Promise<void>;
  addToPlaylist: (name: string, track: Track) => Promise<void>;
  removeFromPlaylist: (name: string, trackId: string) => Promise<void>;
  reorderPlaylistTracks: (name: string, ids: string[]) => Promise<boolean>;
  reorderPlaylists: (order: string[]) => Promise<void>;
  setPlaylistCover: (name: string, coverTrackId: string | null) => Promise<void>;
  setDeviceName: (name: string) => void;
  setTheme: (theme: Theme) => void;
  setInterfaceSize: (interfaceSize: InterfaceSize) => void;
  setHighContrast: (highContrast: boolean) => void;
  setHaptics: (on: boolean) => void;
  checkResume: () => Promise<void>;
  resumeHere: () => void;
  publishSession: () => void;
  dismissResume: () => void;
}
