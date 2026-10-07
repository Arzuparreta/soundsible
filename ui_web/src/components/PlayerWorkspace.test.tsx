import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { setMediaQuery } from '../test-setup';
import { PlayerWorkspace } from './PlayerWorkspace';

const panels = ['library', 'stage', 'route'] as const;
const sizes = { library: 200, stage: 200, route: 200 };
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  vi.useFakeTimers(); setMediaQuery('(max-width: 1023px)', true);
  frames = new Map(); let serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++serial; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const panel = this.dataset.playerTile;
    const carousel = this.closest<HTMLElement>('[data-player-carousel]');
    const left = panel ? panels.indexOf(panel as typeof panels[number]) * 200 - (carousel?.scrollLeft ?? 0) : 0;
    return new DOMRect(left, 0, 200, 400);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); setMediaQuery('(max-width: 1023px)', false); });
function workspace() {
  const [panel, select] = createSignal<typeof panels[number]>('stage');
  const view = render(() => <PlayerWorkspace panels={panels} activePanel={panel()} onActivePanelChange={select}
    surfaceOpen layout={{ version: 1, order: [...panels], ratios: { library: 1 / 3, stage: 1 / 3, route: 1 / 3 } }}
    minimums={sizes} defaults={sizes} onLayoutChange={() => {}} panelLabel={value => value}
    ariaLabel="Test panels" dataScope="auto" renderPanel={value => <p>{value}</p>} />);
  const carousel = view.container.querySelector<HTMLElement>('[data-player-carousel]')!;
  Object.defineProperty(carousel, 'scrollTo', { value: (options: ScrollToOptions) => { carousel.scrollLeft = options.left ?? 0; } });
  return { view, carousel, panel, select };
}
it('a stale scroll settle cannot supersede a requested panel before its alignment frame', async () => {
  const { carousel, panel, select, view } = workspace(); await Promise.resolve();
  expect(carousel.scrollLeft).toBe(200);
  fireEvent.scroll(carousel); select('route');
  // Under load, an old scroll event can arrive while the new RAF is still queued.
  fireEvent.scroll(carousel); await vi.advanceTimersByTimeAsync(100);
  expect(panel()).toBe('route');
  expect(view.container.querySelector('[data-player-tile=route]')).not.toHaveAttribute('aria-hidden', 'true');
  for (const [id, callback] of [...frames]) { frames.delete(id); callback(100); }
  fireEvent.scroll(carousel); await vi.advanceTimersByTimeAsync(100);
  expect(carousel.scrollLeft).toBe(400); expect(panel()).toBe('route');
});
it('a real carousel gesture cancels the pending destination and owns the settled panel', async () => {
  const { carousel, panel, select } = workspace(); await Promise.resolve();
  select('route'); fireEvent.pointerDown(carousel);
  carousel.scrollLeft = 0; fireEvent.scroll(carousel); fireEvent.pointerUp(carousel);
  await vi.advanceTimersByTimeAsync(100);
  expect(panel()).toBe('library');
  for (const [id, callback] of [...frames]) { frames.delete(id); callback(100); }
  expect(carousel.scrollLeft).toBe(0);
});
