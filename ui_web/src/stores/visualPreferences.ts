import { state, setState } from './core';
import { applyVisualPreferences, persistInterfaceSize, persistHighContrast, type InterfaceSize } from '../lib/visualPreferences';
export const visualPreferenceActions = {
  setInterfaceSize(interfaceSize: InterfaceSize): void {
    setState('interfaceSize', interfaceSize);
    persistInterfaceSize(interfaceSize);
    applyVisualPreferences({
      interfaceSize,
      highContrast: state.highContrast
    });
  },
  setHighContrast(highContrast: boolean): void {
    setState('highContrast', highContrast);
    persistHighContrast(highContrast);
    applyVisualPreferences({
      interfaceSize: state.interfaceSize,
      highContrast
    });
  }
};
