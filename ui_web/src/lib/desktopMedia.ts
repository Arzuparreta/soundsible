import type { ProgramPlaybackSnapshot } from './audio';
import { trackCoverUrl } from './media';
import type { Track } from '../types/music';

export interface DesktopAction { action: string; value?: number; mode?: string; enabled?: boolean }
export interface DesktopMediaState {
  track_id: string; title: string; artist: string; album: string;
  playing: boolean; position: number; duration: number; rate: number;
  volume: number; can_next: boolean; can_previous: boolean; can_seek: boolean;
  shuffle: boolean; repeat: string; seek_serial: number; artwork: string | null;
}
export interface DesktopBridge {
  handshake(): Promise<{ media: boolean }>;
  publish(state: DesktopMediaState): Promise<void>;
  appearance(theme: string, colors: Record<string, string>): Promise<void>;
  onAction(handler: (action: DesktopAction) => void): () => void;
}
export interface DesktopControls {
  state(): Pick<DesktopMediaState, 'volume' | 'can_next' | 'can_previous' | 'shuffle' | 'repeat'>;
  snapshot(): ProgramPlaybackSnapshot;
  act(action: DesktopAction): void;
}
export function desktopBridge(): DesktopBridge | undefined {
  return (window as Window & { __SOUNDSIBLE_DESKTOP__?: DesktopBridge }).__SOUNDSIBLE_DESKTOP__;
}

/** Shares the programme projection with Rust; owns no playback or network session. */
export class DesktopMediaSession {
  active = false;
  private disposed = false;
  private track: Track | null = null;
  private snapshot: ProgramPlaybackSnapshot | null = null;
  private artwork: string | null = null;
  private artworkSource = '';
  private seekSerial = 0;
  private artAbort: AbortController | null = null;
  private timer: ReturnType<typeof setInterval>;
  private detach: () => void;
  constructor(private bridge: DesktopBridge, private controls: DesktopControls, onConnected: () => void) {
    this.detach = bridge.onAction(action => { if (!this.disposed && this.active) controls.act(action); });
    const connect = async () => {
      try {
        const features = await bridge.handshake();
        if (this.disposed) return;
        if (features.media && !this.active) { this.active = true; onConnected(); this.publish(); }
      } catch { /* A browser or an older shell keeps its own Media Session. */ }
    };
    void connect();
    this.timer = setInterval(() => {
      if (!this.active) void connect();
      else { this.snapshot = controls.snapshot(); this.publish(); }
    }, 5000);
  }
  sync(track: Track | null, snapshot: ProgramPlaybackSnapshot, seeked = false): void {
    if (seeked) this.seekSerial++;
    this.track = track;
    this.snapshot = snapshot.hasSource ? snapshot : this.controls.snapshot();
    if (!this.active) return;
    const source = track ? trackCoverUrl(track, 'thumb') ?? '' : '';
    if (source !== this.artworkSource) {
      this.artworkSource = source;
      this.artwork = null;
      this.artAbort?.abort();
      if (source) void this.loadArtwork(source);
    }
    this.publish();
  }
  private publish(): void {
    if (this.disposed || !this.active) return;
    const snapshot = this.snapshot ?? this.controls.snapshot();
    const track = this.track;
    void this.bridge.publish({
      track_id: track?.id ?? '', title: track?.title ?? '', artist: track?.artist ?? '', album: track?.album ?? '',
      playing: Boolean(track && snapshot.playing), position: Math.max(0, snapshot.position),
      duration: Math.max(0, snapshot.duration), rate: snapshot.playbackRate > 0 ? snapshot.playbackRate : 1,
      ...this.controls.state(), can_seek: Boolean(track && Number.isFinite(snapshot.duration) && snapshot.duration > 0),
      seek_serial: this.seekSerial, artwork: this.artwork,
    }).catch(() => { if (!this.disposed) this.active = false; });
  }
  private async loadArtwork(source: string): Promise<void> {
    const abort = new AbortController();
    this.artAbort = abort;
    try {
      const response = await fetch(source, { credentials: 'same-origin', signal: abort.signal });
      if (!response.ok) return;
      const blob = await response.blob();
      if (blob.size > 2 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) return;
      const value = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob);
      });
      if (this.disposed || abort.signal.aborted || source !== this.artworkSource) return;
      this.artwork = value; this.publish();
    } catch { /* Artwork is optional; private URLs never go to MPRIS. */ }
  }
  dispose(): void {
    this.disposed = true; this.active = false;
    clearInterval(this.timer); this.detach(); this.artAbort?.abort();
    void this.bridge.publish({ track_id: '', title: '', artist: '', album: '', playing: false,
      position: 0, duration: 0, rate: 1, volume: 0, can_next: false, can_previous: false,
      can_seek: false, shuffle: false, repeat: 'off', seek_serial: this.seekSerial, artwork: null }).catch(() => {});
  }
}
