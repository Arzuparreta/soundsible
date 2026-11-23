import type { AutoModeState } from '../lib/generatedQueue';
import type { PlayerActions } from './contracts';
import type { PlaybackState } from './core';
import { actions, state } from './index';
import type { RemoteKey } from './remote';
import { remoteStore } from './remoteLink';
import { withDjErrand } from '../lib/djErrand';

export interface PlayerView {
  readonly playback: PlaybackState;
  readonly autoMode: AutoModeState;
  readonly actions: PlayerActions;
  /** Another device is controlled: `playback`, `autoMode` and `actions` are its. */
  readonly remote: boolean;
  readonly unreachable: boolean;
  readonly deviceName: string;
  /** Whether the shown device declares an optional command (volume, mute, …). */
  can(command: string): boolean;
  /** A command for this control is in flight. */
  pending(key: RemoteKey): boolean;
}

const localPlayer: PlayerView = {
  get playback() {
    return state.playback;
  },
  get autoMode() {
    return state.autoMode;
  },
  // What the interface asks of the player answers an open DJ errand first.
  get actions() {
    return withDjErrand(actions);
  },
  remote: false,
  unreachable: false,
  get deviceName() {
    return state.device.device_name;
  },
  can: () => true,
  pending: () => false,
};

let remotePlayer: PlayerView | null = null;

export function player(): PlayerView {
  const m = remoteStore();
  if (!m?.remoteTarget()) return localPlayer;
  return remotePlayer ??= {
    playback: m.remotePlayback,
    autoMode: m.remoteAutoMode,
    get actions() {
      return withDjErrand(m.remoteActionsFor(actions));
    },
    remote: true,
    get unreachable() {
      return m.remoteUnreachable();
    },
    get deviceName() {
      return m.controlledName();
    },
    can: m.remoteCan,
    pending: m.remotePending,
  };
}
