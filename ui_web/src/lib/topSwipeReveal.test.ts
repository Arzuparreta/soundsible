import { describe, expect, it } from 'vitest';
import { createTopSwipeReveal } from './topSwipeReveal';

describe('top swipe reveal', () => {
  it('follows the pull and opens with a short deliberate flick', () => {
    const gesture = createTopSwipeReveal(100, 400, 1, 0);
    expect(gesture.move(101, 406, 16, true).captured).toBe(false);
    expect(gesture.move(102, 412, 24, true)).toMatchObject({ captured: true });
    expect(gesture.move(102, 425, 40, true).progress).toBeCloseTo(0.375);
    expect(gesture.commit(48)).toBe(true);
  });

  it('uses only the drag beyond the top when the list started scrolled', () => {
    const gesture = createTopSwipeReveal(100, 400, 1, 70);
    expect(gesture.move(100, 480, 80, false).captured).toBe(false);
    expect(gesture.move(100, 480, 96, true).progress).toBeCloseTo(3 / 48);
    expect(gesture.move(100, 500, 112, true).progress).toBeCloseTo(23 / 48);
    expect(gesture.commit(300)).toBe(true);
  });

  it('leaves taps, sideways drags and swipes into the list alone', () => {
    const tap = createTopSwipeReveal(100, 400, 1, 0);
    expect(tap.commit(80)).toBe(false);

    const sideways = createTopSwipeReveal(100, 400, 1, 0);
    expect(sideways.move(120, 406, 16, true).captured).toBe(false);
    expect(sideways.isTracking()).toBe(false);
    expect(sideways.move(122, 445, 32, true).captured).toBe(false);

    const upward = createTopSwipeReveal(100, 400, 1, 0);
    expect(upward.move(100, 360, 24, true).captured).toBe(false);
    expect(upward.isTracking()).toBe(false);
  });

  it('settles closed after a pause or reversal before the reveal threshold', () => {
    const held = createTopSwipeReveal(100, 400, 1, 0);
    held.move(100, 412, 16, true);
    held.move(100, 425, 32, true);
    expect(held.commit(140)).toBe(false);

    const reversed = createTopSwipeReveal(100, 400, 1, 0);
    reversed.move(100, 460, 24, true);
    expect(reversed.move(100, 424, 48, true).progress).toBeCloseTo(17 / 48);
    expect(reversed.commit(55)).toBe(false);
  });

  it('supports the reverse drag to dismiss search on a short list', () => {
    const gesture = createTopSwipeReveal(100, 400, -1, 0);
    expect(gesture.move(100, 366, 32, true).progress).toBeCloseTo(27 / 48);
    expect(gesture.commit(100)).toBe(true);
  });
});
