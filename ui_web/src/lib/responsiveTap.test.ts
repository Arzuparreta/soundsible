import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResponsiveTap, responsiveTapConstants } from './responsiveTap';

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

function mouseEvent(detail: number): MouseEvent {
  return {
    detail,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as MouseEvent;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('responsive touch activation', () => {
  it('activates on touch pointerup and suppresses the compatibility click', () => {
    const onTap = vi.fn();
    const target = document.createElement('div');
    const handlers = createResponsiveTap({ onTap });

    handlers.onPointerDown(pointerEvent(target));
    handlers.onPointerUp(pointerEvent(target));
    expect(onTap).toHaveBeenCalledTimes(1);

    const compatibilityClick = mouseEvent(1);
    handlers.onClick(compatibilityClick);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(compatibilityClick.preventDefault).toHaveBeenCalled();

    handlers.onClick(mouseEvent(0));
    expect(onTap).toHaveBeenCalledTimes(2);
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
