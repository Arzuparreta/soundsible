/**
 * One-way bridge from the web player to a hosting native shell.
 *
 * The Android app shows this UI inside a WebView while playback state also
 * feeds the home-screen widget, which lives outside the page. The page
 * reports what is sounding; the shell decides what to do with it. Every
 * access is guarded: on a plain browser `window.SoundsibleNative` is simply
 * absent and nothing happens.
 */
export interface NativeNowPlaying {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  coverUrl: string;
  trackId: string;
  positionSec: number;
  durationSec: number;
}

declare global {
  interface Window {
    SoundsibleNative?: {
      onTrackChanged?: (json: string) => void;
    };
    SoundsibleNativeControl?: NativeControl;
  }
}

/**
 * Lets the hosting shell drive page transport (notification and widget
 * actions route back into the page). Guarded and optional like everything
 * else in this module.
 */
export interface NativeControl {
  pause(): void;
  play(): void;
  toggle(): void;
  next(): void;
  previous(): void;
}

export function installNativeControl(control: NativeControl): void {
  try {
    if (typeof window === 'undefined') return;
    window.SoundsibleNativeControl = control;
  } catch {
    /* the shell surface is best-effort; playback never depends on it */
  }
}

export function reportNowPlaying(track: {
  title: string;
  artist: string;
  album?: string;
  id?: string;
} | null, playing: boolean, coverUrl = '', positionSec = 0, durationSec = 0): void {
  try {
    const bridge = typeof window !== 'undefined' ? window.SoundsibleNative : undefined;
    if (!bridge || typeof bridge.onTrackChanged !== 'function') return;
    const payload: NativeNowPlaying = track
      ? {
        title: track.title,
        artist: track.artist,
        album: track.album ?? '',
        playing,
        coverUrl,
        trackId: track.id ?? '',
        positionSec,
        durationSec,
      }
      : { title: '', artist: '', album: '', playing: false, coverUrl: '', trackId: '', positionSec: 0, durationSec: 0 };
    bridge.onTrackChanged(JSON.stringify(payload));
  } catch {
    /* the shell surface is best-effort; playback never depends on it */
  }
}
