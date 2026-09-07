import { afterEach, describe, expect, it, vi } from 'vitest';
import { ghostClickConstants, shieldGhostClicks } from './ghostClick';

/** An element that counts what the platform hands it. */
function listener() {
  const seen = vi.fn();
  const element = document.createElement('button');
  document.body.append(element);
  element.addEventListener('click', seen);
  element.addEventListener('mousedown', seen);
  return { element, seen };
}

function fire(element: Element, type: string, detail = 1): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, detail });
  element.dispatchEvent(event);
  return event;
}

afterEach(() => {
  // A press is the one thing that always ends a guard, so it is also how a
  // case hands the next one a clean document.
  document.dispatchEvent(new MouseEvent('pointerdown'));
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the click a touch leaves behind', () => {
  it('never reaches whatever moved under the finger', () => {
    const { element, seen } = listener();
    shieldGhostClicks();

    const down = fire(element, 'mousedown');
    const click = fire(element, 'click');

    expect(seen).not.toHaveBeenCalled();
    expect(down.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
  });

  it('is one click: the next one is the user asking for something', () => {
    const { element, seen } = listener();
    shieldGhostClicks();

    fire(element, 'click');
    fire(element, 'click');

    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('never eats keyboard activation, which reports no pointer at all', () => {
    const { element, seen } = listener();
    shieldGhostClicks();

    fire(element, 'click', 0);

    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('stops waiting once the platform has clearly not sent it', () => {
    vi.useFakeTimers();
    const { element, seen } = listener();
    shieldGhostClicks();

    vi.advanceTimersByTime(ghostClickConstants.WINDOW_MS);
    fire(element, 'click');

    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('gets out of the way of a second press, however quickly it follows', () => {
    const { element, seen } = listener();
    shieldGhostClicks();

    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    fire(element, 'click');

    expect(seen).toHaveBeenCalledTimes(1);
  });
});
