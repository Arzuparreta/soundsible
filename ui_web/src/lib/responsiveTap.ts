import { claimHoldGesture, clearTextSelection } from './holdGesture';
import { shieldGhostClicks } from './ghostClick';
import { getOwner, onCleanup } from 'solid-js';

const TAP_SLOP = 8;
const LONG_PRESS_MS = 450;

export interface ResponsiveTapOptions {
  onTap: (event: PointerEvent | MouseEvent) => void;
  onLongPress?: (event: PointerEvent) => void;
  onPressChange?: (pressed: boolean) => void;
  disabled?: () => boolean;
}

/**
 * Touch activation that does not depend on the browser's synthetic `click`.
 *
 * Mobile WebKit may suppress that click while interrupting kinetic scrolling.
 * When pointer events are delivered, activating on pointerup makes fixed
 * navigation and list rows respond immediately. Native scrolling still owns
 * drags: movement beyond the slop, pointercancel and a nested interactive
 * control all cancel the candidate.
 *
 * Mouse and keyboard keep the platform `click` path. The compatibility click
 * that follows a handled touch is left to lib/ghostClick, which swallows it
 * wherever it lands — including on whatever this activation just moved under
 * the finger.
 */
export function createResponsiveTap(options: ResponsiveTapOptions) {
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let cancelled = false;
  let longPressed = false;
  let longPressTimer: number | undefined;
  let releaseHold: (() => void) | undefined;

  const clearLongPress = () => {
    window.clearTimeout(longPressTimer);
    longPressTimer = undefined;
  };

  /** Hand the platform its gesture back. Safe to call from every path that
   * ends a press, and from several of them at once. */
  const endHold = () => {
    releaseHold?.();
    releaseHold = undefined;
  };

  const reset = () => {
    options.onPressChange?.(false);
    clearLongPress();
    endHold();
    pointerId = null;
    cancelled = false;
    longPressed = false;
  };

  // Virtualization can remove a pressed row before pointerup arrives.
  if (getOwner()) onCleanup(reset);

  const nestedInteractive = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const current = event.currentTarget instanceof Element ? event.currentTarget : null;
    const nested = target?.closest(
      'a, button, input, select, textarea, [role="button"], [data-tap-exclude]',
    );
    return !!nested && nested !== current;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (
      event.pointerType !== 'touch' ||
      !event.isPrimary ||
      options.disabled?.() ||
      nestedInteractive(event)
    ) {
      return;
    }
    pointerId = event.pointerId;
    options.onPressChange?.(true);
    startX = event.clientX;
    startY = event.clientY;
    cancelled = false;
    longPressed = false;
    clearLongPress();
    if (options.onLongPress) {
      // Claimed up front, not when the press completes: Safari decides what to
      // select at around 500ms, and by then the menu is already open under the
      // finger. Arming late is arming after the damage.
      endHold();
      releaseHold = claimHoldGesture();
      longPressTimer = window.setTimeout(() => {
        if (pointerId !== event.pointerId || cancelled) return;
        longPressed = true;
        options.onPressChange?.(false);
        clearTextSelection();
        options.onLongPress?.(event);
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    if (
      Math.abs(event.clientX - startX) > TAP_SLOP ||
      Math.abs(event.clientY - startY) > TAP_SLOP
    ) {
      cancelled = true;
      options.onPressChange?.(false);
      clearLongPress();
      // A pan is not a hold. Releasing here, rather than waiting for the lift,
      // keeps a scroll that started on a row from holding selection hostage
      // for the length of the flick.
      endHold();
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    const shouldTap = !cancelled && !longPressed && !options.disabled?.();
    reset();
    // Whatever this press did — activated the control, or opened a menu that is
    // now sitting under the finger — the mouse events the platform still owes
    // this touch belong to nobody. Armed before the activation runs, so the
    // guard is already up when the screen changes under it.
    // A cancelled pan must not leave an activation behind either.
    shieldGhostClicks();
    if (!shouldTap) return;
    options.onTap(event);
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (pointerId === event.pointerId) {
      shieldGhostClicks();
      reset();
    }
  };

  const onClick = (event: MouseEvent) => {
    // A click that closes a text selection inside this element is not an
    // activation: dragging across a song title to copy it must not also play
    // the song. A plain click never trips this — mousedown collapses whatever
    // was selected before the click is dispatched.
    if (event.detail > 0 && selectionWithin(event.currentTarget)) return;
    if (!options.disabled?.()) options.onTap(event);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick };
}

/** Does the document's selection live inside this element? */
function selectionWithin(node: EventTarget | null): boolean {
  if (typeof window === 'undefined' || !(node instanceof Node)) return false;
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  return (
    (!!selection.anchorNode && node.contains(selection.anchorNode)) ||
    (!!selection.focusNode && node.contains(selection.focusNode))
  );
}

export const responsiveTapConstants = {
  TAP_SLOP,
  LONG_PRESS_MS,
} as const;
