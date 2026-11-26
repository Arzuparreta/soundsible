const ACTIVATION_SLOP = 7;
const OPEN_DISTANCE = 48;
const COMMIT_PROGRESS = 0.42;
const FLICK_PROGRESS = 0.2;
const FLICK_VELOCITY = 0.24;
const FLICK_WINDOW = 80;

/**
 * Track a pull towards the top of the list, or its reverse on a short list.
 * Scroll distance before the top belongs to the list. Only the remaining
 * finger travel counts towards revealing the controls.
 */
export function createTopSwipeReveal(x: number, y: number, direction: 1 | -1, scrollOffset: number) {
  let tracking = true;
  let captured = false;
  let progress = 0;
  let lastY = y;
  let lastTime = 0;
  let velocity = 0;

  const move = (clientX: number, clientY: number, time: number, atEdge: boolean) => {
    const delta = direction * (clientY - y);
    const across = Math.abs(clientX - x);

    if (!captured) {
      if (delta < -ACTIVATION_SLOP || (across > ACTIVATION_SLOP && across >= Math.abs(delta))) {
        tracking = false;
      }
      if (!tracking || !atEdge || delta - scrollOffset <= ACTIVATION_SLOP || delta <= across * 1.2) {
        return { captured: false, progress };
      }
      captured = true;
    }

    progress = Math.min(1, Math.max(0, (delta - scrollOffset - ACTIVATION_SLOP) / OPEN_DISTANCE));
    if (clientY !== lastY) {
      velocity = lastTime ? direction * (clientY - lastY) / Math.max(1, time - lastTime) : 0;
      lastY = clientY;
      lastTime = time;
    }
    return { captured, progress };
  };

  const commit = (time: number) => captured && (progress >= COMMIT_PROGRESS ||
    (progress >= FLICK_PROGRESS && time - lastTime <= FLICK_WINDOW && velocity >= FLICK_VELOCITY));

  return { move, commit, isTracking: () => tracking, isCaptured: () => captured };
}
