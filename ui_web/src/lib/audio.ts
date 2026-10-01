import { RuntimeLifetime } from './runtimeLifetime';
import { createTransport } from './audio/transport';
import { createGraph } from './audio/graph';
import { createMixer } from './audio/mixer';
import { createCapture } from './audio/capture';
import type { AudioService } from './audio/contracts';
export type * from './audio/contracts';
export { storedVolume } from './audioPreferences';
import { setDiagnosticSnapshot } from './playbackDiagnostics';
function createAudioRuntime() {
  const lifetime = new RuntimeLifetime();
  const transport = createTransport({
    get setDeckGain() {
      return graph.setDeckGain;
    },
    get mixGains() {
      return graph.mixGains;
    },
    get monitorGain() {
      return graph.monitorGain;
    },
    set monitorGain(value) {
      graph.monitorGain = value;
    },
    get audioContext() {
      return graph.audioContext;
    },
    set audioContext(value) {
      graph.audioContext = value;
    },
    get allMuted() {
      return graph.allMuted;
    },
    set allMuted(value) {
      graph.allMuted = value;
    },
    get applyDeckVolume() {
      return graph.applyDeckVolume;
    },
    get settleEndedEvent() {
      return mixer.settleEndedEvent;
    },
    get setDeckLevel() {
      return graph.setDeckLevel;
    },
    get graphReady() {
      return graph.graphReady;
    },
    get audioService() {
      return audioService;
    },
    get mix() {
      return mixer.mix;
    },
    set mix(value) {
      mixer.mix = value;
    },
    get cancelMix() {
      return mixer.cancelMix;
    },
    get programCarrier() {
      return graph.programCarrier;
    },
    set programCarrier(value) {
      graph.programCarrier = value;
    },
    get primeAudioSession() {
      return graph.primeAudioSession;
    },
    get resumeContext() {
      return graph.resumeContext;
    },
    get tick() {
      return mixer.tick;
    },
    get reportProgramTransport() {
      return mixer.reportProgramTransport;
    },
    get stopRateReturn() {
      return mixer.stopRateReturn;
    }
  }, lifetime);
  const graph = createGraph({
    get elements() {
      return transport.elements;
    },
    set elements(value) {
      transport.elements = value;
    },
    get applyDeckMute() {
      return transport.applyDeckMute;
    },
    get pendingSeeks() {
      return transport.pendingSeeks;
    },
    get decks() {
      return transport.decks;
    },
    get configurePlaybackSession() {
      return transport.configurePlaybackSession;
    },
    get reconcilePlatformPlayback() {
      return transport.reconcilePlatformPlayback;
    },
    get playbackRequested() {
      return transport.playbackRequested;
    },
    set playbackRequested(value) {
      transport.playbackRequested = value;
    },
    get unlockDecks() {
      return transport.unlockDecks;
    },
    get deckIsPlaying() {
      return transport.deckIsPlaying;
    },
    get audioEl() {
      return transport.audioEl;
    },
    get outputRecovering() {
      return transport.outputRecovering;
    },
    set outputRecovering(value) {
      transport.outputRecovering = value;
    },
    get resetClockSample() {
      return transport.resetClockSample;
    },
    get broadcastCapture() {
      return capture.broadcastCapture;
    },
    set broadcastCapture(value) {
      capture.broadcastCapture = value;
    },
    get releaseBroadcastCapture() {
      return capture.releaseBroadcastCapture;
    },
    get broadcastLostReporter() {
      return capture.broadcastLostReporter;
    },
    set broadcastLostReporter(value) {
      capture.broadcastLostReporter = value;
    },
    get VOLUME_KEY() {
      return transport.VOLUME_KEY;
    },
    get activeIndex() {
      return transport.activeIndex;
    },
    set activeIndex(value) {
      transport.activeIndex = value;
    }
  }, lifetime);
  const mixer = createMixer({
    get decks() {
      return transport.decks;
    },
    get mixGains() {
      return graph.mixGains;
    },
    get audioContext() {
      return graph.audioContext;
    },
    set audioContext(value) {
      graph.audioContext = value;
    },
    get activeIndex() {
      return transport.activeIndex;
    },
    set activeIndex(value) {
      transport.activeIndex = value;
    },
    get pageHidden() {
      return transport.pageHidden;
    },
    get deckIsPlaying() {
      return transport.deckIsPlaying;
    },
    get deckGains() {
      return graph.deckGains;
    },
    set deckGains(value) {
      graph.deckGains = value;
    },
    get setBlendLimiter() {
      return graph.setBlendLimiter;
    },
    get scheduleCurve() {
      return graph.scheduleCurve;
    },
    get deckEffects() {
      return graph.deckEffects;
    },
    set deckEffects(value) {
      graph.deckEffects = value;
    },
    get ensureEcho() {
      return graph.ensureEcho;
    },
    get setDeckGain() {
      return graph.setDeckGain;
    },
    get resetDeckEffects() {
      return graph.resetDeckEffects;
    },
    get releaseDeck() {
      return transport.releaseDeck;
    },
    get playProgramDeck() {
      return transport.playProgramDeck;
    },
    get NETWORK_NO_SOURCE() {
      return transport.NETWORK_NO_SOURCE;
    },
    get pauseDeck() {
      return transport.pauseDeck;
    },
    get setDeckParticipation() {
      return transport.setDeckParticipation;
    },
    get stagedUrl() {
      return transport.stagedUrl;
    },
    set stagedUrl(value) {
      transport.stagedUrl = value;
    },
    get notifySourcesSettled() {
      return transport.notifySourcesSettled;
    },
    get outputRecovering() {
      return transport.outputRecovering;
    },
    set outputRecovering(value) {
      transport.outputRecovering = value;
    },
    get playbackRequested() {
      return transport.playbackRequested;
    },
    set playbackRequested(value) {
      transport.playbackRequested = value;
    },
    get resumeContext() {
      return graph.resumeContext;
    },
    get pendingDetach() {
      return transport.pendingDetach;
    },
    get setDeckLevel() {
      return graph.setDeckLevel;
    }
  }, lifetime);
  const capture = createCapture({
    get programPlaybackSnapshot() {
      return transport.programPlaybackSnapshot;
    },
    get programOutput() {
      return graph.programOutput;
    },
    set programOutput(value) {
      graph.programOutput = value;
    },
    get graphReady() {
      return graph.graphReady;
    },
    get audioContext() {
      return graph.audioContext;
    },
    set audioContext(value) {
      graph.audioContext = value;
    },
    get audioEl() {
      return transport.audioEl;
    }
  }, lifetime);
  const audioService: AudioService = {
    ...transport.actions,
    ...graph.actions,
    ...mixer.actions,
    ...capture.actions
  };
  setDiagnosticSnapshot(() => ({
    activeIndex: transport.activeIndex,
    mixPhase: mixer.mix?.phase ?? 'idle',
    dominant: mixer.mix?.dominant ?? false,
    contextState: graph.audioContext?.state ?? 'unavailable',
    contextTime: graph.audioContext?.currentTime ?? 0,
    outputMode: graph.programCarrier?.snapshot().mode ?? 'direct_fallback',
    gain0Target: graph.mixGains[0],
    gain1Target: graph.mixGains[1],
    localVolume: graph.masterVolume,
    localMuted: graph.allMuted
  }));
  return {
    audioService,
    setBroadcastLostReporter: capture.setBroadcastLostReporter,
    setProgramOutputReporter: graph.setProgramOutputReporter,
    onDeckEvent: transport.onDeckEvent,
    audioEl: transport.audioEl,
    isActiveDeck: transport.isActiveDeck,
    onProgramEvent: transport.onProgramEvent,
    unlockAudio: graph.unlockAudio,
    graphReady: graph.graphReady,
    programPlaybackSnapshot: transport.programPlaybackSnapshot,
    broadcastPlaybackActive: capture.broadcastPlaybackActive,
    acquireBroadcastCapture: capture.acquireBroadcastCapture,
    broadcastStream: capture.broadcastStream,
    releaseBroadcastStream: capture.releaseBroadcastStream,
    programMixSnapshot: mixer.programMixSnapshot,
    setProgramTransportReporter: mixer.setProgramTransportReporter,
    isCurrentLoad: transport.isCurrentLoad,
    dispose() {
      lifetime.close();
      mixer.dispose();
      capture.dispose();
      transport.dispose();
      graph.dispose();
    }
  };
}
let runtime = createAudioRuntime();
let disposed = false;
function current() {
  if (disposed) {
    runtime = createAudioRuntime();
    disposed = false;
  }
  return runtime;
}
export const audioService: AudioService = {
  load: (...args) => current().audioService.load(...args),
  recover: (...args) => current().audioService.recover(...args),
  prime: (...args) => current().audioService.prime(...args),
  resume: (...args) => current().audioService.resume(...args),
  pause: (...args) => current().audioService.pause(...args),
  stop: (...args) => current().audioService.stop(...args),
  seek: (...args) => current().audioService.seek(...args),
  bufferedEnd: (...args) => current().audioService.bufferedEnd(...args),
  setVolume: (...args) => current().audioService.setVolume(...args),
  getVolume: (...args) => current().audioService.getVolume(...args),
  setMuted: (...args) => current().audioService.setMuted(...args),
  setLevels: (...args) => current().audioService.setLevels(...args),
  setLevelingEnabled: (...args) => current().audioService.setLevelingEnabled(...args),
  levelingEnabled: (...args) => current().audioService.levelingEnabled(...args),
  unlockAudio: (...args) => current().audioService.unlockAudio(...args),
  graphReady: (...args) => current().audioService.graphReady(...args),
  acquireBroadcastCapture: (...args) => current().audioService.acquireBroadcastCapture(...args),
  broadcastPlaybackActive: (...args) => current().audioService.broadcastPlaybackActive(...args),
  broadcastStream: (...args) => current().audioService.broadcastStream(...args),
  releaseBroadcastStream: (...args) => current().audioService.releaseBroadcastStream(...args),
  programMixSnapshot: (...args) => current().audioService.programMixSnapshot(...args),
  snapshot: (...args) => current().audioService.snapshot(...args),
  outputHealth: (...args) => current().audioService.outputHealth(...args),
  stage: (...args) => current().audioService.stage(...args),
  clearStaged: (...args) => current().audioService.clearStaged(...args),
  takeStaged: (...args) => current().audioService.takeStaged(...args),
  mixPhase: (...args) => current().audioService.mixPhase(...args),
  mixIsDominant: (...args) => current().audioService.mixIsDominant(...args),
  cancelMix: (...args) => current().audioService.cancelMix(...args),
  startMixNow: (...args) => current().audioService.startMixNow(...args),
  armTransition: (...args) => current().audioService.armTransition(...args)
};
export const setBroadcastLostReporter = (...args: Parameters<typeof runtime.setBroadcastLostReporter>): ReturnType<typeof runtime.setBroadcastLostReporter> => current().setBroadcastLostReporter(...args);
export const setProgramOutputReporter = (...args: Parameters<typeof runtime.setProgramOutputReporter>): ReturnType<typeof runtime.setProgramOutputReporter> => current().setProgramOutputReporter(...args);
export const onDeckEvent = (...args: Parameters<typeof runtime.onDeckEvent>): ReturnType<typeof runtime.onDeckEvent> => current().onDeckEvent(...args);
export const audioEl = (...args: Parameters<typeof runtime.audioEl>): ReturnType<typeof runtime.audioEl> => current().audioEl(...args);
export const isActiveDeck = (...args: Parameters<typeof runtime.isActiveDeck>): ReturnType<typeof runtime.isActiveDeck> => current().isActiveDeck(...args);
export const onProgramEvent = (...args: Parameters<typeof runtime.onProgramEvent>): ReturnType<typeof runtime.onProgramEvent> => current().onProgramEvent(...args);
export const unlockAudio = (...args: Parameters<typeof runtime.unlockAudio>): ReturnType<typeof runtime.unlockAudio> => current().unlockAudio(...args);
export const graphReady = (...args: Parameters<typeof runtime.graphReady>): ReturnType<typeof runtime.graphReady> => current().graphReady(...args);
export const programPlaybackSnapshot = (...args: Parameters<typeof runtime.programPlaybackSnapshot>): ReturnType<typeof runtime.programPlaybackSnapshot> => current().programPlaybackSnapshot(...args);
export const broadcastPlaybackActive = (...args: Parameters<typeof runtime.broadcastPlaybackActive>): ReturnType<typeof runtime.broadcastPlaybackActive> => current().broadcastPlaybackActive(...args);
export const acquireBroadcastCapture = (...args: Parameters<typeof runtime.acquireBroadcastCapture>): ReturnType<typeof runtime.acquireBroadcastCapture> => current().acquireBroadcastCapture(...args);
export const broadcastStream = (...args: Parameters<typeof runtime.broadcastStream>): ReturnType<typeof runtime.broadcastStream> => current().broadcastStream(...args);
export const releaseBroadcastStream = (...args: Parameters<typeof runtime.releaseBroadcastStream>): ReturnType<typeof runtime.releaseBroadcastStream> => current().releaseBroadcastStream(...args);
export const programMixSnapshot = (...args: Parameters<typeof runtime.programMixSnapshot>): ReturnType<typeof runtime.programMixSnapshot> => current().programMixSnapshot(...args);
export const setProgramTransportReporter = (...args: Parameters<typeof runtime.setProgramTransportReporter>): ReturnType<typeof runtime.setProgramTransportReporter> => current().setProgramTransportReporter(...args);
export const isCurrentLoad = (...args: Parameters<typeof runtime.isCurrentLoad>): ReturnType<typeof runtime.isCurrentLoad> => current().isCurrentLoad(...args);
export function disposeAudio(): void {
  if (disposed) return;
  runtime.dispose();
  disposed = true;
}
if (import.meta.hot) import.meta.hot.dispose(disposeAudio);
