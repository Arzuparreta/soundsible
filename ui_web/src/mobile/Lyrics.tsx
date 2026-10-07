import { createEffect, createMemo } from 'solid-js';
import { LyricsPanelView } from '../components/LyricsPanelView';
import { openOverlay } from '../lib/overlay';
import { trackKeys } from '../lib/playbackIdentity';
import { t } from '../lib/i18n';
import styles from './Lyrics.module.css';
import type { ProgramState, ProgramCommand } from '../lib/program/runtime';
import type { SavedEntry, Track } from '../types/music';

export function openNativeLyrics(program: () => ProgramState | null, library: () => Track[], saved: () => SavedEntry[], current: () => boolean, execute: (command: ProgramCommand) => Promise<void>) {
  if (!current()) return;
  return openOverlay(close => {
    createEffect(() => { if (!current() || !program()?.queue.length) close(); });
    const track = createMemo<Track | null>(() => {
      const state = program(), item = state?.items[state.index];
      if (!state || !item || !current()) return null;
      const local = library().find(row => row.id === item.id);
      return { ...local, id: item.id, title: item.title, artist: item.artist, album: item.album,
        duration: local?.duration ?? (state.durationMs > 0 ? state.durationMs / 1000 : undefined),
        source: item.source === 'local' ? undefined : 'preview',
        media_kind: item.mediaKind, playback_source_kind: item.source === 'preview' ? local?.playback_source_kind ?? 'unverified' : local?.playback_source_kind, youtube_id: item.source === 'preview' ? item.id : local?.youtube_id };
    }, null, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
    return <section class={styles.panel} data-native-lyrics>
      <h2>{t('nowPlaying.showLyrics')}</h2><button onClick={() => close()}>{t('common.close')}</button>
      <LyricsPanelView playback={{ currentTrack: track, currentTime: () => (program()?.positionMs ?? 0) / 1000,
        inLibrary: row => library().some(entry => entry.id === row.id && entry.source !== 'preview'),
        saved: row => { const keys = new Set(trackKeys(row)); return saved().some(entry => entry.keys.some(key => keys.has(key))); },
        mediaDuration: () => { const ms = program()?.durationMs ?? 0; return ms > 0 ? ms / 1000 : undefined; },
        seek: seconds => { if (current() && program()?.seekable !== false && Number.isFinite(seconds)) void execute({ action: 'seek', positionMs: Math.round(seconds * 1000) }).catch(() => {}); },
      }} />
    </section>;
  }, { ariaLabel: () => t('nowPlaying.showLyrics'), variant: 'window' });
}
