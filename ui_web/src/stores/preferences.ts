

import { setState, type Theme } from "./core";
import { announceTheme, applyTheme } from "./theme";

export interface PreferencesPorts {

}

/** Owns preferences behaviour; cross-domain work enters through explicit ports. */
export function createPreferences(_ports: PreferencesPorts) {

const domainActions = {
setDeviceName(name: string): void {
    setState('device', 'device_name', name);
    localStorage.setItem('device_name', name);
  },
setTheme(theme: Theme): void {
    setState('theme', theme);
    localStorage.setItem('theme', theme);
    applyTheme(theme, true);
    announceTheme(theme);
  },
setHaptics(on: boolean): void {
    setState('haptics', on);
    localStorage.setItem('haptics', on ? 'on' : 'off');
  }
};
return { actions: domainActions,  };
}
