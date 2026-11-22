import { createEffect, createRoot, createSignal, onCleanup, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import { api, type Device, type DeviceCommandAnswer, type LivePlaybackState } from '../lib/api';
import type { AutoModeState } from '../lib/generatedQueue';
import { t } from '../lib/i18n';
import { pageVisible } from '../lib/pageVisibility';
import { createQueueEntry, sameQueueSection, type ContextTrack, type PlaybackContextDescriptor } from '../lib/playbackQueue';
import { readPlaybackSession, type PlaybackSessionSnapshot } from '../lib/playbackSession';
import { prepareRemoteTrack, remoteCommandMessage } from '../lib/remotePlayback';
import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { shuffled } from '../lib/shuffle';
import type { AppSocket, DeviceStateEvent, WatchDeviceAck } from '../lib/socket';
import { toast } from '../lib/toast';
import { isPodcastTrack, podcastEpisodeToTrack } from '../lib/track';
import type { Track } from '../types/music';
import { setControlledPlayback } from './remoteLink';
import type { PlayerActions } from './contracts';
import { state, type PlaybackState, type RepeatMode } from './core';

const TARGET_KEY = 'remote:target';
const CONFIRM_MS = 3000;
const MAX_TRACKS = 500;
const REPEAT_ORDER: readonly RepeatMode[] = ['off', 'all', 'one'];

/** The controls that show a pending state while their command is in flight. */
export type RemoteKey = 'play' | 'next' | 'prev' | 'seek' | 'shuffle' | 'repeat' | 'volume' | 'mute';

/** The last state of the controlled device this controller accepted. */
export interface HeldState {
  rev: number;
  track: Track | null;
  positionSec: number;
  isPlaying: boolean;
  measuredAtMs: number;
  /** `server_now_ms − Date.now()` at receipt (contract: position on a controller). */
  offsetMs: number;
  live: LivePlaybackState | null;
  session: PlaybackSessionSnapshot | null;
}

/** `value` is what the control shows until the device confirms it (seek, volume);
 * `rev` is set once the device answered `applied`. */
interface Pending { id: number; value?: number; rev?: number }

export const isOnline = (d: Device): boolean => Boolean(d.online ?? d.socket_active);
export const isControllable = (d: Device): boolean => isOnline(d) && typeof d.protocol === 'number' && d.protocol >= 1;

const [devices, setDevices] = createSignal<Device[] | null>(null);
const [devicesFailed, setDevicesFailed] = createSignal(false);
/** `null` is this device. */
const [target, setTarget] = createSignal<string | null>(null);
const [held, setHeld] = createSignal<HeldState | null>(null);
const [unreachable, setUnreachable] = createSignal(false);
const [pending, setPending] = createSignal<ReadonlyMap<RemoteKey, Pending>>(new Map());

let socket: AppSocket | null = null;
let startupChecked = false;
let pendingSeq = 0;

export { devices as remoteDevices, devicesFailed as remoteDevicesFailed, target as remoteTarget, unreachable as remoteUnreachable };

function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem(TARGET_KEY, id);
    else localStorage.removeItem(TARGET_KEY);
  } catch { /* storage disabled */ }
}

function remembered(): string | null {
  try { return localStorage.getItem(TARGET_KEY); } catch { return null; }
}

const deviceRow = (id: string | null): Device | undefined => (id ? devices()?.find(d => d.device_id === id) : undefined);

export const deviceName = (d: Device | undefined): string => d?.device_name || t('deviceSheet.fallbackDevice');

/** The name of the device the player shows. */
export const controlledName = (): string => (target() ? deviceName(deviceRow(target())) : state.device.device_name);

/** Optional controls (volume, mute, promote, avoid) ask the controlled device. */
export const remoteCan = (command: string): boolean => !target() || Boolean(deviceRow(target())?.commands?.includes(command));

export const remotePending = (key: RemoteKey): boolean => pending().has(key);

function upsert(row: Device): void {
  setDevices(list => {
    const rows = list ?? [];
    const i = rows.findIndex(d => d.device_id === row.device_id);
    if (i < 0) return [...rows, row];
    // A row that arrives late must not put an older song back on it.
    const old = rows[i].playing;
    const next = row.playing && old && row.playing.rev < old.rev ? { ...row, playing: old } : row;
    return rows.map((d, j) => (j === i ? next : d));
  });
}

