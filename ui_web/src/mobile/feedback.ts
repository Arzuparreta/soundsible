import { createSignal } from 'solid-js';
import { registerPlugin } from '@capacitor/core';
import { installHapticTransport } from '../lib/haptics';
interface FeedbackBridge { pulse(options: { kind: 'tap' | 'hold' }): Promise<{ accepted: boolean }> }
const feedback = registerPlugin<FeedbackBridge>('SoundsibleFeedback');

/** Installation preference, independent of the engine account and playback. */
export function createNativeFeedback(pulse = (kind: 'tap' | 'hold') => feedback.pulse({ kind })) {
  let stored = true;
  try { stored = localStorage.getItem('haptics') !== 'off'; } catch { /* Session preference remains available. */ }
  const [enabled, update] = createSignal(stored);
  const dispose = installHapticTransport(ms => { if (enabled()) void pulse(ms >= 30 ? 'hold' : 'tap').catch(() => {}); });
  return { enabled, setEnabled(value: boolean) {
    update(value); try { localStorage.setItem('haptics', value ? 'on' : 'off'); } catch { /* Session only. */ }
  }, dispose };
}
