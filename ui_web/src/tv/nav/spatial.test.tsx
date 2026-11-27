import { cleanup, render } from '@solidjs/testing-library';
import { createSignal, Show } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import { Control } from '../../design/Control';
import { TvFocusProvider, useTvFocus } from './spatial';

afterEach(() => {
  cleanup();
});

function mockRect(el: HTMLElement, left: number, top: number, width = 100, height = 60) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }),
  });
}

describe('TvFocusProvider spatial navigation', () => {
  it('moves Left at shelf start into Rail and Right restores the last card', () => {
    let api!: ReturnType<typeof useTvFocus>;
    render(() => (
      <TvFocusProvider>
        {(() => {
          api = useTvFocus();
          return (
            <div>
              <div data-tv-group-container="tv-rail" data-tv-group-kind="rail" data-tv-group-order="0">
                <Control data-tv-id="rail-home" data-tv-group="tv-rail" data-tv-index="0" data-tv-selected="true">Home</Control>
                <Control data-tv-id="rail-search" data-tv-group="tv-rail" data-tv-index="1">Search</Control>
              </div>
              <div data-tv-group-container="shelf-a" data-tv-group-kind="shelf" data-tv-group-order="10">
                <Control data-tv-id="a0" data-tv-group="shelf-a" data-tv-index="0">A0</Control>
                <Control data-tv-id="a1" data-tv-group="shelf-a" data-tv-index="1">A1</Control>
              </div>
              <div data-tv-group-container="shelf-b" data-tv-group-kind="shelf" data-tv-group-order="20">
                <Control data-tv-id="b0" data-tv-group="shelf-b" data-tv-index="0">B0</Control>
                <Control data-tv-id="b1" data-tv-group="shelf-b" data-tv-index="1">B1</Control>
              </div>
            </div>
          );
        })()}
      </TvFocusProvider>
    ));

    for (const [id, left, top] of [
      ['rail-home', 10, 50],
      ['rail-search', 10, 120],
      ['a0', 200, 50],
      ['a1', 350, 50],
      ['b0', 200, 200],
      ['b1', 350, 200],
    ] as const) {
      mockRect(document.querySelector(`[data-tv-id="${id}"]`) as HTMLElement, left, top);
    }

    expect(api.focusById('a1')).toBe(true);
    expect(api.move('down')).toBe(true);
    // Vertical movement picks closest horizontal column (b1 under a1).
    expect(api.activeId()).toBe('b1');

    expect(api.move('left')).toBe(true);
    expect(api.activeId()).toBe('b0');
    // Left at index 0 enters the Rail (remembering b0).
    expect(api.move('left')).toBe(true);
    expect(api.activeId()).toBe('rail-home');
    expect(api.inRail()).toBe(true);

    // Moving down in Rail reaches rail-search, Right returns to b0.
    expect(api.move('down')).toBe(true);
    expect(api.activeId()).toBe('rail-search');
    expect(api.move('right')).toBe(true);
    expect(api.activeId()).toBe('b0');
  });

  it('traps focus in topmost modal and restores opener when closed, and ignores sub-12px pointer jitter', async () => {
    const [open, setOpen] = createSignal(false);
    let api!: ReturnType<typeof useTvFocus>;

    render(() => (
      <TvFocusProvider>
        {(() => {
          api = useTvFocus();
          return (
            <div>
              <div data-tv-group-container="main" data-tv-group-kind="row" data-tv-group-order="10">
                <Control data-tv-id="opener" data-tv-group="main" data-tv-index="0">Opener</Control>
                <Control data-tv-id="other" data-tv-group="main" data-tv-index="1">Other</Control>
              </div>
              <Show when={open()}>
                <div data-tv-modal="test-modal" data-tv-group-container="modal-btns" data-tv-group-kind="row" data-tv-group-order="1">
                  <Control data-tv-id="m0" data-tv-group="modal-btns" data-tv-index="0">M0</Control>
                  <Control data-tv-id="m1" data-tv-group="modal-btns" data-tv-index="1">M1</Control>
                </div>
              </Show>
            </div>
          );
        })()}
      </TvFocusProvider>
    ));

    for (const id of ['opener', 'other']) {
      mockRect(document.querySelector(`[data-tv-id="${id}"]`) as HTMLElement, id === 'opener' ? 100 : 250, 50);
    }

    expect(api.focusById('opener')).toBe(true);
    // Tiny pointer movement (< 12px) over `other` must not steal focus.
    const otherEl = document.querySelector('[data-tv-id="other"]') as HTMLElement;
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 0, bubbles: true }));
    otherEl.dispatchEvent(new MouseEvent('pointermove', { clientX: 4, clientY: 3, bubbles: true }));
    expect(api.activeId()).toBe('opener');

    // Deliberate pointer movement (>= 12px) transfers focus cleanly and arrows continue from there.
    otherEl.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 20, bubbles: true }));
    expect(api.activeId()).toBe('other');

    setOpen(true);
    mockRect(document.querySelector('[data-tv-id="m0"]') as HTMLElement, 100, 100);
    mockRect(document.querySelector('[data-tv-id="m1"]') as HTMLElement, 220, 100);
    api.pushModal('test-modal', 'm0');
    await Promise.resolve();
    expect(api.activeId()).toBe('m0');
    expect(api.move('right')).toBe(true);
    expect(api.activeId()).toBe('m1');
    // Cannot move out of modal to background controls.
    expect(api.move('right')).toBe(false);
    expect(api.activeId()).toBe('m1');

    setOpen(false);
    api.popModal('test-modal');
    await Promise.resolve();
    expect(api.activeId()).toBe('other');
  });
});