function fromRow(row: Device, serverNowMs?: number): HeldState {
  const offsetMs = typeof serverNowMs === 'number' ? serverNowMs - Date.now() : 0;
  const playing = row.playing;
  // rev -1: the watch acknowledgement carries the same rev with the session and live state.
  return {
    rev: -1,
    track: playing?.track ?? null,
    positionSec: Number(playing?.position_sec) || 0,
    isPlaying: Boolean(playing?.is_playing),
    measuredAtMs: playing?.measured_at_ms ?? Date.now() + offsetMs,
    offsetMs,
    live: null,
    session: null,
  };
}

/** Accept a state only when its rev is newer than the one held; a state without
 * a session keeps the held session (contract: watching a device). */
export function applyDeviceState(event: DeviceStateEvent, serverNowMs = event.server_now_ms): void {
  if (event.device_id !== target()) return;
  const prev = held();
  const rev = typeof event.rev === 'number' ? event.rev : 0;
  if (prev && rev <= prev.rev) return;
  const offsetMs = typeof serverNowMs === 'number' ? serverNowMs - Date.now() : (prev?.offsetMs ?? 0);
  setHeld({
    rev,
    track: event.track ?? null,
    positionSec: Math.max(0, Number(event.position_sec) || 0),
    isPlaying: Boolean(event.is_playing),
    measuredAtMs: typeof event.measured_at_ms === 'number' ? event.measured_at_ms : Date.now() + offsetMs,
    offsetMs,
    live: event.live ?? null,
    session: 'session' in event ? readPlaybackSession(event.session) : (prev?.session ?? null),
  });
  setUnreachable(false);
  setPending(map => {
    const keep = [...map].filter(([, p]) => p.rev === undefined || p.rev > rev);
    return keep.length === map.size ? map : new Map(keep);
  });
}

function watch(id: string): void {
  socket?.emit('watch_device', { device_id: id }, (ack?: WatchDeviceAck) => {
    if (!ack || target() !== id) return;
    if (ack.device) upsert(ack.device);
    if (!ack.device || !isOnline(ack.device)) {
      setUnreachable(true);
      return;
    }
    if (ack.state) applyDeviceState(ack.state, ack.server_now_ms);
    else setHeld(fromRow({ ...ack.device, playing: null }, ack.server_now_ms));
    setUnreachable(false);
  });
}

/** Control a device, or this one (`null`). Never called on a failure: only the
 * listener switches (decision 7 of the remote handoff). */
export function selectTarget(id: string | null, persist = true): void {
  startupChecked = true;
  const next = id === state.device.device_id ? null : id;
  const prev = target();
  if (prev && prev !== next) socket?.emit('unwatch_device', { device_id: prev });
  setPending(new Map());
  setTarget(next);
  if (persist) remember(next);
  const row = deviceRow(next);
  setHeld(row ? fromRow(row) : null);
  setUnreachable(Boolean(next && row && !isOnline(row)));
  if (next) watch(next);
}

/** Startup only: a remembered device that is online, otherwise a device that is
 * playing while this one has nothing loaded — as when a music app opens while
 * music plays elsewhere. Never at any other time. */
function startupSelection(rows: Device[], serverNowMs?: number): void {
  if (startupChecked) return;
  startupChecked = true;
  const others = rows.filter(d => d.device_id !== state.device.device_id && isControllable(d));
  const saved = remembered();
  const pick = saved
    ? others.find(d => d.device_id === saved)
    : state.playback.currentTrack ? undefined : others.find(d => d.playing?.is_playing);
  if (!pick) return;
  selectTarget(pick.device_id, false);
  setHeld(fromRow(pick, serverNowMs));
}

export async function refreshDevices(): Promise<void> {
  try {
    const res = await api.listDevices();
    const rows = res.devices ?? [];
    setDevices(rows);
    setDevicesFailed(false);
    startupSelection(rows, res.server_now_ms);
    const row = deviceRow(target());
    if (target() && (!row || !isOnline(row))) setUnreachable(true);
  } catch {
    setDevicesFailed(true);
  }
}

