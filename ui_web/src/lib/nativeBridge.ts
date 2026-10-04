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
}

declare global {
  interface Window {
    SoundsibleNative?: {
      onTrackChanged?: (json: string) => void;
    };
  }
}

export function reportNowPlaying(track: {
  title: string;
  artist: string;
  album?: string;
} | null, playing: boolean): void {
  try {
    const bridge = typeof window !== 'undefined' ? window.SoundsibleNative : undefined;
    if (!bridge || typeof bridge.onTrackChanged !== 'function') return;
    const payload: NativeNowPlaying = track
      ? { title: track.title, artist: track.artist, album: track.album ?? '', playing }
      : { title: '', artist: '', album: '', playing: false };
    bridge.onTrackChanged(JSON.stringify(payload));
  } catch {
    /* the shell surface is best-effort; playback never depends on it */
  }
}
