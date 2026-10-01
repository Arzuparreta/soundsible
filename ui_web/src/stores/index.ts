import { resetAccountState } from './core';
import { invalidateLibrarySync } from './library';
import { clearDownloadTimers } from './downloads';
import { resetSavedEntities } from '../lib/savedEntities';
import { audioService, disposeAudio } from '../lib/audio';
import { RuntimeLifetime } from '../lib/runtimeLifetime';
import { createTransport } from './transport';
import { createDj } from './dj';
import { createQueue } from './queue';
import { createSession } from './session';
import { createPodcasts } from './podcasts';
import { createPlaylists } from './playlists';
import { createRuntime } from './runtime';
import { createCollection } from './collection';
import { createDownloadActions } from './downloadActions';
import { preferenceActions } from './preferences';
import type { PlayerActions } from './contracts';
import { visualPreferenceActions } from './visualPreferences';
export * from './core';
export * from './identity';
export { beginLibraryEdit, endLibraryEdit, invalidateLibrarySync, syncLibrary, syncLibrarySoon } from './library';
export { addRecentCompleted, applyDownloadEvent, downloadCounts } from './downloads';
function createClient() {
  const lifetime = new RuntimeLifetime();
  const transport = createTransport({
    get releasePreparation() {
      return queue.releasePreparation;
    },
    get updateMediaSession() {
      return session.updateMediaSession;
    },
    get matchContextEntry() {
      return queue.matchContextEntry;
    },
    get podcastProgressOwner() {
      return podcasts.podcastProgressOwner;
    },
    set podcastProgressOwner(value) {
      podcasts.podcastProgressOwner = value;
    },
    get podcastSourcePending() {
      return podcasts.podcastSourcePending;
    },
    set podcastSourcePending(value) {
      podcasts.podcastSourcePending = value;
    },
    get stagedEntry() {
      return queue.stagedEntry;
    },
    set stagedEntry(value) {
      queue.stagedEntry = value;
    },
    get currentPreparation() {
      return queue.currentPreparation;
    },
    get podcastProgress() {
      return podcasts.podcastProgress;
    },
    get prefetchUpcoming() {
      return queue.prefetchUpcoming;
    },
    get ensureAutoplay() {
      return dj.ensureAutoplay;
    },
    get generatedQueue() {
      return dj.generatedQueue;
    },
    set generatedQueue(value) {
      dj.generatedQueue = value;
    },
    get savePodcastProgress() {
      return podcasts.savePodcastProgress;
    },
    get actions() {
      return actions;
    },
    get pushEmptyPlaybackState() {
      return session.pushEmptyPlaybackState;
    },
    get boundaryFacts() {
      return dj.boundaryFacts;
    },
    get playingDuration() {
      return dj.playingDuration;
    },
    get PREMATURE_END_SECONDS() {
      return dj.PREMATURE_END_SECONDS;
    },
    get promotePreparedAutoSuccessor() {
      return dj.promotePreparedAutoSuccessor;
    },
    get nextEntry() {
      return queue.nextEntry;
    },
    get enterStarved() {
      return dj.enterStarved;
    },
    get resumeFromStarved() {
      return dj.resumeFromStarved;
    },
    get discardFutureAutoplay() {
      return queue.discardFutureAutoplay;
    },
    get cancelPendingRadio() {
      return queue.cancelPendingRadio;
    },
    get confirmNormalMode() {
      return dj.confirmNormalMode;
    },
    get mixAutoTrackNow() {
      return dj.mixAutoTrackNow;
    },
    get abandonContextMatches() {
      return queue.abandonContextMatches;
    },
    get ensureGeneratedQueue() {
      return dj.ensureGeneratedQueue;
    },
    get commitSeq() {
      return dj.commitSeq;
    },
    set commitSeq(value) {
      dj.commitSeq = value;
    },
    get committedTransition() {
      return dj.committedTransition;
    },
    set committedTransition(value) {
      dj.committedTransition = value;
    },
    get repeatCycle() {
      return queue.repeatCycle;
    },
    get pushPlaybackState() {
      return session.pushPlaybackState;
    }
  }, lifetime);
  const dj = createDj({
    get createPlaybackAttempt() {
      return transport.createPlaybackAttempt;
    },
    get beginLoad() {
      return transport.beginLoad;
    },
    get trackUrl() {
      return transport.trackUrl;
    },
    get listeningLearning() {
      return transport.listeningLearning;
    },
    get concludeAttempt() {
      return transport.concludeAttempt;
    },
    get activeAttempt() {
      return transport.activeAttempt;
    },
    set activeAttempt(value) {
      transport.activeAttempt = value;
    },
    get currentPreparation() {
      return queue.currentPreparation;
    },
    get prefetchUpcoming() {
      return queue.prefetchUpcoming;
    },
    get updateMediaSession() {
      return session.updateMediaSession;
    },
    get pushPlaybackState() {
      return session.pushPlaybackState;
    },
    get stagedEntry() {
      return queue.stagedEntry;
    },
    set stagedEntry(value) {
      queue.stagedEntry = value;
    },
    get actions() {
      return actions;
    },
    get levelFor() {
      return transport.levelFor;
    },
    get trackPrepared() {
      return transport.trackPrepared;
    },
    get discardFutureAutoplay() {
      return queue.discardFutureAutoplay;
    },
    get cancelPendingRadio() {
      return queue.cancelPendingRadio;
    },
    get loadIndex() {
      return transport.loadIndex;
    },
    get updateUpcomingPreparation() {
      return queue.updateUpcomingPreparation;
    },
    get emitPlaybackEvent() {
      return transport.emitPlaybackEvent;
    },
    get stageNext() {
      return queue.stageNext;
    },
    get nextEntry() {
      return queue.nextEntry;
    },
    get previewLookahead() {
      return queue.previewLookahead;
    },
    get runWhenAudible() {
      return transport.runWhenAudible;
    },
    set runWhenAudible(value) {
      transport.runWhenAudible = value;
    },
    get abandonContextMatches() {
      return queue.abandonContextMatches;
    }
  }, lifetime);
  const queue = createQueue({
    get onPreviewPreparation() {
      return dj.onPreviewPreparation;
    },
    get runWhenAudible() {
      return transport.runWhenAudible;
    },
    set runWhenAudible(value) {
      transport.runWhenAudible = value;
    },
    get trackPrepared() {
      return transport.trackPrepared;
    },
    get trackUrl() {
      return transport.trackUrl;
    },
    get levelFor() {
      return transport.levelFor;
    },
    get generatedQueue() {
      return dj.generatedQueue;
    },
    set generatedQueue(value) {
      dj.generatedQueue = value;
    },
    get actions() {
      return actions;
    },
    get emitPlaybackEvent() {
      return transport.emitPlaybackEvent;
    },
    get ensureAutoplay() {
      return dj.ensureAutoplay;
    },
    get resumeFromStarved() {
      return dj.resumeFromStarved;
    },
    get insertionFloor() {
      return dj.insertionFloor;
    },
    get cancelActiveAttempt() {
      return transport.cancelActiveAttempt;
    },
    get loadIndex() {
      return transport.loadIndex;
    }
  }, lifetime);
  const session = createSession({
    get releasePreparation() {
      return queue.releasePreparation;
    },
    get runWhenAudible() {
      return transport.runWhenAudible;
    },
    set runWhenAudible(value) {
      transport.runWhenAudible = value;
    },
    get cancelActiveAttempt() {
      return transport.cancelActiveAttempt;
    },
    get unmatchedSelection() {
      return transport.unmatchedSelection;
    },
    set unmatchedSelection(value) {
      transport.unmatchedSelection = value;
    },
    get abandonContextMatches() {
      return queue.abandonContextMatches;
    },
    get actions() {
      return actions;
    },
    get generatedQueue() {
      return dj.generatedQueue;
    },
    set generatedQueue(value) {
      dj.generatedQueue = value;
    },
    get stagedEntry() {
      return queue.stagedEntry;
    },
    set stagedEntry(value) {
      queue.stagedEntry = value;
    },
    get autoSessionEpoch() {
      return dj.autoSessionEpoch;
    },
    set autoSessionEpoch(value) {
      dj.autoSessionEpoch = value;
    },
    get autoPlaybackPrefs() {
      return dj.autoPlaybackPrefs;
    },
    set autoPlaybackPrefs(value) {
      dj.autoPlaybackPrefs = value;
    },
    get userPlaybackStartedThisSession() {
      return transport.userPlaybackStartedThisSession;
    },
    set userPlaybackStartedThisSession(value) {
      transport.userPlaybackStartedThisSession = value;
    },
    get ensureGeneratedQueue() {
      return dj.ensureGeneratedQueue;
    },
    get loadIndex() {
      return transport.loadIndex;
    },
    get podcastProgressOwner() {
      return podcasts.podcastProgressOwner;
    },
    set podcastProgressOwner(value) {
      podcasts.podcastProgressOwner = value;
    },
    get trackUrl() {
      return transport.trackUrl;
    },
    get levelFor() {
      return transport.levelFor;
    }
  }, lifetime);
  const podcasts = createPodcasts({
    get activeAttempt() {
      return transport.activeAttempt;
    },
    set activeAttempt(value) {
      transport.activeAttempt = value;
    },
    get confirmNormalMode() {
      return dj.confirmNormalMode;
    },
    get actions() {
      return actions;
    },
    get discardFutureAutoplay() {
      return queue.discardFutureAutoplay;
    },
    get cancelPendingRadio() {
      return queue.cancelPendingRadio;
    },
    get userPlaybackStartedThisSession() {
      return transport.userPlaybackStartedThisSession;
    },
    set userPlaybackStartedThisSession(value) {
      transport.userPlaybackStartedThisSession = value;
    },
    get beginLoad() {
      return transport.beginLoad;
    },
    get releasePreparation() {
      return queue.releasePreparation;
    },
    get runWhenAudible() {
      return transport.runWhenAudible;
    },
    set runWhenAudible(value) {
      transport.runWhenAudible = value;
    },
    get createPlaybackAttempt() {
      return transport.createPlaybackAttempt;
    },
    get updateMediaSession() {
      return session.updateMediaSession;
    },
    get loadGeneration() {
      return transport.loadGeneration;
    },
    set loadGeneration(value) {
      transport.loadGeneration = value;
    },
    get onPlaybackFailed() {
      return transport.onPlaybackFailed;
    }
  }, lifetime);
  const playlists = createPlaylists({
    get actions() {
      return actions;
    }
  }, lifetime);
  const runtime = createRuntime({
    get RESUME_HANDOFF_ATTEMPTS() {
      return session.RESUME_HANDOFF_ATTEMPTS;
    },
    get RESUME_SEARCH_ATTEMPTS() {
      return session.RESUME_SEARCH_ATTEMPTS;
    },
    get emitPlaybackEvent() {
      return transport.emitPlaybackEvent;
    },
    get updateMediaSession() {
      return session.updateMediaSession;
    },
    get programMediaSession() {
      return session.programMediaSession;
    },
    get ensureAutoplay() {
      return dj.ensureAutoplay;
    },
    get discardFutureAutoplay() {
      return queue.discardFutureAutoplay;
    },
    get applyVolumeLeveling() {
      return transport.applyVolumeLeveling;
    },
    get applyDjMixing() {
      return transport.applyDjMixing;
    },
    get clearStallTimer() {
      return transport.clearStallTimer;
    },
    get cancelActiveAttempt() {
      return transport.cancelActiveAttempt;
    },
    get pushPlaybackState() {
      return session.pushPlaybackState;
    },
    get unmatchedSelection() {
      return transport.unmatchedSelection;
    },
    set unmatchedSelection(value) {
      transport.unmatchedSelection = value;
    },
    get beginLoad() {
      return transport.beginLoad;
    },
    get onEnded() {
      return transport.onEnded;
    },
    get activeAttempt() {
      return transport.activeAttempt;
    },
    set activeAttempt(value) {
      transport.activeAttempt = value;
    },
    get onPlaybackFailed() {
      return transport.onPlaybackFailed;
    },
    get loadGeneration() {
      return transport.loadGeneration;
    },
    set loadGeneration(value) {
      transport.loadGeneration = value;
    },
    get scheduleStallRecovery() {
      return transport.scheduleStallRecovery;
    },
    get STARTUP_RECOVERY_MS() {
      return transport.STARTUP_RECOVERY_MS;
    },
    get STALL_RECOVERY_MS() {
      return transport.STALL_RECOVERY_MS;
    },
    get rememberDjExploration() {
      return dj.rememberDjExploration;
    },
    get consecutiveLoadFailures() {
      return transport.consecutiveLoadFailures;
    },
    set consecutiveLoadFailures(value) {
      transport.consecutiveLoadFailures = value;
    },
    get flushWhenAudible() {
      return transport.flushWhenAudible;
    },
    get stageNext() {
      return queue.stageNext;
    },
    get emitAttempt() {
      return transport.emitAttempt;
    },
    get podcastProgressSavedAt() {
      return podcasts.podcastProgressSavedAt;
    },
    set podcastProgressSavedAt(value) {
      podcasts.podcastProgressSavedAt = value;
    },
    get savePodcastProgress() {
      return podcasts.savePodcastProgress;
    },
    get listeningLearning() {
      return transport.listeningLearning;
    },
    get evaluateDjRunway() {
      return dj.evaluateDjRunway;
    },
    get watchRunway() {
      return dj.watchRunway;
    },
    get updatePositionState() {
      return session.updatePositionState;
    },
    get revalidatePreparation() {
      return queue.revalidatePreparation;
    },
    get resumeFromStarved() {
      return dj.resumeFromStarved;
    },
    get actions() {
      return actions;
    },
    get osSeekStep() {
      return session.osSeekStep;
    },
    get loudnessAsked() {
      return transport.loudnessAsked;
    },
    get sessionFor() {
      return session.sessionFor;
    },
    get playRestoredSession() {
      return session.playRestoredSession;
    },
    get sessionOutOfDate() {
      return session.sessionOutOfDate;
    },
    get playbackStateBody() {
      return session.playbackStateBody;
    },
    get livePosition() {
      return session.livePosition;
    },
    get searchForResume() {
      return session.searchForResume;
    }
  }, lifetime);
  const collection = createCollection({
    get actions() {
      return actions;
    },
    get removeTrackReferences() {
      return transport.removeTrackReferences;
    },
    get restorePlaybackSnapshot() {
      return transport.restorePlaybackSnapshot;
    }
  }, lifetime);
  const downloadActions = createDownloadActions({
    get actions() {
      return actions;
    }
  }, lifetime);
  const actions: PlayerActions = {
    ...transport.actions,
    ...dj.actions,
    ...queue.actions,
    ...session.actions,
    ...podcasts.actions,
    ...playlists.actions,
    ...runtime.actions,
    ...collection.actions,
    ...downloadActions.actions,
    ...preferenceActions,
    ...visualPreferenceActions
  };
  return {
    actions,
    initStore: runtime.initStore,
    dispose() {
      lifetime.close();
      transport.dispose();
      dj.dispose();
      queue.dispose();
      invalidateLibrarySync();
      clearDownloadTimers();
      resetSavedEntities();
      audioService.stop();
      disposeAudio();
    }
  };
}
let client = createClient();
let disposed = false;
export let actions: PlayerActions = client.actions;
export function initStore(): void {
  if (disposed) {
    client = createClient();
    actions = client.actions;
    disposed = false;
  }
  client.initStore();
}
export function disposeStore(): void {
  if (disposed) return;
  disposed = true;
  client.dispose();
  resetAccountState();
}
if (import.meta.hot) import.meta.hot.dispose(disposeStore);
export { applyTheme, systemPrefersDark, resolveTheme, announceTheme } from './theme';
