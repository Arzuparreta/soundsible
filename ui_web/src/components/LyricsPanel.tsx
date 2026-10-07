import { state, actions } from '../stores';
import { trackKeys } from '../lib/playbackIdentity';
import { LyricsPanelView } from './LyricsPanelView';

/** Web adapter; the shared panel never creates or owns an audio output. */
export function LyricsPanel(props: { scrollRef?: (element: HTMLDivElement) => void; variant?: 'compact' | 'stage' } = {}) {
  return <LyricsPanelView {...props} playback={{
    currentTrack: () => state.playback.currentTrack ?? null,
    currentTime: () => state.playback.currentTime,
    inLibrary: track => state.library.some(row => row.id === track.id),
    saved: track => { const keys = new Set(trackKeys(track)); return state.saved.some(entry => entry.keys.some(key => keys.has(key))); },
    seek: seconds => actions.seek(seconds),
    mediaDuration: () => state.playback.duration || undefined,
  }} />;
}
