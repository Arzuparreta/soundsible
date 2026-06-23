import { createMemo, Show, type JSX } from 'solid-js';
import { state, actions, setNowPlayingOpen } from '../stores';
import { coverUrl } from '../lib/media';
import styles from './OmniBar.module.css';

/** Persistent mini-player. Progress line + tap-to-expand + play/pause + next. */
export function OmniBar() {
  const current = createMemo(() => state.playback.currentTrack);
  const audibleVolume = createMemo(() => (state.playback.muted ? 0 : state.playback.volume));
  const volumePct = createMemo(() => Math.round(audibleVolume() * 100));
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

  const volumeStyle = (): JSX.CSSProperties => ({ '--level': `${volumePct()}%` } as JSX.CSSProperties);

  const adjustVolumeByWheel = (e: WheelEvent) => {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.05 : -0.05;
    actions.setVolume(audibleVolume() + step);
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

      <div class={styles.soundBlade} style={volumeStyle()} onWheel={adjustVolumeByWheel}>
        <button
          class={styles.soundBtn}
          type="button"
          aria-label={state.playback.muted || state.playback.volume === 0 ? 'Activar sonido' : 'Silenciar'}
          aria-pressed={state.playback.muted}
          onClick={() => actions.toggleMute()}
        >
          <Show
            when={!state.playback.muted && state.playback.volume > 0}
            fallback={
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6" />
              </svg>
            }
          >
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
            </svg>
          </Show>
        </button>

        <div class={styles.soundRail}>
          <div class={styles.soundFill} />
          <input
            class={styles.soundRange}
            type="range"
            min={0}
            max={100}
            value={volumePct()}
            aria-label="Volumen"
            aria-valuetext={`${volumePct()}%`}
            onInput={(e) => actions.setVolume(Number(e.currentTarget.value) / 100)}
          />
        </div>

        <span class={styles.soundValue} aria-hidden="true">
          {volumePct()}
        </span>
      </div>
    </div>
  );
}
