export type InterfaceSize = 'compact' | 'normal' | 'large';

export interface VisualPreferences {
  interfaceSize: InterfaceSize;
  highContrast: boolean;
}

export const INTERFACE_SIZE_KEY = 'soundsible:interface-size';
export const HIGH_CONTRAST_KEY = 'soundsible:high-contrast';
export const DEFAULT_INTERFACE_SIZE: InterfaceSize = 'normal';

export function isInterfaceSize(value: unknown): value is InterfaceSize {
  return value === 'compact' || value === 'normal' || value === 'large';
}

export function loadVisualPreferences(storage: Pick<Storage, 'getItem'> = localStorage): VisualPreferences {
  try {
    const storedSize = storage.getItem(INTERFACE_SIZE_KEY);
    return {
      interfaceSize: isInterfaceSize(storedSize) ? storedSize : DEFAULT_INTERFACE_SIZE,
      highContrast: storage.getItem(HIGH_CONTRAST_KEY) === 'true',
    };
  } catch {
    return { interfaceSize: DEFAULT_INTERFACE_SIZE, highContrast: false };
  }
}

export function applyVisualPreferences(preferences: VisualPreferences): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.interfaceSize = preferences.interfaceSize;
  root.dataset.highContrast = preferences.highContrast ? 'true' : 'false';
}

export function persistInterfaceSize(size: InterfaceSize): void {
  try {
    localStorage.setItem(INTERFACE_SIZE_KEY, size);
  } catch {
    /* A private/locked-down browser can still use the setting for this session. */
  }
}

export function persistHighContrast(enabled: boolean): void {
  try {
    localStorage.setItem(HIGH_CONTRAST_KEY, enabled ? 'true' : 'false');
  } catch {
    /* A private/locked-down browser can still use the setting for this session. */
  }
}
