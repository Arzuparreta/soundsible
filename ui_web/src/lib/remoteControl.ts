import { createSignal } from 'solid-js';
import { api, type Device, type DeviceCommandAnswer, type LivePlaybackState } from './api';
import { t } from './i18n';
import { readPlaybackSession, type PlaybackSessionSnapshot } from './playbackSession';
import { remoteCommandMessage } from './remotePlayback';
import type { DeviceStateEvent, WatchDeviceAck } from './socket';
import { toast } from './toast';
import type { Track } from '../types/music';

/** Controlling another device's playback (docs/internal/remote/CONTRACT.md), shared
 * by the web player and the Android app. What differs between them is injected:
 * how this device is described and how a device is watched (the web's own socket,
 * the Android service's socket). Commands and transfer go over HTTP on both. */

const CONFIRM_MS = 3000;

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
export interface RemotePending { id: number; value?: number; rev?: number }

/** This device, as the controller sees it. */
export interface RemoteHost {
  selfId(): string | null;
  selfName(): string;
}

/** How a device is watched: `watch` calls back with the engine's acknowledgement. */
export interface RemoteLink {
  watch(deviceId: string, ack: (answer: WatchDeviceAck | null | undefined) => void): void;
  unwatch(deviceId: string): void;
}

export const isOnline = (d: Device): boolean => Boolean(d.online ?? d.socket_active);
export const isControllable = (d: Device): boolean => isOnline(d) && typeof d.protocol === 'number' && d.protocol >= 1;
export const deviceName = (d: Device | undefined): string => d?.device_name || t('deviceSheet.fallbackDevice');

