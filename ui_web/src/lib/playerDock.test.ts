import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./shellLayout', () => ({ desktopShell: () => true }));

function resize(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('the docked player column', () => {
  it('stays between its own bounds and half the window', async () => {
    const { clampDockWidth, maxDockWidth, DOCK_WIDTH } = await import('./playerDock');
    expect(maxDockWidth(1366)).toBe(683);
    expect(maxDockWidth(2560)).toBe(DOCK_WIDTH.max);
    expect(maxDockWidth(600)).toBe(DOCK_WIDTH.min);
    expect(clampDockWidth(100, 1366)).toBe(DOCK_WIDTH.min);
    expect(clampDockWidth(900, 1366)).toBe(683);
    expect(clampDockWidth(Number.NaN, 1366)).toBe(DOCK_WIDTH.default);
  });

  it('keeps the chosen width through a narrower window', async () => {
    resize(1600);
    const dock = await import('./playerDock');
    dock.setPlayerDockWidth(700);
    expect(dock.playerDockWidth()).toBe(700);
    resize(1000);
    expect(dock.playerDockWidth()).toBe(500);
    expect(dock.playerDockMaxWidth()).toBe(500);
    resize(1600);
    expect(dock.playerDockWidth()).toBe(700);
    expect(localStorage.getItem('player:dockWidth:v1')).toBe('700');
  });

  it('docks by default, starts compact docked, and remembers full screen', async () => {
    resize(1600);
    let dock = await import('./playerDock');
    expect(dock.playerPresentation()).toBe('docked');
    expect(dock.playerDocked()).toBe(true);
    expect(dock.playerCompact()).toBe(true);
    dock.setPlayerPresentation('full');
    vi.resetModules();
    dock = await import('./playerDock');
    expect(dock.playerPresentation()).toBe('full');
    expect(dock.playerCompact()).toBe(false);
  });
});
