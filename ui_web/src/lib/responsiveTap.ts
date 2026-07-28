const TAP_SLOP = 8;
const LONG_PRESS_MS = 450;
const CLICK_SUPPRESSION_MS = 700;

export interface ResponsiveTapOptions {
  onTap: (event: PointerEvent | MouseEvent) => void;
  onLongPress?: (event: PointerEvent) => void;
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
 * Mouse and keyboard keep the platform `click` path. A short suppression
 * window consumes the compatibility click that follows a handled touch tap.
 */
export function createResponsiveTap(options: ResponsiveTapOptions) {
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let cancelled = false;
  let longPressed = false;
  let longPressTimer: number | undefined;
  let suppressClickUntil = 0;

  const clearLongPress = () => {
    window.clearTimeout(longPressTimer);
    longPressTimer = undefined;
  };

  const reset = () => {
    clearLongPress();
    pointerId = null;
    cancelled = false;
    longPressed = false;
  };

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
    startX = event.clientX;
    startY = event.clientY;
    cancelled = false;
    longPressed = false;
    clearLongPress();
    if (options.onLongPress) {
      longPressTimer = window.setTimeout(() => {
        if (pointerId !== event.pointerId || cancelled) return;
        longPressed = true;
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
      clearLongPress();
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    const shouldTap = !cancelled && !longPressed && !options.disabled?.();
    reset();
    if (!shouldTap) return;
    suppressClickUntil = performance.now() + CLICK_SUPPRESSION_MS;
    options.onTap(event);
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (pointerId === event.pointerId) reset();
  };

  const onClick = (event: MouseEvent) => {
    // Keyboard activation has detail=0 and must never be swallowed.
    if (event.detail > 0 && performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!options.disabled?.()) options.onTap(event);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick };
}

export const responsiveTapConstants = {
  TAP_SLOP,
  LONG_PRESS_MS,
  CLICK_SUPPRESSION_MS,
} as const;