/** Where the controlled device is in its song now (contract: position on a controller). */
export function heldPosition(h: HeldState, duration: number, now = Date.now()): number {
  const elapsed = h.isPlaying ? Math.max(0, (now + h.offsetMs - h.measuredAtMs) / 1000) : 0;
  const position = h.positionSec + elapsed;
  return duration > 0 ? Math.min(duration, position) : position;
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

export type RemoteControl = ReturnType<typeof createRemoteControl>;

export function createRemoteControl(host: RemoteHost) {
  const [devices, setDevices] = createSignal<Device[] | null>(null);
  const [devicesFailed, setDevicesFailed] = createSignal(false);
  /** `null` is this device. */
  const [target, setTarget] = createSignal<string | null>(null);
  const [held, setHeld] = createSignal<HeldState | null>(null);
  const [unreachable, setUnreachable] = createSignal(false);
  const [pending, setPending] = createSignal<ReadonlyMap<RemoteKey, RemotePending>>(new Map());

  let link: RemoteLink | null = null;
  let clockOffsetMs = 0;
  let pendingSeq = 0;
  /** Commands waiting for the state that carries their answer's rev. */
  let waiters: { rev: number; done: () => void }[] = [];

  function updateClock(serverNowMs?: number): void {
    if (typeof serverNowMs === 'number') clockOffsetMs = serverNowMs - Date.now();
  }

  const deviceRow = (id: string | null): Device | undefined => (id ? devices()?.find(d => d.device_id === id) : undefined);

  /** The name of the device the player shows. */
  const controlledName = (): string => (target() ? deviceName(deviceRow(target())) : host.selfName());

  /** Optional controls (volume, mute, promote, avoid) ask the controlled device. */
  const can = (command: string): boolean => !target() || Boolean(deviceRow(target())?.commands?.includes(command));

  const isPending = (key: RemoteKey): boolean => pending().has(key);

  const release = (rev: number) => {
    const ready = waiters.filter(w => w.rev <= rev);
    if (!ready.length) return;
    waiters = waiters.filter(w => w.rev > rev);
    for (const w of ready) w.done();
  };
  const releaseAll = () => release(Number.POSITIVE_INFINITY);

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

  /** Accept a state only when its rev is newer than the one held; a state without
   * a session keeps the held session (contract: watching a device). */
  function applyDeviceState(event: DeviceStateEvent, serverNowMs = event.server_now_ms): void {
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
    release(rev);
  }

  function watch(id: string): void {
    link?.watch(id, ack => {
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

  /** Control a device, or this one (`null`), for the current session. */
  function selectTarget(id: string | null): void {
    const next = id === host.selfId() ? null : id;
    const prev = target();
    if (prev && prev !== next) link?.unwatch(prev);
    setPending(new Map());
    releaseAll();
    setTarget(next);
    const row = deviceRow(next);
    setHeld(row ? fromRow(row) : null);
    setUnreachable(Boolean(next && row && !isOnline(row)));
    if (next) watch(next);
  }

  /** Read the current track and estimate its position from the latest device row. */
  function trackCopy(id: string): { track: Track; positionSec: number } | null {
    const row = deviceRow(id);
    if (!row || !isOnline(row) || id === host.selfId() || row.playing?.mode === 'dj') return null;
    const snapshot = fromRow(row, Date.now() + clockOffsetMs);
    if (!snapshot.track || snapshot.track.unavailable) return null;
    const duration = Number(snapshot.track.duration) || 0;
    // Leave enough room to hear the track even when the estimate reaches its end.
    const position = heldPosition(snapshot, duration);
    return { track: snapshot.track, positionSec: duration > 0 ? Math.min(position, Math.max(0, duration - 1)) : position };
  }

  async function refreshDevices(): Promise<void> {
    try {
      const res = await api.listDevices();
      const rows = res.devices ?? [];
      setDevices(rows);
      setDevicesFailed(false);
      updateClock(res.server_now_ms);
      const row = deviceRow(target());
      if (target() && (!row || !isOnline(row))) setUnreachable(true);
    } catch {
      setDevicesFailed(true);
    }
  }

  /** "Try again" in the device sheet: watch the controlled device again if it is back. */
  async function retryTarget(): Promise<boolean> {
    await refreshDevices();
    const id = target(), row = deviceRow(id);
    if (!id || !row || !isOnline(row)) return false;
    setUnreachable(false);
    watch(id);
    return true;
  }

  /** A `device_updated` row from the account room. */
  function deviceUpdated(row: Device | null | undefined, serverNowMs?: number): void {
    if (!row?.device_id) return;
    updateClock(serverNowMs);
    upsert(row);
    if (row.device_id !== target()) return;
    if (!isOnline(row)) setUnreachable(true);
    else if (unreachable()) watch(row.device_id);
  }

  /** Every (re)connect of a link that loses its watch rooms with its socket. */
  function onConnect(): void {
    void refreshDevices();
    const id = target();
    if (id) watch(id);
  }

  function attach(next: RemoteLink): void {
    link = next;
  }

  /** The account (or the whole player) is going away: so is whatever it controlled. */
  function reset(): void {
    clockOffsetMs = 0;
    link = null;
    setDevices(null);
    setDevicesFailed(false);
    setTarget(null);
    setHeld(null);
    setUnreachable(false);
    setPending(new Map());
    releaseAll();
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

  /** Resolves once the held state reaches `rev`, the target changes, or 3 s pass. */
  const confirmed = (rev: number) => new Promise<void>(resolve => {
    const timer = setTimeout(() => { waiters = waiters.filter(w => w !== waiter); resolve(); }, CONFIRM_MS);
    const waiter = { rev, done: () => { clearTimeout(timer); resolve(); } };
    waiters.push(waiter);
  });

  /** Mark a control pending without sending anything (a coalesced volume drag). */
  function markPending(key: RemoteKey, value?: number): void {
    setPending(map => new Map(map).set(key, { id: ++pendingSeq, value }));
  }

  /** Send a command to the controlled device. A keyed control stays pending until
   * the device's state reaches the answer's rev (at most 3 s), so it never jumps
   * back; `confirm` makes the returned promise wait for that state as well. */
  async function sendCommand(
    name: string,
    args: Record<string, unknown> = {},
    key?: RemoteKey,
    value?: number,
    confirm = false,
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
      const ahead = rev > (held()?.rev ?? -1);
      if (key && ahead) {
        settle(key, seq, rev);
        setTimeout(() => settle(key, seq), CONFIRM_MS);
      } else if (key) settle(key, seq);
      if (confirm && ahead) await confirmed(rev);
      return true;
    }
    if (key) settle(key, seq);
    if (answer?.status === 'unreachable' && answer.reason === 'offline') setUnreachable(true);
    toast.error(remoteCommandMessage(answer, controlledName()));
    return false;
  }

  /** Move the session between devices, then control wherever it went. */
  async function transferTo(from: string, to: string): Promise<boolean> {
    const self = host.selfId();
    try {
      const answer = await api.transfer(from, to);
      if (answer.status === 'applied') {
        selectTarget(to);
        return true;
      }
      const failed = answer.step === 'export' ? from : to;
      toast.error(remoteCommandMessage(answer, failed === self ? host.selfName() : deviceName(deviceRow(failed))));
    } catch {
      toast.error(remoteCommandMessage(null, to === self ? host.selfName() : deviceName(deviceRow(to))));
    }
    return false;
  }

  return {
    host,
    devices,
    devicesFailed,
    target,
    held,
    unreachable,
    pending,
    deviceRow,
    controlledName,
    can,
    isPending,
    applyDeviceState,
    deviceUpdated,
    selectTarget,
    refreshDevices,
    retryTarget,
    onConnect,
    attach,
    reset,
    markPending,
    sendCommand,
    transferTo,
    trackCopy,
  };
}
