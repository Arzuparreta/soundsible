const ACTIVATION_SLOP = 7;
const OPEN_DISTANCE = 38;
const COMMIT_PROGRESS = 0.42;
const FLICK_VELOCITY = 0.24;

export interface SwipeRevealFrame {
  captured: boolean;
  progress: number;
}

/**
 * Small, DOM-free state machine for Library's concealed mobile controls.
 *
 * The first gesture towards the top of the library is consumed by the controls
 * instead of overscrolling the first song. Touch coordinates move down while
 * the scroll position is being pushed back towards zero. Horizontal/diagonal
 * gestures and taps are deliberately rejected so row actions stay predictable.
 */
export function createTopSwipeReveal() {
  let tracking = false;
  let captured = false;
  let cancelled = false;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let lastY = 0;
  let lastTime = 0;
  let progress = 0;

  const begin = (x: number, y: number, time: number, atTop: boolean, enabled: boolean) => {
    tracking = atTop && enabled;
    captured = false;
    cancelled = false;
    startX = x;
    startY = y;
    startTime = time;
    lastY = y;
    lastTime = time;
    progress = 0;
  };

  const move = (x: number, y: number, time: number): SwipeRevealFrame => {
    if (!tracking || cancelled) return { captured: false, progress };

    const revealDelta = y - startY;
    const horizontal = Math.abs(x - startX);

    if (!captured) {
      if (horizontal > ACTIVATION_SLOP && horizontal >= Math.abs(revealDelta)) {
        cancelled = true;
        return { captured: false, progress };
      }
      if (revealDelta <= ACTIVATION_SLOP || revealDelta <= horizontal * 1.2) {
        return { captured: false, progress };
      }
      captured = true;
    }

    progress = Math.min(1, Math.max(0, (revealDelta - ACTIVATION_SLOP) / OPEN_DISTANCE));
    lastY = y;
    lastTime = time;
    return { captured, progress };
  };

  const end = (time: number): SwipeRevealFrame & { open: boolean } => {
    const duration = Math.max(1, time - Math.max(startTime, lastTime - 80));
    const velocity = captured ? Math.max(0, (lastY - startY) / duration) : 0;
    const open = captured && (progress >= COMMIT_PROGRESS || velocity >= FLICK_VELOCITY);
    const result = { captured, progress: open ? 1 : 0, open };
    tracking = false;
    captured = false;
    cancelled = false;
    progress = result.progress;
    return result;
  };

  const cancel = () => {
    const wasCaptured = captured;
    tracking = false;
    captured = false;
    cancelled = false;
    progress = 0;
    return { captured: wasCaptured, progress: 0 };
  };

  return { begin, move, end, cancel };
}
