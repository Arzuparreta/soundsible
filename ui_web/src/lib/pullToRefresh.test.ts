import { describe, expect, it, vi } from 'vitest';
import { attachPullToRefresh, createPullGesture, PULL_ARMED } from './pullToRefresh';

describe('pull to refresh', () => {
  it('refreshes once a pull from the top goes far enough down', () => {
    const gesture = createPullGesture();
    gesture.begin(100, 200, true);
    expect(gesture.move(101, 205).captured).toBe(false);
    const short = gesture.move(102, 260);
    expect(short.captured).toBe(true);
    expect(short.armed).toBe(false);
    expect(gesture.move(102, 200 + 8 + PULL_ARMED * 2).armed).toBe(true);
    expect(gesture.end().refresh).toBe(true);
  });

  it('lets a short pull go without refreshing', () => {
    const gesture = createPullGesture();
    gesture.begin(100, 200, true);
    gesture.move(100, 240);
    expect(gesture.end().refresh).toBe(false);
  });

  it('leaves taps, sideways swipes, upward scrolls and a scrolled list to the list', () => {
    const tap = createPullGesture();
    tap.begin(100, 200, true);
    expect(tap.end()).toMatchObject({ captured: false, refresh: false });

    const sideways = createPullGesture();
    sideways.begin(100, 200, true);
    expect(sideways.move(130, 205).captured).toBe(false);
    expect(sideways.move(135, 400).captured).toBe(false);

    const upwards = createPullGesture();
    upwards.begin(100, 400, true);
    expect(upwards.move(100, 380).captured).toBe(false);
    expect(upwards.move(100, 600).captured).toBe(false);

    const scrolled = createPullGesture();
    scrolled.begin(100, 200, false);
    expect(scrolled.move(100, 400).captured).toBe(false);
    expect(scrolled.end().refresh).toBe(false);
  });

  it('stops the list scrolling under a pull and reports it closed when let go', () => {
    const scroller = document.createElement('div');
    const onPull = vi.fn();
    const onRefresh = vi.fn();
    const detach = attachPullToRefresh(scroller, { onPull, onRefresh });
    const touch = (type: string, y: number) => {
      const event = new Event(type, { cancelable: true }) as TouchEvent;
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: 50, clientY: y }] });
      scroller.dispatchEvent(event);
      return event;
    };
    touch('touchstart', 100);
    touch('touchmove', 120);
    const pulled = touch('touchmove', 100 + 8 + PULL_ARMED * 2 + 10);
    expect(pulled.defaultPrevented).toBe(true);
    expect(onPull).toHaveBeenLastCalledWith(expect.objectContaining({ captured: true, armed: true }));
    touch('touchend', 0);
    expect(onPull).toHaveBeenLastCalledWith({ captured: false, distance: 0, armed: false });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    detach();
    touch('touchstart', 100);
    touch('touchmove', 400);
    touch('touchend', 0);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
