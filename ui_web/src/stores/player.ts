import type { AutoModeState } from '../lib/generatedQueue';
import type { PlayerActions } from './contracts';
import type { PlaybackState } from './core';
import { actions, state } from './index';

export interface PlayerView {
  readonly playback: PlaybackState;
  readonly autoMode: AutoModeState;
  readonly actions: PlayerActions;
}

const localPlayer: PlayerView = {
  get playback() {
    return state.playback;
  },
  get autoMode() {
    return state.autoMode;
  },
  get actions() {
    return actions;
  },
};

export function player(): PlayerView {
  return localPlayer;
}
