import { createMemo, Show, type JSX } from 'solid-js';
import { state, actions, setNowPlayingOpen } from '../stores';
import { coverUrl } from '../lib/media';
import styles from './OmniBar.module.css';

/** Persistent mini-player. Progress line + tap-to-expand + play/pause + next. */
export function OmniBar() {
  const current = createMemo(() => state.playback.currentTrack);
  const pct = createMemo(() => {
    const d = state.playback.duration;
    return d > 0 ? Math.min(100, (state.playback.currentTime / d) * 100) : 0;
  });

  const coverBg = (): JSX.CSSProperties | undefined => {
    const c = current();
    if (!c) return undefined;
    const url = c.cover ?? coverUrl(c.id);
    return { background: `url("${url}") center / cover no-repeat, var(--bg-raised)` };
  };

  return (
    <div class={styles.omni}>
      <div class={styles.progress}>
        <div class={styles.progressFill} style={{ width: `${pct()}%` }} />
      </div>

      <button
        class={styles.openArea}
        type="button"
        disabled={!current()}
        onClick={() => current() && setNowPlayingOpen(true)}
      >
        <div class={styles.cover} style={coverBg()} />
        <div class={styles.meta}>
          <Show
            when={current()}
            fallback={
              <>
                <span class={styles.title}>Nada sonando</span>
                <span class={styles.sub}>{state.online ? 'Engine conectado' : 'Sin conexión'}</span>
              </>
            }
          >
            <span class={styles.title}>{current()!.title}</span>
            <span class={styles.sub}>{current()!.artist}</span>
          </Show>
        </div>
      </button>

      <button
        class={styles.ctrl}
        type="button"
        aria-label={state.playback.isPlaying ? 'Pausar' : 'Reproducir'}
        disabled={!current()}
        onClick={() => actions.togglePlay()}
      >
        <Show
          when={state.playback.isPlaying}
          fallback={
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path fill="currentColor" d="M8 5v14l11-7z" />
            </svg>
          }
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" />
          </svg>
        </Show>
      </button>

      <button
        class={styles.ctrl}
        type="button"
        aria-label="Siguiente"
        disabled={!current()}
        onClick={() => actions.next()}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z" />
        </svg>
      </button>
    </div>
  );
}
