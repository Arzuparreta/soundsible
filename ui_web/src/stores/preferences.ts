import { setState, type Theme } from "./core";
import { announceTheme, applyTheme } from "./theme";

/** Local preferences need neither a runtime owner nor cross-domain ports. */
export const preferenceActions = {
  setDeviceName(name: string): void {
    setState('device', 'device_name', name);
    localStorage.setItem('device_name', name);
  },
  setTheme(theme: Theme): void {
    setState('theme', theme);
    localStorage.setItem('theme', theme);
    applyTheme(theme);
    announceTheme(theme);
  },
  setHaptics(on: boolean): void {
    setState('haptics', on);
    localStorage.setItem('haptics', on ? 'on' : 'off');
  }
};
