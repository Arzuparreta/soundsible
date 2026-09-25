import { render, screen } from '@solidjs/testing-library';
import { createSignal, Show } from 'solid-js';
import { expect, it, vi } from 'vitest';
import { afterPaint } from './afterPaint';

it('paints feedback before grid work and cancels superseded tabs and unmounts', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++next, callback); return next;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  const tick = () => {
    const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(0));
  };
  const [tab, setTab] = createSignal('artists');
  const mounted = vi.fn();
  const Grid = () => { mounted(); return <p>Grid</p>; };
  const view = render(() => {
    const ready = afterPaint(tab);
    return <Show when={ready()} fallback={<p>Loading</p>}><Grid /></Show>;
  });
  expect(screen.getByText('Loading')).toBeInTheDocument();
  tick();
  expect(mounted).not.toHaveBeenCalled();
  setTab('albums');
  tick();
  expect(mounted).not.toHaveBeenCalled();
  tick();
  expect(screen.getByText('Grid')).toBeInTheDocument();
  setTab('artists');
  view.unmount();
  expect(frames.size).toBe(0);
  vi.restoreAllMocks();
});
