import { createEffect, createRoot, createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPageVisibility, pageVisible } from './pageVisibility';

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); vi.restoreAllMocks(); });

describe('presentation visibility', () => {
  it('keeps visible unfocused windows active and catches up after hiding', () => {
    let visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    stop = installPageVisibility();
    window.dispatchEvent(new Event('blur'));
    expect(pageVisible()).toBe(true);
    expect(document.documentElement).not.toHaveAttribute('data-page-hidden');
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pageVisible()).toBe(false);
    expect(document.documentElement).toHaveAttribute('data-page-hidden');
    window.dispatchEvent(new Event('focus'));
    expect(pageVisible()).toBe(false);
    visibility = 'visible';
    window.dispatchEvent(new Event('pageshow'));
    expect(pageVisible()).toBe(true);
    stop();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pageVisible()).toBe(true);
  });

  it('lets presentation unsubscribe while the underlying clock continues', async () => {
    let visibility = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    stop = installPageVisibility();
    const [clock, setClock] = createSignal(0);
    const paint = vi.fn();
    const dispose = createRoot(dispose => {
      createEffect(() => { if (pageVisible()) paint(clock()); });
      return dispose;
    });
    try {
      await Promise.resolve();
      setClock(10);
      expect(paint).not.toHaveBeenCalled();
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(paint).toHaveBeenLastCalledWith(10);
    } finally { dispose(); }
  });
});
