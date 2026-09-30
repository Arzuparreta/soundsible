import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { actions, state, setNowPlayingOpen } from '../stores';
import { clockTime } from '../lib/format';
import { t } from '../lib/i18n';
import { shieldGhostClicks } from '../lib/ghostClick';
import { pageVisible } from '../lib/pageVisibility';
import styles from './OmniBar.module.css';

/** A native accessible slider with deliberate touch acquisition. Pointer edits
 * stay local until release; keyboard and assistive input commit directly. */
export function OmniSeek(props: { onClaim: () => void }) {
  const [preview, setPreview] = createSignal<number | null>(null);
  let input!: HTMLInputElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gesture: { id: number; x: number; y: number; active: boolean; moved: boolean; touch: boolean } | undefined;
  const duration = () => Number.isFinite(state.playback.duration) ? Math.max(0, state.playback.duration) : 0;
  const disabled = () => !state.playback.currentTrack || !Number.isFinite(duration()) || duration() <= 0 || state.playback.isLoading || Boolean(state.playback.loadError);
  const playbackPosition = createMemo<number>(previous => pageVisible() ? state.playback.currentTime : previous ?? 0);
  const position = () => Math.max(0, Math.min(duration() || 0, preview() ?? playbackPosition()));
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    const previous = gesture;
    gesture = undefined;
    setPreview(null);
    if (previous && input.hasPointerCapture?.(previous.id)) input.releasePointerCapture(previous.id);
  };
  createEffect(() => {
    // Even a replacement with the same duration invalidates an in-flight edit.
    state.playback.currentTrack?.id;
    duration();
    disabled();
    pageVisible();
    clear();
  });
  onMount(() => {
    const cancelSecondary = (event: PointerEvent) => { if (!event.isPrimary) clear(); };
    const cancelBlur = () => clear();
    window.addEventListener('pointerdown', cancelSecondary, true);
    window.addEventListener('blur', cancelBlur);
    onCleanup(() => {
      window.removeEventListener('pointerdown', cancelSecondary, true);
      window.removeEventListener('blur', cancelBlur);
    });
  });
  onCleanup(clear);
  const at = (x: number) => {
    const rect = input.getBoundingClientRect();
    return Math.max(0, Math.min(duration(), (x - rect.left) / Math.max(1, rect.width) * duration()));
  };
  const claim = () => {
    if (!gesture || disabled()) return;
    gesture.active = true;
    setPreview(position());
    input.setPointerCapture?.(gesture.id);
    props.onClaim();
  };
  const down: JSX.EventHandler<HTMLInputElement, PointerEvent> = event => {
    if (gesture || !event.isPrimary) { clear(); return; }
    if (disabled() || (event.pointerType === 'mouse' && event.button !== 0)) return;
    // Prevent the native range from seeking on contact. touch-action still lets
    // the browser cancel us for a vertical scroll or pinch.
    event.preventDefault();
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false, moved: false, touch: event.pointerType !== 'mouse' };
    if (gesture.touch) timer = setTimeout(claim, 180);
    else {
      input.focus();
      claim();
      gesture.moved = true;
      setPreview(at(event.clientX));
    }
  };
  const move: JSX.EventHandler<HTMLInputElement, PointerEvent> = event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const distance = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
    if (!gesture.active) {
      if (distance > 8) clear();
      return;
    }
    event.stopPropagation();
    if (Math.abs(event.clientX - gesture.x) > 3) gesture.moved = true;
    if (gesture.moved) setPreview(at(event.clientX));
  };
  const up: JSX.EventHandler<HTMLInputElement, PointerEvent> = event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const { active, moved, touch, y } = gesture;
    if (active) event.stopPropagation();
    const target = preview();
    if (touch) shieldGhostClicks();
    clear();
    if (active && moved && target !== null && !disabled()) actions.seek(target);
    // Only the portion inside the pill retains its existing tap-to-open action.
    else if (!active && touch && y >= input.getBoundingClientRect().top + 16) setNowPlayingOpen(true);
  };
  return <div class={styles.seekControl} data-omni-seek="" data-seeking={preview() !== null ? '' : undefined}>
    <div class={styles.progress} aria-hidden="true">
      <div class={styles.progressFill} style={{ '--p': duration() > 0 ? position() / duration() : 0 }} />
    </div>
    <input ref={input} class={styles.seekInput} type="range" min={0} max={Math.max(1, duration() || 0)} step={1}
      value={position()} disabled={disabled()} aria-label={t('nowPlaying.seekLabel')}
      aria-valuetext={`${clockTime(position())} / ${clockTime(duration())}`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onPointerCancel={clear} onLostPointerCapture={clear}
      onClick={event => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={event => { if (event.key === 'Escape') clear(); }}
      onContextMenu={event => event.preventDefault()}
      onInput={event => { if (!gesture && !disabled()) actions.seek(Number(event.currentTarget.value)); }}
    />
    <Show when={preview() !== null}>
      <span class={styles.seekHandle} style={{ left: `${duration() > 0 ? position() / duration() * 100 : 0}%` }} aria-hidden="true" />
      <span class={styles.seekTime} aria-hidden="true">{clockTime(position())} / {clockTime(duration())}</span>
    </Show>
  </div>;
}
