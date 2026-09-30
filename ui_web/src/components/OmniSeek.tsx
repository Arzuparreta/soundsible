import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { actions, state, setNowPlayingOpen } from '../stores';
import { clockTime } from '../lib/format';
import { t } from '../lib/i18n';
import { claimHoldGesture } from '../lib/holdGesture';
import { shieldGhostClicks } from '../lib/ghostClick';
import { pageVisible } from '../lib/pageVisibility';
import styles from './OmniBar.module.css';

const TOUCH_HOLD_MS = 400;

/** The whole pill owns touch acquisition; its native slider is only the
 * keyboard/assistive and mouse interface. Capturing at the surface keeps a
 * backwards seek out of the dismissal handler, including across child buttons.
 * Pointer edits stay local until release. */
export function OmniSeek(props: { onClaim: () => void }) {
  const [preview, setPreview] = createSignal<number | null>(null);
  let input!: HTMLInputElement;
  let surface!: HTMLElement;
  let suppressTouchClick = false;
  let releaseHold: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gesture: { id: number; x: number; y: number; active: boolean; moved: boolean; touch: boolean; startPosition: number; fromRail: boolean; blank: boolean } | undefined;
  const duration = () => Number.isFinite(state.playback.duration) ? Math.max(0, state.playback.duration) : 0;
  const disabled = () => !state.playback.currentTrack || !Number.isFinite(duration()) || duration() <= 0 || state.playback.isLoading || Boolean(state.playback.loadError);
  const playbackPosition = createMemo<number>(previous => pageVisible() ? state.playback.currentTime : previous ?? 0);
  const position = () => Math.max(0, Math.min(duration() || 0, preview() ?? playbackPosition()));
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    releaseHold?.();
    releaseHold = undefined;
    surface?.removeAttribute('data-seek-active');
    const previous = gesture;
    gesture = undefined;
    setPreview(null);
    if (previous && surface.hasPointerCapture?.(previous.id)) surface.releasePointerCapture(previous.id);
  };
  createEffect(() => {
    // Even a replacement with the same duration invalidates an in-flight edit.
    state.playback.currentTrack?.id;
    duration();
    disabled();
    pageVisible();
    clear();
  });
  onCleanup(clear);
  const at = (x: number) => {
    const rect = input.getBoundingClientRect();
    return Math.max(0, Math.min(duration(), (x - rect.left) / Math.max(1, rect.width) * duration()));
  };
  const claim = () => {
    if (!gesture || disabled()) return;
    gesture.active = true;
    gesture.startPosition = position();
    setPreview(gesture.startPosition);
    surface.setAttribute('data-seek-active', '');
    if (gesture.touch) {
      suppressTouchClick = true;
      releaseHold = claimHoldGesture();
    }
    surface.setPointerCapture?.(gesture.id);
    props.onClaim();
  };
  const down = (event: PointerEvent) => {
    if (event.isPrimary) suppressTouchClick = false;
    if (gesture || !event.isPrimary) { clear(); return; }
    if (event.target instanceof HTMLInputElement && event.target !== input) return;
    if (disabled() || (event.pointerType === 'mouse' && (event.button !== 0 || event.target !== input))) return;
    // Prevent the native range from seeking on contact. touch-action still lets
    // the browser cancel us for a vertical scroll or pinch.
    if (event.target === input) event.preventDefault();
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false, moved: false, touch: event.pointerType !== 'mouse', startPosition: position(), fromRail: event.target === input, blank: event.target === surface };
    if (gesture.touch) timer = setTimeout(claim, TOUCH_HOLD_MS);
    else {
      input.focus();
      claim();
      gesture.moved = true;
      setPreview(at(event.clientX));
    }
  };
  const move = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const distance = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
    if (!gesture.active) {
      if (distance > 8) clear();
      return;
    }
    event.stopImmediatePropagation();
    if (Math.abs(event.clientX - gesture.x) > 3) gesture.moved = true;
    if (gesture.moved) {
      const target = gesture.touch
        ? gesture.startPosition + (event.clientX - gesture.x) / Math.max(1, input.getBoundingClientRect().width) * duration()
        : at(event.clientX);
      setPreview(Math.max(0, Math.min(duration(), target)));
    }
  };
  const up = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const { active, moved, touch, y, fromRail, blank } = gesture;
    if (active) event.stopImmediatePropagation();
    const target = preview();
    if (touch && (active || fromRail || blank)) shieldGhostClicks();
    clear();
    if (active && moved && target !== null && !disabled()) actions.seek(target);
    // Only the portion inside the pill retains its existing tap-to-open action.
    else if (!active && touch && (blank || (fromRail && y >= input.getBoundingClientRect().top + 16))) setNowPlayingOpen(true);
  };
  onMount(() => {
    surface = input.closest<HTMLElement>('[data-omni-player]') ?? input.parentElement!;
    const cancelSecondary = (event: PointerEvent) => { if (!event.isPrimary) clear(); };
    const lostCapture = (event: PointerEvent) => {
      // Taking capture from a button releases that child's implicit capture.
      // Only losing the surface's own capture ends the acquired seek.
      if (event.target === surface && event.pointerId === gesture?.id) clear();
    };
    const context = (event: Event) => { if (gesture?.active) event.preventDefault(); };
    const click = (event: MouseEvent) => {
      // Keep ownership through cancellation as well as successful release.
      // A new physical press resets this; keyboard clicks (detail 0) bypass it.
      if (suppressTouchClick && event.detail !== 0) {
        suppressTouchClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    surface.addEventListener('pointerdown', down, true);
    surface.addEventListener('pointermove', move, true);
    surface.addEventListener('pointerup', up, true);
    surface.addEventListener('pointercancel', clear, true);
    surface.addEventListener('lostpointercapture', lostCapture, true);
    surface.addEventListener('contextmenu', context, true);
    surface.addEventListener('click', click, true);
    window.addEventListener('pointerdown', cancelSecondary, true);
    window.addEventListener('blur', clear);
    onCleanup(() => {
      surface.removeEventListener('pointerdown', down, true);
      surface.removeEventListener('pointermove', move, true);
      surface.removeEventListener('pointerup', up, true);
      surface.removeEventListener('pointercancel', clear, true);
      surface.removeEventListener('lostpointercapture', lostCapture, true);
      surface.removeEventListener('contextmenu', context, true);
      surface.removeEventListener('click', click, true);
      window.removeEventListener('pointerdown', cancelSecondary, true);
      window.removeEventListener('blur', clear);
    });
  });
  return <div class={styles.seekControl} data-omni-seek="" data-seeking={preview() !== null ? '' : undefined}>
    <div class={styles.progress} aria-hidden="true">
      <div class={styles.progressFill} style={{ '--p': duration() > 0 ? position() / duration() : 0 }} />
    </div>
    <input ref={input} class={styles.seekInput} type="range" min={0} max={Math.max(1, duration() || 0)} step={1}
      value={position()} disabled={disabled()} aria-label={t('nowPlaying.seekLabel')}
      aria-valuetext={`${clockTime(position())} / ${clockTime(duration())}`}
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
