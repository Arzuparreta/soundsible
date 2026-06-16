import { createMemo, For, Show, type JSX } from 'solid-js';
import { state, actions, nowPlayingOpen, setNowPlayingOpen } from '../stores';
import { coverUrl } from '../lib/media';
import styles from './NowPlaying.module.css';

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return `${m}:${x.toString().padStart(2, '0')}`;
}

/** Full-screen Now Playing sheet. Slides up; controlled by the nowPlayingOpen signal. */
export function NowPlaying() {
  const t = createMemo(() => state.playback.currentTrack);

  const artBg = (): JSX.CSSProperties => {
    const c = t();
    const url = c ? (c.cover ?? coverUrl(c.id)) : '';
    return url
      ? { background: `url("${url}") center / cover no-repeat, var(--bg-raised)` }
      : { background: 'var(--bg-raised)' };
  };

  return (
    <div classList={{ [styles.sheet]: true, [styles.open]: nowPlayingOpen() }} aria-hidden={!nowPlayingOpen()}>
      <header class={styles.head}>
        <button class={styles.iconBtn} type="button" aria-label="Cerrar" onClick={() => setNowPlayingOpen(false)}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <span class={styles.headLabel}>Reproduciendo</span>
        <span class={styles.iconBtn} aria-hidden="true" />
      </header>

      <Show when={t()} fallback={<div class={styles.empty}>Nada sonando</div>}>
        <div class={styles.body}>
          <div class={styles.art} style={artBg()} />

          <div class={styles.info}>
            <h1 class={styles.title}>{t()!.title}</h1>
            <p class={styles.artist}>{t()!.artist}</p>
          </div>

          <div class={styles.seekWrap}>
            <input
              class={styles.seek}
              type="range"
              min={0}
              max={Math.max(1, Math.floor(state.playback.duration))}
              value={Math.floor(state.playback.currentTime)}
              step={1}
              aria-label="Buscar en la pista"
              onInput={(e) => actions.seek(Number(e.currentTarget.value))}
            />
            <div class={styles.times}>
              <span>{fmt(state.playback.currentTime)}</span>
              <span>{fmt(state.playback.duration)}</span>
            </div>
          </div>

          <div class={styles.controls}>
            <button
              classList={{ [styles.toggle]: true, [styles.on]: state.playback.shuffle }}
              type="button"
              aria-label="Aleatorio"
              aria-pressed={state.playback.shuffle}
              onClick={() => actions.toggleShuffle()}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" />
              </svg>
            </button>

            <button class={styles.ctrl} type="button" aria-label="Anterior" onClick={() => actions.prev()}>
              <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                <path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </button>

            <button class={styles.play} type="button" aria-label={state.playback.isPlaying ? 'Pausar' : 'Reproducir'} onClick={() => actions.togglePlay()}>
              <Show
                when={state.playback.isPlaying}
                fallback={
                  <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
                    <path fill="currentColor" d="M8 5v14l11-7z" />
                  </svg>
                }
              >
                <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
                  <path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" />
                </svg>
              </Show>
            </button>

            <button class={styles.ctrl} type="button" aria-label="Siguiente" onClick={() => actions.next()}>
              <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                <path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" />
              </svg>
            </button>

            <button
              classList={{ [styles.toggle]: true, [styles.on]: state.playback.repeat !== 'off' }}
              type="button"
              aria-label="Repetir"
              onClick={() => actions.cycleRepeat()}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3" />
              </svg>
              <Show when={state.playback.repeat === 'one'}>
                <span class={styles.repeatOne}>1</span>
              </Show>
            </button>
          </div>

          <Show when={state.playback.queue.length > 1}>
            <div class={styles.queue}>
              <h2 class={styles.queueTitle}>En cola</h2>
              <For each={state.playback.queue}>
                {(qt, i) => (
                  <button
                    classList={{ [styles.qRow]: true, [styles.qActive]: i() === state.playback.index }}
                    type="button"
                    onClick={() => actions.jumpTo(i())}
                  >
                    <span class={styles.qIndex}>{i() + 1}</span>
                    <span class={styles.qMeta}>
                      <span class={styles.qTitle}>{qt.title}</span>
                      <span class={styles.qArtist}>{qt.artist}</span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
