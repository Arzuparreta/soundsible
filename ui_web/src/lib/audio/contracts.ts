import { type ProgramOutputMode } from "./programOutput";
export interface DeckEffects {
  low?: BiquadFilterNode;
  filter?: BiquadFilterNode;
  /** Where the echo send taps the deck, kept so it can be built on demand. */
  source?: MediaElementAudioSourceNode;
  /** This deck's levelling gain. The echo send taps it rather than `source`,
   * so an echo tail is levelled like the programme it came from. */
  level?: GainNode;
  delay?: DelayNode;
  echoWet?: GainNode;
  echoFeedback?: GainNode;
}
export type GraphState = 'untested' | 'ready' | 'unavailable';
export type BroadcastCaptureKind = 'program' | 'element';
export interface BroadcastCapture {
  kind: BroadcastCaptureKind;
  stream: MediaStream;
  onTrackChange: (listener: (track: MediaStreamTrack | null) => void) => () => void;
}
export interface DeckBinding {
  type: string;
  handler: (event: Event) => void;
}
export type ProgramMediaEventName = 'outputhealth' | 'sourcesettled' | 'play' | 'pause' | 'ended' | 'error' | 'seeking' | 'waiting' | 'canplay' | 'playing' | 'timeupdate' | 'durationchange' | 'loadedmetadata' | 'seeked' | 'ratechange';
export interface ProgramPlaybackSnapshot {
  outputMode: ProgramOutputMode;
  playing: boolean;
  sourcePlaying: boolean;
  carrierPlaying: boolean;
  position: number;
  duration: number;
  playbackRate: number;
  ended: boolean;
  readyState: number;
  networkState: number;
  mediaErrorCode: number;
  hasSource: boolean;
  bufferedEnd: number;
  activeIndex: number;
  mixPhase: MixPhase;
  dominant: boolean;
  contextState: string;
}
export type OutputHealth = 'healthy' | 'recovering' | 'needs_play';
export interface CapturableAudioElement extends HTMLAudioElement {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
}
export interface ProgramMixSnapshot {
  contextTime: number;
  activeIndex: number;
  phase: MixPhase;
  technique?: LiveTransitionPlan['technique'];
  progress: number;
  dominant: boolean;
  decks: Array<{
    index: number;
    position: number;
    duration: number;
    gain: number;
  }>;
}
export interface LiveTransitionPlan {
  /** `direct` is no mix at all: see `cutOver`. */
  technique: 'long_blend' | 'bass_swap' | 'filter_blend' | 'echo_cut' | 'structural_fade' | 'safe_fade' | 'direct';
  /** Position in the *outgoing* deck at which the blend begins. */
  out_cue: number;
  in_cue: number;
  overlap_seconds: number;
  overlap_bars: number;
  playback_rate: number;
  confidence: number;
  sync?: {
    phase_tolerance_ms?: number;
  };
  automation?: {
    eq?: 'bass_swap' | 'neutral';
    filter?: boolean;
    echo_out?: boolean;
  };
}
export type MixPhase = 'idle' | 'armed' | 'prerolling' | 'crossfading';
export type MixCancelReason = 'superseded' | 'load' | 'seek' | 'stop' | 'exit' | 'failed' | 'transport_pause';
export type ProgramTransportOrigin = 'ui' | 'media_session' | 'platform' | 'recovery' | 'native_shell';
export interface ProgramTransportEvent {
  kind: 'pause' | 'resume' | 'inactive_deck_play';
  origin: ProgramTransportOrigin;
  mixPhase: MixPhase;
  dominant: boolean;
  activeIndex: number;
  hidden: boolean;
  deck0Playing: boolean;
  deck1Playing: boolean;
}
export interface MixCallbacks {
  /** The incoming deck is loaded and cued; the handoff is now committed. */
  onArmed?(): void;
  /** The incoming deck owns playback from this moment. */
  onDominant(): void;
  onComplete(position: number): void;
  onCancel(reason: MixCancelReason): void;
  onError(error: unknown): void;
  /**
   * The blend was given up at a boundary it could not perform — the outgoing
   * song ended, or the listener skipped, before the incoming deck could sound —
   * and the incoming deck is now staged for an ordinary handover (`takeStaged`).
   * Nothing owns playback until the caller takes it.
   */
  onStaged?(): void;
}
export interface ActiveMix {
  phase: Exclude<MixPhase, 'idle'>;
  fromIndex: number;
  toIndex: number;
  /** What the incoming deck was given, so a released blend can stage it. */
  url: string;
  /** Incoming media position at the last look, and when it last moved. A
   * deck that is "playing" but whose clock has stopped is a stalled stream. */
  inPosition: number;
  inProgressAt: number;
  /** The incoming clock has been seen advancing since it was started. */
  inAdvanced: boolean;
  outCue: number;
  inCue: number;
  /** Overlap in wall seconds. */
  overlap: number;
  rate: number;
  preroll: number;
  /** Incoming media position at which the crossfade started. */
  mixStart: number | null;
  technique: LiveTransitionPlan['technique'];
  phaseTolerance: number;
  phaseCorrected: boolean;
  dominant: boolean;
  /** A listener-requested skip: hand over as soon as the blend begins. */
  manual: boolean;
  callbacks: MixCallbacks;
}
export interface AudioService {
  load: (url: string, level: number, positionSec?: number) => Promise<void>;
  recover: (url: string, positionSec: number, level: number) => Promise<void>;
  prime: (url: string, positionSec: number, level: number) => void;
  resume: (origin?: ProgramTransportOrigin) => Promise<void>;
  pause: (origin?: ProgramTransportOrigin, reason?: string) => void;
  stop: () => void;
  seek: (t: number) => void;
  bufferedEnd: () => number;
  setVolume: (v: number) => void;
  getVolume: () => number;
  setMuted: (muted: boolean) => void;
  setLevels: (activeLevel: number, idleLevel: number) => void;
  setLevelingEnabled: (enabled: boolean) => void;
  levelingEnabled: () => boolean;
  unlockAudio: () => boolean;
  graphReady: () => boolean;
  acquireBroadcastCapture: () => BroadcastCapture | null;
  broadcastPlaybackActive: () => boolean;
  broadcastStream: () => MediaStream | null;
  releaseBroadcastStream: () => void;
  programMixSnapshot: () => ProgramMixSnapshot;
  snapshot: () => ProgramPlaybackSnapshot;
  outputHealth: () => OutputHealth;
  stage: (url: string, level: number) => void;
  clearStaged: () => void;
  takeStaged: (url: string, level: number) => Promise<void> | null;
  mixPhase: () => MixPhase;
  mixIsDominant: () => boolean;
  cancelMix: (reason: MixCancelReason) => void;
  startMixNow: (overlapSeconds?: number) => 'finished' | 'blend' | 'staged' | 'failed' | false;
  armTransition: (url: string, plan: LiveTransitionPlan, callbacks: MixCallbacks, options: {
    manual?: boolean;
    level: number;
  }) => void;
}
