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
 * The one media element allowed to represent Soundsible's mixed output.
 *
 * Source decks remain HTML media elements because they provide progressive
 * network decoding, but they feed Web Audio only. The carrier owns the device
 * output and stays the same object for the lifetime of the graph, so a deck
 * handoff can no longer look like a pause/play handoff to the platform.
 */
export class ProgramOutput {
  private carrier: HTMLAudioElement | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private mode: ProgramOutputMode = 'direct_fallback';
  private directConnected = false;
  private listeners = new Set<OutputListener>();

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
      carrier.preload = 'auto';
      carrier.srcObject = destination.stream;
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
      await this.carrier.play();
    } catch (error) {
      this.emit('carrier_error', errorReason(error));
      this.enterFallback(errorReason(error));
    }
  }

  pause(): void {
    this.carrier?.pause();
  }

  /**
   * Retry only from a real page gesture. Direct output remains connected until
   * the carrier has accepted play, avoiding a silent optimistic switch.
   */
  async retryFromGesture(programPlaying: boolean): Promise<boolean> {
    if (this.mode !== 'direct_fallback' || !this.carrier || !this.destination) return false;
    if (!programPlaying) return false;
    try {
      await this.carrier.play();
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
    this.carrier?.pause();
    if (this.carrier) this.carrier.srcObject = null;
    for (const track of this.destination?.stream.getTracks() ?? []) track.stop();
    this.listeners.clear();
    this.carrier = null;
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
