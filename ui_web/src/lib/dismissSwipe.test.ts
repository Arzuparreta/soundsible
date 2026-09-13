import { describe, expect, it } from 'vitest';
import { createDismissSwipe, dismissExitTiming, dismissSwipeConstants } from './dismissSwipe';

const armed = { enabled: true, scrolled: false };

describe('dismiss swipe', () => {
  it('claims a downward drag almost immediately and commits past the threshold', () => {
    const gesture = createDismissSwipe('down');
    gesture.begin(200, 300, 0, armed);

    // Under the activation distance the sheet has not taken the gesture yet.
    expect(gesture.move(200, 301, 8).captured).toBe(false);
    const claimed = gesture.move(200, 306, 16);
    expect(claimed.captured).toBe(true);
    expect(claimed.offset).toBe(6);

    gesture.move(200, 390, 120);
    const release = gesture.end(130);
    expect(release.dismiss).toBe(true);
    expect(release.offset).toBe(90);
  });

  it('dismisses on a short flick that was fast enough to mean it', () => {
    const gesture = createDismissSwipe('down');
    gesture.begin(0, 0, 0, armed);
    gesture.move(0, 8, 10);
    gesture.move(0, 40, 40);
    const release = gesture.end(42);
    expect(release.offset).toBeLessThan(dismissSwipeConstants.DISTANCE);
    expect(release.velocity).toBeGreaterThan(dismissSwipeConstants.FLICK_VELOCITY);
    expect(release.dismiss).toBe(true);
  });

  it('keeps a slow short drag, a tap and an upward drag', () => {
    const slow = createDismissSwipe('down');
    slow.begin(0, 0, 0, armed);
    slow.move(0, 8, 100);
    slow.move(0, 40, 800);
    expect(slow.end(810).dismiss).toBe(false);

    const tap = createDismissSwipe('down');
    tap.begin(0, 0, 0, armed);
    expect(tap.end(90).dismiss).toBe(false);

    const upward = createDismissSwipe('down');
    upward.begin(0, 300, 0, armed);
    expect(upward.move(0, 280, 16).captured).toBe(false);
    // Having refused the gesture it stays refused, even if the finger comes back.
    expect(upward.move(0, 400, 32).captured).toBe(false);
    expect(upward.end(40).dismiss).toBe(false);
  });

  it('hands a sideways drag back to whatever is under the finger', () => {
    const gesture = createDismissSwipe('down');
    gesture.begin(100, 100, 0, armed);
    expect(gesture.move(112, 104, 16).captured).toBe(false);
    expect(gesture.move(112, 200, 32).captured).toBe(false);
    expect(gesture.end(40).dismiss).toBe(false);
  });

  it('never captures inside a scroller that has already moved, or when disabled', () => {
    const scrolled = createDismissSwipe('down');
    scrolled.begin(0, 0, 0, { enabled: true, scrolled: true });
    expect(scrolled.move(0, 120, 60).captured).toBe(false);
    expect(scrolled.end(70).dismiss).toBe(false);

    const disabled = createDismissSwipe('down');
    disabled.begin(0, 0, 0, { enabled: false, scrolled: false });
    expect(disabled.move(0, 120, 60).captured).toBe(false);
    expect(disabled.end(70).dismiss).toBe(false);
  });

  it('measures the left drawer along its own axis, and only leftwards', () => {
    const gesture = createDismissSwipe('left');
    gesture.begin(300, 400, 0, armed);
    const claimed = gesture.move(292, 402, 16);
    expect(claimed.captured).toBe(true);
    expect(claimed.offset).toBe(8);
    gesture.move(200, 404, 90);
    expect(gesture.end(100).dismiss).toBe(true);

    // Dragging the drawer further open is not dismissing it.
    const rightwards = createDismissSwipe('left');
    rightwards.begin(300, 400, 0, armed);
    expect(rightwards.move(360, 400, 20).captured).toBe(false);
    expect(rightwards.end(30).dismiss).toBe(false);
  });

  it('forgets everything on cancel', () => {
    const gesture = createDismissSwipe('down');
    gesture.begin(0, 0, 0, armed);
    gesture.move(0, 90, 40);
    expect(gesture.cancel()).toEqual({ captured: true, offset: 0 });
    expect(gesture.move(0, 200, 80).captured).toBe(false);
    expect(gesture.end(90).dismiss).toBe(false);
  });
});

describe('dismiss exit timing', () => {
  it('only animates the travel that is left', () => {
    const full = dismissExitTiming(0, 400, 0);
    const half = dismissExitTiming(200, 400, 0);
    expect(full.from).toBe(0);
    expect(full.duration).toBe(dismissSwipeConstants.EXIT_DURATION);
    expect(half.duration).toBeLessThan(full.duration);
  });

  it('keeps the speed the gesture had, and never finishes in a single frame', () => {
    const flicked = dismissExitTiming(100, 400, 4);
    expect(flicked.duration).toBe(dismissSwipeConstants.EXIT_DURATION_MIN);

    const nearlyGone = dismissExitTiming(396, 400, 0);
    expect(nearlyGone.duration).toBe(dismissSwipeConstants.EXIT_DURATION_MIN);
  });

  it('clamps an offset past the edge instead of overshooting', () => {
    expect(dismissExitTiming(900, 400, 0).from).toBe(400);
  });
});
