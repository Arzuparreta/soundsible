import { diagnosticPause, diagnosticPlay, diagnosticSource, observeDiagnosticMedia } from '../playbackDiagnostics';

export type ProgramOutputMode = 'carrier' | 'direct_fallback';

export type ProgramOutputEventName =
  | 'carrier_attached'
  | 'carrier_playing'
  | 'carrier_paused'
  | 'carrier_error'
  | 'fallback_entered'
  | 'fallback_recovered';

export interface ProgramOutputSnapshot {
  mode: ProgramOutputMode;
  carrierPaused: boolean;
  carrierReadyState: number;
  carrierPlaying: boolean;
  contextState: AudioContextState;
}

export interface ProgramOutputEvent extends ProgramOutputSnapshot {
  event: ProgramOutputEventName;
  reason?: string;
}

type OutputListener = (event: ProgramOutputEvent) => void;

/**
 * Stable media element carrying Soundsible's mixed output.
 *
 * Source decks remain HTML media elements because they provide progressive
 * network decoding and feed Web Audio. The carrier stays the same object for
 * the graph lifetime, but WebKit may still select a source deck for Now Playing.
 * Stable audio routing does not establish ownership of the platform controls.
 */
export class ProgramOutput {
  private carrier: HTMLAudioElement | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private mode: ProgramOutputMode = 'direct_fallback';
  private directConnected = false;
  private listeners = new Set<OutputListener>();
  private stopObserving: (() => void) | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly monitor: AudioNode,
  ) {}

  initialize(): ProgramOutputMode {
    try {
      if (typeof this.context.createMediaStreamDestination !== 'function') {
        throw new Error('media_stream_destination_unavailable');
      }
      const destination = this.context.createMediaStreamDestination();
      const carrier = new Audio();
      this.stopObserving = observeDiagnosticMedia(carrier, 'carrier');
      carrier.preload = 'auto';
      diagnosticSource(carrier, () => { carrier.srcObject = destination.stream; });
      carrier.addEventListener('playing', () => this.emit('carrier_playing'));
      carrier.addEventListener('pause', () => this.emit('carrier_paused'));
      carrier.addEventListener('error', () => {
        this.emit('carrier_error', mediaErrorReason(carrier.error));
        this.enterFallback('carrier_media_error');
      });
      this.monitor.connect(destination);
      this.destination = destination;
      this.carrier = carrier;
      this.mode = 'carrier';
      this.emit('carrier_attached');
    } catch (error) {
      this.enterFallback(errorReason(error));
    }
    return this.mode;
  }

  subscribe(listener: OutputListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ProgramOutputSnapshot {
    const carrier = this.carrier;
    return {
      mode: this.mode,
      carrierPaused: carrier?.paused ?? true,
      carrierReadyState: carrier?.readyState ?? 0,
      carrierPlaying: this.mode === 'carrier' && Boolean(carrier && !carrier.paused && !carrier.ended),
      contextState: this.context.state,
    };
  }

  /** Start the stable device output. A carrier failure never costs the song. */
  async play(): Promise<void> {
    if (this.mode !== 'carrier' || !this.carrier) return;
    try {
      await diagnosticPlay(this.carrier);
    } catch (error) {
      this.emit('carrier_error', errorReason(error));
      this.enterFallback(errorReason(error));
    }
  }

  pause(): void {
    if (this.carrier) diagnosticPause(this.carrier);
  }

  /**
   * Retry only from a real page gesture. Direct output remains connected until
   * the carrier has accepted play, avoiding a silent optimistic switch.
   */
  async retryFromGesture(programPlaying: boolean): Promise<boolean> {
    if (this.mode !== 'direct_fallback' || !this.carrier || !this.destination) return false;
    if (!programPlaying) return false;
    try {
      await diagnosticPlay(this.carrier);
      if (this.directConnected) {
        try {
          this.monitor.disconnect(this.context.destination);
        } catch {
          /* already disconnected */
        }
        this.directConnected = false;
      }
      this.mode = 'carrier';
      this.emit('fallback_recovered');
      return true;
    } catch {
      return false;
    }
  }

  destroy(): void {
    const carrier = this.carrier;
    if (carrier) {
      diagnosticPause(carrier);
      diagnosticSource(carrier, () => { carrier.srcObject = null; });
    }
    for (const track of this.destination?.stream.getTracks() ?? []) track.stop();
    this.listeners.clear();
    this.carrier = null;
    this.stopObserving?.();
    this.stopObserving = null;
    this.destination = null;
  }

  private enterFallback(reason: string): void {
    if (!this.directConnected) {
      this.monitor.connect(this.context.destination);
      this.directConnected = true;
    }
    const changed = this.mode !== 'direct_fallback';
    this.mode = 'direct_fallback';
    if (changed || reason) this.emit('fallback_entered', reason);
  }

  private emit(event: ProgramOutputEventName, reason?: string): void {
    const payload = { event, reason, ...this.snapshot() };
    for (const listener of this.listeners) listener(payload);
  }
}

function errorReason(error: unknown): string {
  if (error instanceof DOMException && error.name) return error.name.slice(0, 64);
  if (error instanceof Error && error.message) return error.message.slice(0, 64);
  return 'unknown';
}

function mediaErrorReason(error: MediaError | null): string {
  return error ? `media_error_${error.code}` : 'media_error';
}