/** "Try again" in the device sheet: watch the controlled device again if it is back. */
export async function retryTarget(): Promise<boolean> {
  await refreshDevices();
  const id = target(), row = deviceRow(id);
  if (!id || !row || !isOnline(row)) return false;
  setUnreachable(false);
  watch(id);
  return true;
}

/** Every (re)connect (stores/runtime): the room membership is gone with the old socket. */
export function onRemoteConnect(): void {
  void refreshDevices();
  const id = target();
  if (id) watch(id);
}

export function attachRemoteSocket(owned: AppSocket, lifetime: RuntimeLifetime): void {
  socket = owned;
  owned.on('device_updated', lifetime.guard(payload => {
    const row = payload?.device;
    if (!row?.device_id) return;
    upsert(row);
    if (row.device_id !== target()) return;
    if (!isOnline(row)) setUnreachable(true);
    else if (unreachable()) watch(row.device_id);
  }));
  owned.on('device_state', lifetime.guard(payload => applyDeviceState(payload)));
  // The account (or the whole store) is going away: so is whatever it controlled.
  lifetime.own(() => {
    if (socket === owned) resetRemoteState();
  });
  if (owned.connected) onRemoteConnect();
}

export function resetRemoteState(): void {
  startupChecked = false;
  socket = null;
  setDevices(null);
  setDevicesFailed(false);
  setTarget(null);
  setHeld(null);
  setUnreachable(false);
  setPending(new Map());
}

function settle(key: RemoteKey, id: number, rev?: number): void {
  setPending(map => {
    if (map.get(key)?.id !== id) return map;
    const next = new Map(map);
    if (rev === undefined) next.delete(key);
    else next.set(key, { ...map.get(key)!, rev });
    return next;
  });
}

/** Send a command to the controlled device. A keyed control stays pending until
 * the device's state reaches the answer's rev (at most 3 s), so it never jumps back. */
export async function sendCommand(
  name: string,
  args: Record<string, unknown> = {},
  key?: RemoteKey,
  value?: number,
): Promise<boolean> {
  const id = target();
  if (!id) return false;
  const seq = ++pendingSeq;
  if (key) setPending(map => new Map(map).set(key, { id: seq, value }));
  let answer: DeviceCommandAnswer | null = null;
  try {
    answer = await api.deviceCommand(id, name, args);
  } catch { /* answered below as a failure */ }
  if (target() !== id) return false;
  if (answer?.status === 'applied') {
    const rev = answer.rev ?? 0;
    if (key && rev > (held()?.rev ?? -1)) {
      settle(key, seq, rev);
      setTimeout(() => settle(key, seq), CONFIRM_MS);
    } else if (key) settle(key, seq);
    return true;
  }
  if (key) settle(key, seq);
  if (answer?.status === 'unreachable' && answer.reason === 'offline') setUnreachable(true);
  toast.error(remoteCommandMessage(answer, controlledName()));
  return false;
}

/** Move the session between devices, then control wherever it went. */
export async function transferTo(from: string, to: string): Promise<boolean> {
  try {
    const answer = await api.transfer(from, to);
    if (answer.status === 'applied') {
      selectTarget(to);
      return true;
    }
    const failed = answer.step === 'export' ? from : to;
    toast.error(remoteCommandMessage(answer, failed === state.device.device_id ? state.device.device_name : deviceName(deviceRow(failed))));
  } catch {
    toast.error(remoteCommandMessage(null, deviceName(deviceRow(to))));
  }
  return false;
}

/** Where the controlled device is in its song now (contract: position on a controller). */
export function heldPosition(h: HeldState, duration: number, now = Date.now()): number {
  const elapsed = h.isPlaying ? Math.max(0, (now + h.offsetMs - h.measuredAtMs) / 1000) : 0;
  const position = h.positionSec + elapsed;
  return duration > 0 ? Math.min(duration, position) : position;
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
    setPending(map => new Map(map).set('volume', { id: ++pendingSeq, value: level }));
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
