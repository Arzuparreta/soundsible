/**
 * Nearest scrolling ancestor of `target` below `boundary`, or null when there
 * is none.
 *
 * Gestures resolve this once, when the touch starts, and hold on to the answer:
 * walking the ancestors with `getComputedStyle` on every move is a layout read
 * per frame, mid-gesture. What the answer is for is the question every
 * swipe-to-dismiss has to ask before it captures — "is the thing under the
 * finger already scrolled?" — because a list that has been scrolled away from
 * its start owns the drag, not the surface around it.
 */
export function scrollableAncestor(
  target: EventTarget | null,
  boundary?: HTMLElement,
  axis: 'y' | 'x' = 'y',
): HTMLElement | null {
  let element = target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : null;
  while (element && element !== boundary) {
    const style = getComputedStyle(element);
    const overflow = axis === 'y' ? style.overflowY : style.overflowX;
    const scrollable = axis === 'y'
      ? element.scrollHeight > element.clientHeight + 1
      : element.scrollWidth > element.clientWidth + 1;
    if (/(auto|scroll)/.test(overflow) && scrollable) return element;
    element = element.parentElement;
  }
  return null;
}

/** How far this element has travelled along `axis` from its start. */
export function scrollOffset(element: HTMLElement | null, axis: 'y' | 'x' = 'y'): number {
  if (!element) return 0;
  return axis === 'y' ? element.scrollTop : Math.abs(element.scrollLeft);
}
