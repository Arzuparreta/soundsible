import { describe, expect, it } from 'vitest';
import { createTopSwipeReveal } from './topSwipeReveal';

describe('top swipe reveal', () => {
  it('tracks a deliberate upward swipe from the top and opens with a short flick', () => {
    const gesture = createTopSwipeReveal();
    gesture.begin(100, 400, 0, true, true);

    expect(gesture.move(101, 394, 16).captured).toBe(false);
    const drag = gesture.move(102, 376, 40);
    expect(drag.captured).toBe(true);
    expect(drag.progress).toBeGreaterThan(0);
    expect(gesture.end(48).open).toBe(true);
  });

  it('does not intercept taps, horizontal gestures, or a list away from its top', () => {
    const tap = createTopSwipeReveal();
    tap.begin(100, 400, 0, true, true);
    expect(tap.end(80).open).toBe(false);

    const horizontal = createTopSwipeReveal();
    horizontal.begin(100, 400, 0, true, true);
    expect(horizontal.move(120, 394, 16).captured).toBe(false);
    expect(horizontal.move(122, 370, 32).captured).toBe(false);
    expect(horizontal.end(40).open).toBe(false);

    const scrolled = createTopSwipeReveal();
    scrolled.begin(100, 400, 0, false, true);
    expect(scrolled.move(100, 350, 16).captured).toBe(false);
    expect(scrolled.end(20).open).toBe(false);
  });

  it('returns an unfinished slow drag to the closed position', () => {
    const gesture = createTopSwipeReveal();
    gesture.begin(100, 400, 0, true, true);
    expect(gesture.move(100, 386, 120).captured).toBe(true);
    expect(gesture.end(220)).toMatchObject({ open: false, progress: 0 });
  });
});
