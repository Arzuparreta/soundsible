import { createEffect, createMemo, For, Show, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { state, actions, nowPlayingOpen, setNowPlayingOpen } from '../stores';
import { coverUrl } from '../lib/media';
import { openTrackMenu } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { shareTrack } from '../lib/share';
import { artistPath } from '../lib/artistRoute';
import styles from './NowPlaying.module.css';

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return `${m}:${x.toString().padStart(2, '0')}`;
}

/** Full-screen Now Playing sheet. Slides up; controlled by the nowPlayingOpen signal. */
export function NowPlaying() {
  const navigate = useNavigate();
  const t = createMemo(() => state.playback.currentTrack);
  const isFav = createMemo(() => {
    const c = t();
    return !!c && state.favorites.includes(c.id);
  });
  let dragFrom: number | null = null;
  let bodyEl: HTMLDivElement | undefined;
  let sheetEl: HTMLDivElement | undefined;
  // Distance (px) over which the floating "En cola" badge unwinds from its
  // hovering hint position into its docked section-header position. While
  // scrolled within [0, QUEUE_LIFT] the badge stays visually pinned (a stable
  // hint); past it, it flows to its natural spot. Must match --queue-lift in
  // NowPlaying.module.css.
  const QUEUE_LIFT = 80;
  const onBodyScroll = () => {
    if (!bodyEl) return;
    const q = Math.min(1, bodyEl.scrollTop / QUEUE_LIFT);
    bodyEl.style.setProperty('--q', q.toFixed(3));
    bodyEl.toggleAttribute('data-docked', q >= 1);
  };
  // Always (re)open on the player, with the queue badge in its hint state.
  createEffect(() => {
    if (!nowPlayingOpen() || !bodyEl) return;
    bodyEl.scrollTop = 0;
    bodyEl.style.setProperty('--q', '0');
    bodyEl.removeAttribute('data-docked');
  });

  // Swipe-down-to-close. The body itself is locked (overscroll-behavior-y:
  // none in CSS) so a downward drag at the top of the body is no longer
  // absorbed by the body's native scroll. We capture it here on the sheet and
  // close on release, with the sheet visually following the finger while
  // dragging.
  let swipeStartY = 0;
  let swipeActive = false;
  let swipeOnBody = false;
  let swipeBodyAtTop = false;
  /** Px of downward drag that closes the sheet on release. Tuned for a
   * comfortable mobile thumb swipe — roughly 1/8 of a typical phone height. */
  const SWIPE_CLOSE_THRESHOLD = 80;
  /** Px of downward movement that activates swipe-to-close. Below this we
   * treat the gesture as a tap or horizontal interaction and stay out of the
   * way (so seek/volume sliders and button taps work normally). */
  const SWIPE_ACTIVATE_THRESHOLD = 8;

  const onSheetPointerDown = (e: PointerEvent) => {
    if (!nowPlayingOpen()) return;
    // Only the primary pointer (first finger / left mouse button). Multi-touch
    // and right-clicks fall through to the element beneath.
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swipeStartY = e.clientY;
    swipeActive = false;
    // The head always counts as a close handle. The body only counts when
    // it's scrolled to the very top — otherwise a downward drag is just the
    // user scrolling the queue back to the player and must not close the
    // sheet.
    const target = e.target as Node | null;
    swipeOnBody = !!(bodyEl && target && bodyEl.contains(target));
    swipeBodyAtTop = (bodyEl?.scrollTop ?? 0) === 0;
  };

  const onSheetPointerMove = (e: PointerEvent) => {
    if (!nowPlayingOpen() || !sheetEl) return;
    const deltaY = e.clientY - swipeStartY;
    if (!swipeActive) {
      if (deltaY <= SWIPE_ACTIVATE_THRESHOLD) return;
      if (swipeOnBody && !swipeBodyAtTop) return;
      swipeActive = true;
      // Disable the open/close transition so the sheet tracks the finger 1:1.
      // Restored on release.
      sheetEl.setAttribute('data-swiping', '');
    }
    sheetEl.style.transform = `translateY(${Math.max(0, deltaY)}px)`;
  };

  const endSwipe = (close: boolean) => {
    if (!swipeActive || !sheetEl) return;
    swipeActive = false;
    sheetEl.removeAttribute('data-swiping');
    if (close) setNowPlayingOpen(false);
    // Clear the inline transform on the next frame so the CSS transition can
    // animate from the finger's release position to translateY(0) (snap back)
    // or translateY(100%) (close, once .open is removed above).
    requestAnimationFrame(() => {
      if (sheetEl) sheetEl.style.transform = '';
    });
  };

  const onSheetPointerUp = (e: PointerEvent) => {
    if (!swipeActive) return;
    endSwipe(e.clientY - swipeStartY > SWIPE_CLOSE_THRESHOLD);
  };

  const onSheetPointerCancel = () => {
    endSwipe(false);
  };
  /** Library tracks link to their artist; preview/podcast sources do not. */
  const artistLinkable = createMemo(() => {
    const c = t();
    return !!c && c.source !== 'preview' && !!c.artist;
  });
  const goArtist = () => {
    const c = t();
    if (!c?.artist) return;
    setNowPlayingOpen(false);
    navigate(artistPath(c.artist));
  };

  const artBg = (): JSX.CSSProperties => {
    const c = t();
    const url = c ? (c.cover ?? coverUrl(c.id)) : '';
    return url
      ? { background: `url("${url}") center / cover no-repeat, var(--bg-raised)` }
      : { background: 'var(--bg-raised)' };
  };

  return (
    <div
      ref={sheetEl}
      classList={{ [styles.sheet]: true, [styles.open]: nowPlayingOpen() }}
      aria-hidden={!nowPlayingOpen()}
      onPointerDown={onSheetPointerDown}
      onPointerMove={onSheetPointerMove}
      onPointerUp={onSheetPointerUp}
      onPointerCancel={onSheetPointerCancel}
    >
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
        <div class={styles.body} ref={bodyEl} onScroll={onBodyScroll}>
          <div class={styles.player}>
          <div class={styles.art} style={artBg()} />

          <div class={styles.details}>
            <div class={styles.info}>
              <h1 class={styles.title}>{t()!.title}</h1>
              <Show when={artistLinkable()} fallback={<p class={styles.artist}>{t()!.artist}</p>}>
                <button class={styles.artistLink} type="button" onClick={goArtist}>
                  {t()!.artist}
                </button>
              </Show>
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

            <div class={styles.actionsBar}>
            <button
              class={styles.actBtn}
              classList={{ [styles.actOn]: isFav() }}
              type="button"
              aria-label={isFav() ? 'Quitar de favoritos' : 'Añadir a favoritos'}
              aria-pressed={isFav()}
              onClick={() => actions.toggleFavourite(t()!.id)}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill={isFav() ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z" />
              </svg>
            </button>

            <div class={styles.volume}>
              <button
                class={styles.actBtn}
                type="button"
                aria-label={state.playback.muted ? 'Activar sonido' : 'Silenciar'}
                onClick={() => actions.toggleMute()}
              >
                <Show
                  when={!state.playback.muted && state.playback.volume > 0}
                  fallback={
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6" />
                    </svg>
                  }
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
                  </svg>
                </Show>
              </button>
              <input
                class={styles.volRange}
                type="range"
                min={0}
                max={100}
                value={Math.round((state.playback.muted ? 0 : state.playback.volume) * 100)}
                aria-label="Volumen"
                onInput={(e) => actions.setVolume(Number(e.currentTarget.value) / 100)}
              />
            </div>

            <button class={styles.actBtn} type="button" aria-label="Compartir" onClick={() => void shareTrack(t()!)}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 12v8h16v-8M12 16V3M8 7l4-4 4 4" />
              </svg>
            </button>

            <button
              class={styles.actBtn}
              type="button"
              aria-label="Más opciones"
              onClick={() =>
                openTrackMenu(t()!, {
                  navigate,
                  onAddToPlaylist: openPlaylistPicker,
                  onEditMetadata: openMetadataEditor,
                  onPlayOnDevice: openPlayOnDevice,
                })
              }
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="19" cy="12" r="2" />
              </svg>
            </button>
            </div>
          </div>
          </div>

          <Show when={state.playback.queue.length > 1}>
            <div class={styles.queue}>
              <div class={styles.queueHead}>
                <span class={styles.queuePill}>
                  <h2 class={styles.queueTitle}>En cola</h2>
                  <svg
                    class={styles.queueChevron}
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </span>
                <button class={styles.queueClear} type="button" onClick={() => actions.clearQueue()}>
                  Vaciar
                </button>
              </div>
              <For each={state.playback.queue}>
                {(qt, i) => (
                  <div
                    classList={{ [styles.qRow]: true, [styles.qActive]: i() === state.playback.index }}
                    draggable={true}
                    onDragStart={(e) => {
                      dragFrom = i();
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragFrom != null && dragFrom !== i()) actions.moveInQueue(dragFrom, i());
                      dragFrom = null;
                    }}
                  >
                    <span class={styles.qHandle} aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
                        <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
                        <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                      </svg>
                    </span>
                    <button class={styles.qPlay} type="button" onClick={() => actions.jumpTo(i())}>
                      <span class={styles.qIndex}>{i() + 1}</span>
                      <span class={styles.qMeta}>
                        <span class={styles.qTitle}>{qt.title}</span>
                        <span class={styles.qArtist}>{qt.artist}</span>
                      </span>
                    </button>
                    <button
                      class={styles.qRemove}
                      type="button"
                      aria-label="Quitar de la cola"
                      onClick={() => actions.removeFromQueue(i())}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                )}
              </For>
              </div>
            </Show>
        </div>
      </Show>
    </div>
  );
}
