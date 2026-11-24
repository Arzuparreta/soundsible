import { createEffect, createRoot, onCleanup, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { AutoModeState } from '../lib/generatedQueue';
import { pageVisible } from '../lib/pageVisibility';
import { createQueueEntry, sameQueueSection, type ContextTrack, type PlaybackContextDescriptor } from '../lib/playbackQueue';
import { createRemoteControl, heldPosition, type HeldState, type RemoteKey } from '../lib/remoteControl';
import { prepareRemoteTrack } from '../lib/remotePlayback';
import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { shuffled } from '../lib/shuffle';
import type { AppSocket } from '../lib/socket';
import { isPodcastTrack, podcastEpisodeToTrack } from '../lib/track';
import type { Track } from '../types/music';
import { setControlledPlayback } from './remoteLink';
import type { PlayerActions } from './contracts';
import { state, type PlaybackState, type RepeatMode } from './core';

const MAX_TRACKS = 500;
const REPEAT_ORDER: readonly RepeatMode[] = ['off', 'all', 'one'];

export { deviceName, heldPosition, isControllable, isOnline, type HeldState, type RemoteKey } from '../lib/remoteControl';

/** The web player's controller: lib/remoteControl with this page as the device
 * and its own socket as the watch link. */
export const remoteControl = createRemoteControl({
  selfId: () => state.device.device_id,
  selfName: () => state.device.device_name,
});
const control = remoteControl;
const { held, target, unreachable, pending, sendCommand } = control;

export const {
  devices: remoteDevices,
  devicesFailed: remoteDevicesFailed,
  target: remoteTarget,
  unreachable: remoteUnreachable,
  controlledName,
  can: remoteCan,
  isPending: remotePending,
  applyDeviceState,
  selectTarget,
  refreshDevices,
  retryTarget,
  transferTo,
} = control;
export { sendCommand };

/** Every (re)connect (stores/runtime): the room membership is gone with the old socket. */
export const onRemoteConnect = (): void => control.onConnect();

let attached: AppSocket | null = null;

export function attachRemoteSocket(owned: AppSocket, lifetime: RuntimeLifetime): void {
  control.attach({
    watch: (id, ack) => void owned.emit('watch_device', { device_id: id }, ack),
    unwatch: id => void owned.emit('unwatch_device', { device_id: id }),
  });
  owned.on('device_updated', lifetime.guard(payload => control.deviceUpdated(payload?.device, payload?.server_now_ms)));
  owned.on('device_state', lifetime.guard(payload => applyDeviceState(payload)));
  // The account (or the whole store) is going away: so is whatever it controlled.
  lifetime.own(() => {
    if (attached === owned) resetRemoteState();
  });
  attached = owned;
  if (owned.connected) onRemoteConnect();
}

export function resetRemoteState(): void {
  attached = null;
  control.reset();
}

/** The controlled device in the shapes the player reads. Local-only facts
 * (preview preparation, load retry, autoplay, levelling) have no remote data. */
export function projectPlayback(h: HeldState | null, offline: boolean, volume?: number): Omit<PlaybackState, 'currentTime'> {
  const session = h?.session ?? null, live = h?.live ?? null;
  const fromSession = session && session.queue.length > 0;
  const index = fromSession ? Math.min(Math.max(session.index, 0), session.queue.length - 1) : h?.track ? 0 : -1;
  const queue = fromSession ? session.queue : h?.track ? [createQueueEntry(h.track, 'context', 'single')] : [];
  const currentTrack = queue[index] ?? null;
  const phase = !currentTrack ? 'idle' : offline ? 'paused'
    : live?.phase === 'loading' || live?.phase === 'buffering' || live?.phase === 'playing' ? live.phase
    : h?.isPlaying ? 'playing' : 'paused';
  return {
    currentTrack,
    isPlaying: !offline && Boolean(h?.isPlaying),
    isLoading: phase === 'loading' || phase === 'buffering',
    loadError: false,
    phase,
    previewPreparation: null,
    needsGesture: !offline && live?.phase === 'needs_gesture',
    duration: live?.duration || currentTrack?.duration || 0,
    queue,
    index,
    shuffle: session?.shuffle ?? false,
    repeat: session?.repeat ?? 'off',
    volume: volume ?? live?.volume?.level ?? 1,
    muted: live?.volume?.muted ?? false,
    radioMode: session?.radio.active ?? false,
    radioLoading: false,
    radioSeedId: session?.radio.seedId ?? null,
    autoplayEnabled: false,
    autoplayLoading: false,
    volumeLeveling: false,
    djMixing: live?.dj?.mixing ?? false,
  };
}

export function projectAutoMode(h: HeldState | null): AutoModeState {
  const auto = h?.session?.auto ?? null, dj = h?.live?.dj ?? null;
  const active = h?.live ? dj !== null : h?.session?.mode === 'auto';
  return {
    active,
    profile: auto?.profile ?? state.autoMode.profile,
    sources: auto?.sources ?? [],
    heard: auto?.heard ?? [],
    exploration: auto?.exploration ?? [],
    directionRevision: auto?.directionRevision ?? 0,
    avoidedIdentities: auto?.avoidedIdentities ?? [],
    plan: auto?.plan ?? {},
    staleSeams: auto?.staleSeams ?? [],
    transition: dj ? { status: dj.transition.status, at: dj.transition.at } : { status: 'idle' },
    pendingDirection: dj?.pending_direction ?? false,
    repairing: dj?.repairing ?? false,
    phase: dj?.phase ?? (active ? 'ready' : 'idle'),
    activity: null,
  };
}

const [view, setView] = createStore({
  playback: { ...projectPlayback(null, false), currentTime: 0 } as PlaybackState,
  autoMode: projectAutoMode(null),
});

createRoot(() => {
  createEffect(() => {
    // A shallow merge: readers of a field rerun only when that field changed.
    setView('playback', projectPlayback(held(), unreachable(), pending().get('volume')?.value));
    setView('autoMode', projectAutoMode(held()));
  });
  // A light ticking signal only while the controlled device plays and this page is visible.
  createEffect(() => {
    const h = held(), seek = pending().get('seek')?.value;
    if (!target() || !h) return;
    const tick = () => setView('playback', 'currentTime', seek ?? heldPosition(h, untrack(() => view.playback.duration)));
    tick();
    if (seek !== undefined || !h.isPlaying || unreachable() || !pageVisible()) return;
    const timer = setInterval(tick, 250);
    onCleanup(() => clearInterval(timer));
  });
  createEffect(() => setControlledPlayback(target() ? view.playback : null));
});

export const remotePlayback: PlaybackState = view.playback;
export const remoteAutoMode: AutoModeState = view.autoMode;

const tracksArg = (tracks: readonly ContextTrack[]) => tracks.slice(0, MAX_TRACKS).map(prepareRemoteTrack);
const music = (tracks: readonly Track[]) => tracks.filter(track => !isPodcastTrack(track));
const placeArgs = (tracks: Track[], before?: string) => ({ tracks: tracksArg(music(tracks)), ...(before ? { before_queue_id: before } : {}) });

let volumeBusy = false;
let volumeNext: number | null = null;
/** A volume drag sends one command at a time and then the latest level, not one per input event. */
async function sendVolume(level: number): Promise<void> {
  if (volumeBusy) {
    volumeNext = level;
    control.markPending('volume', level);
    return;
  }
  volumeBusy = true;
  await sendCommand('transport.set_volume', { level }, 'volume', level);
  volumeBusy = false;
  const next = volumeNext;
  volumeNext = null;
  if (next !== null && target()) void sendVolume(next);
}

let remoteActions: { local: PlayerActions; actions: PlayerActions } | null = null;

/** This device's actions with every play, queue and DJ action sent to the
 * controlled device instead (CONTRACT.md: commands). Nothing here starts audio
 * on this device. */
export function remoteActionsFor(local: PlayerActions): PlayerActions {
  if (remoteActions?.local === local) return remoteActions.actions;
  const pb = remotePlayback;
  const send = (name: string, args?: Record<string, unknown>, key?: RemoteKey) => void sendCommand(name, args, key);
  const seek = (position: number) => {
    const at = Math.max(0, pb.duration > 0 ? Math.min(pb.duration, position) : position);
    void sendCommand('transport.seek', { position_sec: at }, 'seek', at);
  };
  const play = (tracks: readonly ContextTrack[], index: number, context?: PlaybackContextDescriptor) => {
    if (!tracks.length) return;
    // The registry takes 500 tracks: keep the window around the chosen one.
    const start = Math.max(0, Math.min(index - 100, tracks.length - MAX_TRACKS));
    send('play.tracks', { tracks: tracksArg(tracks.slice(start)), index: index - start, ...(context ? { context } : {}) }, 'play');
  };
  const dj = async (name: string, tracks: Track[], label: string) =>
    music(tracks).length > 0 && sendCommand(name, { tracks: tracksArg(music(tracks)), label });
  const actions: PlayerActions = {
    ...local,
    togglePlay: () => send(pb.isPlaying ? 'transport.pause' : 'transport.play', {}, 'play'),
    resumePlayback: () => send('transport.play', {}, 'play'),
    pausePlayback: () => send('transport.pause', {}, 'play'),
    dismissPlayback: () => send('transport.pause', {}, 'play'),
    retryCurrent: () => send('transport.play', {}, 'play'),
    next: () => send('transport.next', {}, 'next'),
    autoSkip: async () => { await sendCommand('transport.next', {}, 'next'); },
    prev: () => send('transport.previous', {}, 'prev'),
    seek,
    seekBy: delta => seek(pb.currentTime + delta),
    toggleShuffle: () => send('transport.set_shuffle', { on: !pb.shuffle }, 'shuffle'),
    cycleRepeat: () => send('transport.set_repeat', { mode: REPEAT_ORDER[(REPEAT_ORDER.indexOf(pb.repeat) + 1) % 3] }, 'repeat'),
    toggleMute: () => send('transport.set_muted', { on: !pb.muted }, 'mute'),
    setVolume: level => void sendVolume(Math.max(0, Math.min(1, level))),
    jumpTo: i => { if (pb.queue[i]) send('queue.play_entry', { queue_id: pb.queue[i].queueId }); },
    playQueueEntry: queueId => send('queue.play_entry', { queue_id: queueId }),
    moveInQueue: (from, to) => {
      const moved = pb.queue[from];
      if (!moved || from === to) return;
      // `to` is the index after the move; the command names the entry it lands before.
      const before = pb.queue[to < from ? to : to + 1];
      send('queue.move', { queue_id: moved.queueId, ...(before && sameQueueSection(moved, before) ? { before_queue_id: before.queueId } : {}) });
    },
    removeFromQueue: i => { if (pb.queue[i]) send('queue.remove', { queue_id: pb.queue[i].queueId }); },
    removeQueueEntry: queueId => send('queue.remove', { queue_id: queueId }),
    removeAutoRouteOccurrence: queueId => send('queue.remove', { queue_id: queueId }),
    clearManualQueue: () => void (async () => {
      for (const entry of pb.queue.slice(pb.index + 1).filter(e => e.queueLane === 'manual')) {
        if (!(await sendCommand('queue.remove', { queue_id: entry.queueId }))) return;
      }
    })(),
    playFrom: (tracks, i, opts) => play(tracks, i, opts?.context),
    playTrack: track => play([track], 0),
    playShuffled: (tracks, context) => play(shuffled(tracks), 0, context),
    // Play now keeps the queue, as on this device: line it up next, then skip to it.
    playNow: track => void (async () => {
      if (await sendCommand('queue.add', { track: prepareRemoteTrack(track), at: 'next' })) send('transport.next', {}, 'next');
    })(),
    playEpisode: async (ep, showTitle, feedId, showImage) => play([podcastEpisodeToTrack(ep, showTitle, feedId, showImage)], 0),
    playNext: track => send('queue.add', { track: prepareRemoteTrack(track), at: 'next' }),
    enqueue: track => send('queue.add', { track: prepareRemoteTrack(track), at: 'end' }),
    startRadio: async seed => { await sendCommand('radio.start', { track: prepareRemoteTrack(seed) }); },
    stopRadio: () => send('radio.stop'),
    startDjSelection: (tracks, label) => {
      if (!music(tracks).length) return false;
      void dj('dj.start', tracks, label);
      return true;
    },
    startDjFromTrack: track => dj('dj.start', [track], track.title),
    changeAutoSession: (tracks, label) => dj('dj.change_session', tracks, label),
    // A deferred start is followed by `startDjSelection`, which starts the DJ on the device.
    enterAutoMode: options => {
      if (options?.deferPlanning) return;
      if (options?.source) void dj('dj.start', [options.source], options.source.title);
      else send('dj.start_from_current');
    },
    exitAutoMode: () => send('dj.stop'),
    placeAutoTracks: async (tracks, before) => { if (music(tracks).length) await sendCommand('dj.place', placeArgs(tracks, before)); },
    placeAutoTrack: async (track, before) => { if (music([track]).length) await sendCommand('dj.place', placeArgs([track], before)); },
    addAutoSource: (tracks, label) => void dj('dj.add_source', tracks, label),
    useAutoTrackAsSource: track => void dj('dj.add_source', [track], track.title),
    removeAutoSource: id => send('dj.remove_source', { source_id: id }),
    repairAutoRoute: async () => { await sendCommand('dj.repair'); },
    retryAutoRoute: () => send('dj.repair'),
    promoteInAutoRoute: queueId => send('dj.promote', { queue_id: queueId }),
    avoidAutoTrackForSession: queueId => send('dj.avoid', { queue_id: queueId }),
    moveAutoRoute: (queueId, before) => send('queue.move', { queue_id: queueId, ...(before ? { before_queue_id: before } : {}) }),
    setDjMixing: on => sendCommand('dj.set_mixing', { on }),
  };
  remoteActions = { local, actions };
  return actions;
}
