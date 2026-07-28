import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyVisualPreferences,
  DEFAULT_INTERFACE_SIZE,
  HIGH_CONTRAST_KEY,
  INTERFACE_SIZE_KEY,
  loadVisualPreferences,
} from './visualPreferences';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.interfaceSize;
  delete document.documentElement.dataset.highContrast;
});

describe('visual accessibility preferences', () => {
  it('makes Normal the default for existing devices without a stored value', () => {
    expect(loadVisualPreferences()).toEqual({
      interfaceSize: DEFAULT_INTERFACE_SIZE,
      highContrast: false,
    });
    expect(DEFAULT_INTERFACE_SIZE).toBe('normal');
  });

  it('preserves an explicit Compact choice and enhanced contrast', () => {
    localStorage.setItem(INTERFACE_SIZE_KEY, 'compact');
    localStorage.setItem(HIGH_CONTRAST_KEY, 'true');

    expect(loadVisualPreferences()).toEqual({
      interfaceSize: 'compact',
      highContrast: true,
    });
  });

  it('rejects corrupt size values instead of painting an undefined recipe', () => {
    localStorage.setItem(INTERFACE_SIZE_KEY, 'gigantic');
    expect(loadVisualPreferences().interfaceSize).toBe('normal');
  });

  it('applies both preferences to the root before the app renders', () => {
    applyVisualPreferences({ interfaceSize: 'large', highContrast: true });
    expect(document.documentElement.dataset.interfaceSize).toBe('large');
    expect(document.documentElement.dataset.highContrast).toBe('true');
  });
});
