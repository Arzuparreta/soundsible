const ACTIVATION_SLOP = 8;
/** How far the finger travels for each pixel the list gives: the pull drags
 * behind the finger, the way a native list's does. */
const RESISTANCE = 0.5;
export const PULL_ARMED = 56;
const PULL_MAX = 88;

export interface PullFrame {
  captured: boolean;
  /** How far the list has been pulled down, in pixels. */
  distance: number;
  /** Letting go now refreshes. */
  armed: boolean;
}

/**
 * Small, DOM-free state machine for pulling a list down from its top to
 * refresh it. Only a pull that starts with the list at its top and heads
 * downwards is taken; a tap, a horizontal swipe, or a list scrolled away from
 * its top is left to the list.
 */
export function createPullGesture() {
  let tracking = false;
  let captured = false;
  let cancelled = false;
  let startX = 0;
  let startY = 0;
  let distance = 0;

  const frame = (): PullFrame => ({ captured, distance, armed: captured && distance >= PULL_ARMED });

  const begin = (x: number, y: number, atTop: boolean) => {
    tracking = atTop;
    captured = false;
    cancelled = false;
    startX = x;
    startY = y;
    distance = 0;
  };

  const move = (x: number, y: number): PullFrame => {
    if (!tracking || cancelled) return frame();
    const down = y - startY;
    const across = Math.abs(x - startX);
    if (!captured) {
      if (across > ACTIVATION_SLOP && across >= Math.abs(down)) {
        cancelled = true;
        return frame();
      }
      // Upwards first is a scroll into the list: it stays the list's.
      if (down < -ACTIVATION_SLOP) {
        cancelled = true;
        return frame();
      }
      if (down <= ACTIVATION_SLOP || down <= across * 1.2) return frame();
      captured = true;
    }
    distance = Math.min(PULL_MAX, Math.max(0, (down - ACTIVATION_SLOP) * RESISTANCE));
    return frame();
  };

  const end = (): PullFrame & { refresh: boolean } => {
    const result = { ...frame(), refresh: captured && distance >= PULL_ARMED };
    tracking = false;
    captured = false;
    cancelled = false;
    distance = 0;
    return result;
  };

  const cancel = (): PullFrame => {
    const result = { ...frame(), armed: false };
    tracking = false;
    captured = false;
    cancelled = false;
    distance = 0;
    return result;
  };

  return { begin, move, end, cancel };
}

/**
 * Pull-to-refresh on a scrolling list. `onPull` follows the finger (0 once it
 * lets go); `onRefresh` runs when it lets go far enough down. Touch only: a
 * mouse or a trackpad has the refresh button.
 */
export function attachPullToRefresh(
  scroller: HTMLElement,
  handlers: { onPull: (frame: PullFrame) => void; onRefresh: () => void; enabled?: () => boolean },
): () => void {
  const gesture = createPullGesture();
  const onStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) { gesture.cancel(); return; }
    const touch = event.touches[0];
    gesture.begin(touch.clientX, touch.clientY, scroller.scrollTop <= 0 && (handlers.enabled?.() ?? true));
  };
  const onMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      if (gesture.cancel().captured) handlers.onPull({ captured: false, distance: 0, armed: false });
      return;
    }
    const touch = event.touches[0];
    const frame = gesture.move(touch.clientX, touch.clientY);
    if (!frame.captured) return;
    // Taken: the list neither scrolls nor bounces under the pull.
    if (event.cancelable) event.preventDefault();
    handlers.onPull(frame);
  };
  const onEnd = () => {
    const frame = gesture.end();
    if (!frame.captured) return;
    handlers.onPull({ captured: false, distance: 0, armed: false });
    if (frame.refresh) handlers.onRefresh();
  };
  const onCancel = () => {
    if (gesture.cancel().captured) handlers.onPull({ captured: false, distance: 0, armed: false });
  };
  scroller.addEventListener('touchstart', onStart, { passive: true });
  scroller.addEventListener('touchmove', onMove, { passive: false });
  scroller.addEventListener('touchend', onEnd, { passive: true });
  scroller.addEventListener('touchcancel', onCancel, { passive: true });
  return () => {
    scroller.removeEventListener('touchstart', onStart);
    scroller.removeEventListener('touchmove', onMove);
    scroller.removeEventListener('touchend', onEnd);
    scroller.removeEventListener('touchcancel', onCancel);
  };
}
