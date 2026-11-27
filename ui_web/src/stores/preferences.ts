import { batch } from "solid-js";
import { state, setState, type Theme } from "./core";
import { isTheme } from "../boot/themes";
import { persistTheme, type CustomColors } from "../lib/colorPreferences";
import { announceTheme, applyTheme } from "./theme";

/** Local preferences need neither a runtime owner nor cross-domain ports. */
let deviceNameChangeListener: (() => void) | null = null;

/** Subscribe to runtime device rename updates so active sessions re-register. */
export function setDeviceNameChangeListener(listener: (() => void) | null): void {
  deviceNameChangeListener = listener;
}

export const preferenceActions = {
  setDeviceName(name: string): void {
    setState('device', 'device_name', name);
    localStorage.setItem('device_name', name);
    deviceNameChangeListener?.();
  },
  setTheme(theme: Theme, colors: CustomColors = state.customColors, persist = true): void {
    if (!isTheme(theme)) return;
    batch(() => {
      setState('theme', theme);
      setState('customColors', colors);
    });
    if (persist) persistTheme(theme, colors);
    applyTheme(theme, theme !== 'custom');
    announceTheme(theme);
  },
  setHaptics(on: boolean): void {
    setState('haptics', on);
    localStorage.setItem('haptics', on ? 'on' : 'off');
  }
};
