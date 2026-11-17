/** Only a gesture that can still claim the touch needs to block scrolling.
 * Arm synchronously from touchstart, before the first move; release as soon as
 * the gesture belongs to native scrolling, or on end/cancel/disposal. */
export function createTouchMoveLease(target: HTMLElement, move: (event: TouchEvent) => void) {
  let armed = false;
  return {
    arm() {
      if (armed) return;
      armed = true;
      target.addEventListener('touchmove', move, { passive: false });
    },
    release() {
      if (!armed) return;
      armed = false;
      target.removeEventListener('touchmove', move);
    },
  };
}
