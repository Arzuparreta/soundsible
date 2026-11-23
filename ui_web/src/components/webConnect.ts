import { state } from '../stores';
import { remoteControl } from '../stores/remote';
import { openConnectSheet, type ConnectSelf } from './ConnectSheet';

/** This browser in the device sheet: its local playback, whatever the player shows. */
export const webConnectSelf: ConnectSelf = {
  get name() { return state.device.device_name; },
  get formFactor() { return state.device.form_factor; },
  get deviceType() { return state.device.device_type; },
  track: () => state.playback.currentTrack,
  playing: () => state.playback.isPlaying,
};

/** The web player's device sheet, loaded on use with the controller it shows. */
export const openWebConnectSheet = () => openConnectSheet(remoteControl, webConnectSelf);
