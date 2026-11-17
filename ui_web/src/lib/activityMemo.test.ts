import { createRoot, createSignal } from 'solid-js';
import { expect, it, vi } from 'vitest';
import { createActivityMemo } from './activityMemo';

it('retains the mounted projection, ignores hidden updates and catches up on activation', () => {
  createRoot(dispose => {
    const [active, setActive] = createSignal(true);
    const [value, setValue] = createSignal(1);
    const project = vi.fn(() => [value()]);
    const result = createActivityMemo(active, project, []);
    const first = result();
    setActive(false);
    setValue(2);
    setValue(3);
    expect(result()).toBe(first);
    expect(project).toHaveBeenCalledTimes(1);
    setActive(true);
    expect(result()).toEqual([3]);
    expect(project).toHaveBeenCalledTimes(2);
    dispose();
  });
});
