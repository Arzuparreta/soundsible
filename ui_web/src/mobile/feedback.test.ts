import { afterEach, expect, it, vi } from 'vitest';
import { createNativeFeedback } from './feedback';
import { vibrate } from '../lib/haptics';
afterEach(() => { localStorage.removeItem('haptics'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('uses native feedback once and suppresses it after the installation preference changes', async () => {
  const pulse = vi.fn().mockResolvedValue({ accepted: false });
  const state = createNativeFeedback(pulse);
  try {
    vibrate(); expect(pulse).toHaveBeenLastCalledWith('tap');
    state.setEnabled(false); vibrate(50); expect(pulse).toHaveBeenCalledTimes(1);
    state.setEnabled(true); vibrate(50); expect(pulse).toHaveBeenLastCalledWith('hold');
    expect(localStorage.getItem('haptics')).toBe('on');
  } finally { state.dispose(); }
});
it('restores the disabled preference on recreation and contains platform failures', async () => {
  localStorage.setItem('haptics', 'off');
  const pulse = vi.fn().mockRejectedValue(new Error('Unsupported device'));
  const state = createNativeFeedback(pulse);
  try {
    expect(state.enabled()).toBe(false); vibrate(); expect(pulse).not.toHaveBeenCalled();
    state.setEnabled(true); vibrate(); await Promise.resolve(); expect(pulse).toHaveBeenCalledOnce();
  } finally { state.dispose(); }
});

it('returns to the browser transport when disposed and honours session preferences if storage is blocked', () => {
  const browser = vi.fn(), pulse = vi.fn().mockResolvedValue({ accepted: false });
  vi.stubGlobal('navigator', { vibrate: browser });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked storage'); });
  const state = createNativeFeedback(pulse);
  try {
    state.setEnabled(false); vibrate(); expect(pulse).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
    state.setEnabled(true); vibrate(); expect(pulse).toHaveBeenCalledOnce(); expect(browser).not.toHaveBeenCalled();
  } finally { state.dispose(); }
  vibrate(); expect(browser).toHaveBeenCalledWith(10); expect(pulse).toHaveBeenCalledOnce();
});
