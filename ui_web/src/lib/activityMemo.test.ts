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

it('reuses cached projections across hide/show cycles when shallow deps are unchanged', () => {
  createRoot(dispose => {
    const [active, setActive] = createSignal(true);
    const [version, setVersion] = createSignal(1);
    const project = vi.fn(() => ({ version: version() }));
    const result = createActivityMemo(active, project, { version: 0 }, () => [version()]);
    const first = result();
    expect(project).toHaveBeenCalledTimes(1);

    setActive(false);
    setActive(true);
    expect(result()).toBe(first);
    expect(project).toHaveBeenCalledTimes(1);

    setActive(false);
    setVersion(2);
    expect(result()).toBe(first);
    expect(project).toHaveBeenCalledTimes(1);

    setActive(true);
    expect(result()).toEqual({ version: 2 });
    expect(project).toHaveBeenCalledTimes(2);
    dispose();
  });
});
