import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResponsiveTap, responsiveTapConstants } from './responsiveTap';
import { holdGestureConstants } from './holdGesture';

function pointerEvent(
  currentTarget: Element,
  overrides: Partial<PointerEvent> = {},
): PointerEvent {
  return {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: 20,
    clientY: 30,
    target: currentTarget,
    currentTarget,
    ...overrides,
  } as PointerEvent;
}

function mouseEvent(detail: number, currentTarget: Element | null = null): MouseEvent {
  return {
    detail,
    currentTarget,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as MouseEvent;
}

const armed = () => document.documentElement.hasAttribute(holdGestureConstants.ATTRIBUTE);

/** A row with a live text selection across it, as a drag with a mouse leaves. */
function selectedRow(): HTMLElement {
  const row = document.createElement('div');
  row.textContent = 'Una canción con título';
  document.body.append(row);
  const range = document.createRange();
  range.selectNodeContents(row);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return row;
}

afterEach(() => {
  // A long-press candidate claims the platform gesture (lib/holdGesture).
  // Anything a case left open expires on its own failsafe rather than leaking
  // into the next one.
  if (vi.isFakeTimers()) vi.advanceTimersByTime(holdGestureConstants.MAX_HOLD_MS);
  vi.useRealTimers();
  // Same for the guard a handled tap leaves behind (lib/ghostClick): a press
  // ends it, which is how the next case starts on a clean document.
  document.dispatchEvent(new MouseEvent('pointerdown'));
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

/** The click the platform synthesises once it has finished with a touch. */
function compatibilityClick(target: Element): MouseEvent {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    detail: 1,
    clientX: 20,
    clientY: 30,
  });
  target.dispatchEvent(event);
  return event;
}

describe('responsive touch activation', () => {
  it.each(['scroll', 'cancel'])('suppresses the compatibility click after %s without swallowing keyboard activation', (gesture) => {
    const onTap = vi.fn();
    const target = document.createElement('button');
    document.body.append(target);
    const handlers = createResponsiveTap({ onTap });
    target.addEventListener('click', handlers.onClick);
    handlers.onPointerDown(pointerEvent(target));
    if (gesture === 'scroll') {
      handlers.onPointerMove(pointerEvent(target, { clientY: 100 }));
      handlers.onPointerUp(pointerEvent(target));
    } else handlers.onPointerCancel(pointerEvent(target));
    expect(compatibilityClick(target).defaultPrevented).toBe(true);
    expect(onTap).not.toHaveBeenCalled();
    handlers.onClick(mouseEvent(0));
    expect(onTap).toHaveBeenCalledOnce();
  });

  it('activates on touch pointerup, and the click that follows activates nothing', () => {
    const onTap = vi.fn();
    const target = document.createElement('div');
    document.body.append(target);
    const handlers = createResponsiveTap({ onTap });
    target.addEventListener('click', handlers.onClick);

    handlers.onPointerDown(pointerEvent(target));
    handlers.onPointerUp(pointerEvent(target));
    expect(onTap).toHaveBeenCalledTimes(1);

    // Swallowed document-wide rather than by this element: the same touch may
    // by now be pointing at something the activation moved (lib/ghostClick).
    expect(compatibilityClick(target).defaultPrevented).toBe(true);
    expect(onTap).toHaveBeenCalledTimes(1);

    // Keyboard activation carries no pointer, and is never filtered.
    handlers.onClick(mouseEvent(0));
    expect(onTap).toHaveBeenCalledTimes(2);
  });

  it('lets no click through the menu a long press opened either', () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const target = document.createElement('div');
    document.body.append(target);
    const handlers = createResponsiveTap({ onTap, onLongPress: vi.fn() });
    const beneath = vi.fn();
    document.addEventListener('click', beneath);

    handlers.onPointerDown(pointerEvent(target));
    vi.advanceTimersByTime(responsiveTapConstants.LONG_PRESS_MS);
    handlers.onPointerUp(pointerEvent(target));

    // The sheet is under the finger by the time the lift is synthesised.
    expect(compatibilityClick(target).defaultPrevented).toBe(true);
    expect(beneath).not.toHaveBeenCalled();
    document.removeEventListener('click', beneath);
  });

  it('cancels a touch candidate once it becomes a scroll gesture', () => {
    const onTap = vi.fn();
    const target = document.createElement('div');
    const handlers = createResponsiveTap({ onTap });

    handlers.onPointerDown(pointerEvent(target));
    handlers.onPointerMove(
      pointerEvent(target, { clientY: 30 + responsiveTapConstants.TAP_SLOP + 1 }),
    );
    handlers.onPointerUp(pointerEvent(target, { clientY: 50 }));

    expect(onTap).not.toHaveBeenCalled();
  });

  it('cancels horizontal rail swipes as well as vertical scrolling', () => {
    const onTap = vi.fn();
    const target = document.createElement('div');
    const handlers = createResponsiveTap({ onTap });

    handlers.onPointerDown(pointerEvent(target));
    handlers.onPointerMove(
      pointerEvent(target, { clientX: 20 + responsiveTapConstants.TAP_SLOP + 1 }),
    );
    handlers.onPointerUp(pointerEvent(target, { clientX: 50 }));

    expect(onTap).not.toHaveBeenCalled();
  });

  it('clears press feedback on a pan, cancellation and long press without activating', () => {
    vi.useFakeTimers();
    const target = document.createElement('button');
    const onTap = vi.fn();
    const onPressChange = vi.fn();
    const handlers = createResponsiveTap({ onTap, onPressChange, onLongPress: vi.fn() });
    handlers.onPointerDown(pointerEvent(target));
    expect(onPressChange).toHaveBeenLastCalledWith(true);
    handlers.onPointerMove(pointerEvent(target, { clientY: 100 }));
    expect(onPressChange).toHaveBeenLastCalledWith(false);
    handlers.onPointerUp(pointerEvent(target));
    handlers.onPointerDown(pointerEvent(target));
    handlers.onPointerCancel(pointerEvent(target));
    expect(onPressChange).toHaveBeenLastCalledWith(false);
    handlers.onPointerDown(pointerEvent(target));
    vi.advanceTimersByTime(responsiveTapConstants.LONG_PRESS_MS);
    expect(onPressChange).toHaveBeenLastCalledWith(false);
    handlers.onPointerUp(pointerEvent(target));
    expect(onTap).not.toHaveBeenCalled();
  });

  it('drops a candidate when the browser cancels the pointer', () => {
    const onTap = vi.fn();
    const target = document.createElement('div');
    const handlers = createResponsiveTap({ onTap });

    handlers.onPointerDown(pointerEvent(target));
    handlers.onPointerCancel(pointerEvent(target));
    handlers.onPointerUp(pointerEvent(target));

    expect(onTap).not.toHaveBeenCalled();
  });

  it('never activates a disabled candidate', () => {
    const onTap = vi.fn();
    const target = document.createElement('button');
    const handlers = createResponsiveTap({ onTap, disabled: () => true });

    handlers.onPointerDown(pointerEvent(target));
    handlers.onPointerUp(pointerEvent(target));
    handlers.onClick(mouseEvent(0));

    expect(onTap).not.toHaveBeenCalled();
  });

  it('turns a stationary long press into the menu action, never a tap', () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const onLongPress = vi.fn();
    const target = document.createElement('div');
    const handlers = createResponsiveTap({ onTap, onLongPress });

    handlers.onPointerDown(pointerEvent(target));
    vi.advanceTimersByTime(responsiveTapConstants.LONG_PRESS_MS);
    handlers.onPointerUp(pointerEvent(target));

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('owns the platform gesture from the first touch, not from the long press', () => {
    vi.useFakeTimers();
    const target = document.createElement('div');
    const handlers = createResponsiveTap({ onTap: vi.fn(), onLongPress: vi.fn() });

    // Armed on contact: Safari decides what to select at around 500ms, by
    // which time the menu this press opens is already under the finger.
    handlers.onPointerDown(pointerEvent(target));
    expect(armed()).toBe(true);

    vi.advanceTimersByTime(responsiveTapConstants.LONG_PRESS_MS);
    handlers.onPointerUp(pointerEvent(target));
    expect(armed()).toBe(true);

    vi.advanceTimersByTime(holdGestureConstants.RELEASE_TAIL_MS);
    expect(armed()).toBe(false);
  });

  it('hands the gesture back the moment a press becomes a pan', () => {
    vi.useFakeTimers();
    const target = document.createElement('div');
    const handlers = createResponsiveTap({ onTap: vi.fn(), onLongPress: vi.fn() });

    handlers.onPointerDown(pointerEvent(target));
    handlers.onPointerMove(
      pointerEvent(target, { clientY: 30 + responsiveTapConstants.TAP_SLOP + 1 }),
    );

    vi.advanceTimersByTime(holdGestureConstants.RELEASE_TAIL_MS);
    expect(armed()).toBe(false);
  });

  it('never claims the gesture for a candidate with no long press to protect', () => {
    vi.useFakeTimers();
    const target = document.createElement('div');
    const handlers = createResponsiveTap({ onTap: vi.fn() });

    handlers.onPointerDown(pointerEvent(target));

    expect(armed()).toBe(false);
  });

  it('ignores the click that closes a drag-selection inside the row', () => {
    const onTap = vi.fn();
    const row = selectedRow();
    const handlers = createResponsiveTap({ onTap });

    // Dragging across a title to copy it must not also play the song.
    handlers.onClick(mouseEvent(1, row));
    expect(onTap).not.toHaveBeenCalled();

    // Keyboard activation carries no selection of its own and is never filtered.
    handlers.onClick(mouseEvent(0, row));
    expect(onTap).toHaveBeenCalledTimes(1);

    // A plain click: the browser collapsed the selection on mousedown.
    window.getSelection()?.removeAllRanges();
    handlers.onClick(mouseEvent(1, row));
    expect(onTap).toHaveBeenCalledTimes(2);
  });

  it('leaves nested controls to their own activation handler', () => {
    const onTap = vi.fn();
    const row = document.createElement('div');
    const button = document.createElement('button');
    row.append(button);
    const handlers = createResponsiveTap({ onTap });
    const nested = pointerEvent(row, { target: button });

    handlers.onPointerDown(nested);
    handlers.onPointerUp(nested);

    expect(onTap).not.toHaveBeenCalled();
  });
});
