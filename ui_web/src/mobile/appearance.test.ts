import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeAppearance } from './appearance';
let dark = true;
let changed: (() => void) | undefined;
let dispose: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear(); dark = true;
  vi.stubGlobal('matchMedia', () => ({ get matches() { return dark; },
    addEventListener: (_: string, listener: () => void) => { changed = listener; }, removeEventListener: vi.fn() }));
  document.head.innerHTML = '<meta name="theme-color">';
});
afterEach(() => { dispose?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() { const notify = vi.fn(); const preference = createNativeAppearance(notify); dispose = preference.dispose; return { preference, notify }; }
describe('installation appearance independent of engine/account', () => {
  it('rejects obsolete themes and follows system only when selected', () => {
    localStorage.setItem('theme', 'obsolete'); const { preference, notify } = setup();
    expect(preference.theme()).toBe('system'); expect(document.documentElement.dataset.theme).toBe('dark');
    dark = false; changed?.(); expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelector('meta')?.getAttribute('content')).toBe('#f6f6f7');
    preference.setTheme('forest-green'); dark = true; changed?.();
    expect(document.documentElement.dataset.theme).toBe('forest-green'); expect(notify).toHaveBeenLastCalledWith('forest-green');
    expect(localStorage.getItem('theme')).toBe('forest-green');
    preference.setTheme('system'); expect(document.documentElement.dataset.theme).toBe('dark');
  });
  it('restores size/contrast and catches a missed system change on resume', () => {
    localStorage.setItem('soundsible:interface-size', 'large'); localStorage.setItem('soundsible:high-contrast', 'true');
    const { preference, notify } = setup(); expect(preference.interfaceSize()).toBe('large');
    expect(document.documentElement.dataset.highContrast).toBe('true');
    preference.setInterfaceSize('compact'); preference.setHighContrast(false);
    expect(localStorage.getItem('soundsible:interface-size')).toBe('compact');
    expect(localStorage.getItem('soundsible:high-contrast')).toBe('false');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    dark = false; document.dispatchEvent(new Event('visibilitychange')); expect(notify).toHaveBeenLastCalledWith('light');
  });
  it('supports denied storage and detaches resume notifications on disposal', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { preference, notify } = setup(); preference.setTheme('slate'); preference.setInterfaceSize('large'); preference.setHighContrast(true);
    expect(document.documentElement.dataset.theme).toBe('slate'); expect(document.documentElement.dataset.interfaceSize).toBe('large');
    preference.dispose(); notify.mockClear(); document.dispatchEvent(new Event('visibilitychange')); expect(notify).not.toHaveBeenCalled();
  });
});
