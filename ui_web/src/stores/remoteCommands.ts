import { createEffect, createRoot } from 'solid-js';
import type { RemotePlaybackState } from '../lib/api';
import type { WebRemoteCommand } from '../lib/deviceIdentity';
import { editableFrom, insertionFloor, routeRows } from '../lib/djRoute';
import { sameQueueSection, type ContextTrack, type PlaybackContextDescriptor } from '../lib/playbackQueue';
import type { PlaybackSessionSnapshot } from '../lib/playbackSession';
import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import type { DeviceCommandAck, DeviceCommandRequest } from '../lib/socket';
import { isPodcastTrack } from '../lib/track';
import type { Track } from '../types/music';
import { state, type RepeatMode } from './core';
import type { PlayerActions, PublishedPlaybackState } from './contracts';

const REPEAT_ORDER: readonly RepeatMode[] = ['off', 'all', 'one'];
const START_GESTURE_WAIT_MS = 250;
const SESSION_IMPORT_TIMEOUT_MS = 9000;

export interface RemoteCommandPorts {
  actions: Pick<
    PlayerActions,
    | 'resumePlayback'
    | 'pausePlayback'
    | 'autoSkip'
    | 'next'
    | 'prev'
    | 'seek'
    | 'toggleShuffle'
    | 'cycleRepeat'
    | 'setVolume'
    | 'toggleMute'
    | 'playFrom'
    | 'playTrack'
    | 'playNext'
    | 'enqueue'
    | 'moveAutoRoute'
    | 'moveInQueue'
    | 'removeAutoRouteOccurrence'
    | 'removeQueueEntry'
    | 'playQueueEntry'
    | 'startRadio'
    | 'stopRadio'
    | 'startDjSelection'
    | 'enterAutoMode'
    | 'exitAutoMode'
    | 'placeAutoTracks'
    | 'promoteInAutoRoute'
    | 'avoidAutoTrackForSession'
    | 'addAutoSource'
    | 'removeAutoSource'
    | 'changeAutoSession'
    | 'repairAutoRoute'
    | 'setDjMixing'
  >;
  committedQueueId: () => string | null;
  startSettled: () => Promise<void>;
  pushPlaybackState: (opts?: { keepalive?: boolean; body?: PublishedPlaybackState }) => Promise<number | null>;
  playbackStateBody: (override?: Partial<{
    track: Track | null;
    position_sec: number;
    is_playing: boolean;
    includeSession: boolean;
  }>) => PublishedPlaybackState;
  livePosition: () => number;
  lastRev: () => number | null;
  sessionFor: (remote: RemotePlaybackState) => PlaybackSessionSnapshot | null;
  playRestoredSession: (session: PlaybackSessionSnapshot, position: number) => boolean;
  allowedCommands?: () => readonly string[];
}

type CommandHandler = (args: Record<string, unknown>) => Promise<DeviceCommandAck>;

const reject = (reason: string): DeviceCommandAck => ({ status: 'rejected', reason });

function isTrackLike(value: unknown): value is ContextTrack {
  return Boolean(value) && typeof value === 'object' && typeof (value as Track).id === 'string' && (value as Track).id.length > 0;
}

function isTrackList(value: unknown): value is ContextTrack[] {
  return Array.isArray(value) && value.length > 0 && value.every(isTrackLike);
}

function asContext(value: unknown): PlaybackContextDescriptor | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return null;
  const ctx = value as Partial<PlaybackContextDescriptor>;
  if (typeof ctx.id !== 'string' || typeof ctx.kind !== 'string' || typeof ctx.label !== 'string') return null;
  return ctx as PlaybackContextDescriptor;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Executes incoming `device_command` messages against the same `PlayerActions`
 * the local interface runs, then publishes and acknowledges with the server rev.
 */
export function createRemoteCommandExecutor(ports: RemoteCommandPorts, lifetime: RuntimeLifetime) {
  function activeCommittedQueueId(): string | null {
    const id = ports.committedQueueId();
    if (id) return id;
    if (state.autoMode.active && state.autoMode.transition.status !== 'idle') {
      return state.playback.queue[state.playback.index + 1]?.queueId ?? null;
    }
    return null;
  }

  function isLockedInDj(entryIndex: number): boolean {
    if (!state.autoMode.active || state.autoMode.transition.status === 'idle') return false;
    const pb = state.playback;
    const floor = insertionFloor(pb.queue, pb.index, activeCommittedQueueId());
    const start = editableFrom(routeRows(pb.queue), pb.index, floor);
    if (entryIndex > pb.index && entryIndex < start) return true;
    if (entryIndex === pb.index && state.autoMode.transition.status === 'mixing') return true;
    return false;
  }

  async function checkNeedsGesture(): Promise<boolean> {
    if (state.playback.needsGesture) return true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      ports.startSettled(),
      new Promise<void>(resolve => {
        timer = lifetime.setTimeout(resolve, START_GESTURE_WAIT_MS);
      }),
    ]);
    if (timer !== null) lifetime.clearTimeout(timer);
    return state.playback.needsGesture;
  }

  async function publishAndApply(): Promise<DeviceCommandAck> {
    const rev = await ports.pushPlaybackState();
    return { status: 'applied', rev: rev ?? ports.lastRev() ?? 0 };
  }

  async function finishPlaybackStart(): Promise<DeviceCommandAck> {
    if (await checkNeedsGesture()) return reject('needs_gesture');
    return publishAndApply();
  }

  function waitForAudioPlaying(): Promise<'playing' | 'needs_gesture' | 'failed'> {
    if (state.playback.phase === 'playing') return Promise.resolve('playing');
    if (state.playback.needsGesture) return Promise.resolve('needs_gesture');
    if (state.playback.phase === 'failed' || state.playback.loadError) return Promise.resolve('failed');

    return new Promise(resolve => {
      let done = false;
      let disposeRoot: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (outcome: 'playing' | 'needs_gesture' | 'failed') => {
        if (done) return;
        done = true;
        if (timer !== null) lifetime.clearTimeout(timer);
        timer = null;
        disposeRoot?.();
        disposeRoot = null;
        resolve(outcome);
      };
      lifetime.own(() => settle('failed'));
      timer = lifetime.setTimeout(() => settle('failed'), SESSION_IMPORT_TIMEOUT_MS);
      createRoot(dispose => {
        disposeRoot = dispose;
        createEffect(() => {
          const phase = state.playback.phase;
          const needsGesture = state.playback.needsGesture;
          const loadError = state.playback.loadError;
          if (needsGesture) settle('needs_gesture');
          else if (phase === 'playing') settle('playing');
          else if (phase === 'failed' || loadError || phase === 'idle') settle('failed');
        });
      });
    });
  }

  const handlers: Record<WebRemoteCommand, CommandHandler> = {
    'transport.play': async () => {
      if (!state.playback.currentTrack) return reject('nothing_playing');
      ports.actions.resumePlayback();
      return finishPlaybackStart();
    },

    'transport.pause': async () => {
      if (!state.playback.currentTrack) return reject('nothing_playing');
      ports.actions.pausePlayback();
      return publishAndApply();
    },

    'transport.next': async () => {
      if (!state.playback.currentTrack && !state.autoMode.active) return reject('nothing_playing');
      if (state.autoMode.active) await ports.actions.autoSkip();
      else ports.actions.next();
      return finishPlaybackStart();
    },

    'transport.previous': async () => {
      if (!state.playback.currentTrack) return reject('nothing_playing');
      ports.actions.prev();
      return finishPlaybackStart();
    },

    'transport.seek': async (args) => {
      const pos = args.position_sec;
      if (typeof pos !== 'number' || !Number.isFinite(pos)) return reject('invalid');
      if (!state.playback.currentTrack) return reject('nothing_playing');
      ports.actions.seek(pos);
      return publishAndApply();
    },

    'transport.set_shuffle': async (args) => {
      if (typeof args.on !== 'boolean') return reject('invalid');
      if (state.playback.shuffle !== args.on) ports.actions.toggleShuffle();
      return publishAndApply();
    },

    'transport.set_repeat': async (args) => {
      const mode = args.mode;
      if (mode !== 'off' && mode !== 'all' && mode !== 'one') return reject('invalid');
      const steps = (REPEAT_ORDER.indexOf(mode) - REPEAT_ORDER.indexOf(state.playback.repeat) + 3) % 3;
      for (let i = 0; i < steps; i += 1) ports.actions.cycleRepeat();
      return publishAndApply();
    },

    'transport.set_volume': async (args) => {
      const level = args.level;
      if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) return reject('invalid');
      ports.actions.setVolume(level);
      return publishAndApply();
    },

    'transport.set_muted': async (args) => {
      if (typeof args.on !== 'boolean') return reject('invalid');
      if (state.playback.muted !== args.on) ports.actions.toggleMute();
      return publishAndApply();
    },

    'play.tracks': async (args) => {
      if (!isTrackList(args.tracks)) return reject('invalid');
      const index = args.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= args.tracks.length) {
        return reject('invalid');
      }
      const context = asContext(args.context);
      if (context === null) return reject('invalid');
      ports.actions.playFrom(args.tracks, index, context ? { context } : undefined);
      return finishPlaybackStart();
    },

    'queue.add': async (args) => {
      if (!isTrackLike(args.track) || (args.at !== 'next' && args.at !== 'end')) return reject('invalid');
      const wasEmpty = state.playback.queue.length === 0;
      if (args.at === 'next') ports.actions.playNext(args.track);
      else ports.actions.enqueue(args.track);
      return wasEmpty ? finishPlaybackStart() : publishAndApply();
    },

    'queue.move': async (args) => {
      const queueId = nonEmptyString(args.queue_id);
      const beforeQueueId = optionalString(args.before_queue_id);
      if (!queueId || beforeQueueId === null) return reject('invalid');
      const pb = state.playback;
      const fromIndex = pb.queue.findIndex(e => e.queueId === queueId);
      if (fromIndex === -1) return reject('not_found');
      const beforeIndex = beforeQueueId !== undefined ? pb.queue.findIndex(e => e.queueId === beforeQueueId) : -1;
      if (beforeQueueId !== undefined && beforeIndex === -1) return reject('not_found');

      if (state.autoMode.active) {
        if (isLockedInDj(fromIndex)) return reject('locked');
        if (fromIndex <= pb.index) return reject('invalid_state');
        if (beforeQueueId !== undefined) {
          if (isLockedInDj(beforeIndex)) return reject('locked');
          if (beforeIndex <= pb.index) return reject('invalid_state');
        }
        ports.actions.moveAutoRoute(queueId, beforeQueueId);
      } else {
        if (fromIndex <= pb.index) return reject('invalid_state');
        if (beforeQueueId !== undefined) {
          if (beforeIndex <= pb.index) return reject('invalid_state');
          if (!sameQueueSection(pb.queue[fromIndex], pb.queue[beforeIndex])) return reject('invalid_state');
          const to = fromIndex < beforeIndex ? beforeIndex - 1 : beforeIndex;
          if (to !== fromIndex) ports.actions.moveInQueue(fromIndex, to);
        } else {
          let to = fromIndex;
          for (let i = pb.index + 1; i < pb.queue.length; i += 1) {
            if (sameQueueSection(pb.queue[fromIndex], pb.queue[i])) to = i;
          }
          if (to !== fromIndex) ports.actions.moveInQueue(fromIndex, to);
        }
      }
      return publishAndApply();
    },

    'queue.remove': async (args) => {
      const queueId = nonEmptyString(args.queue_id);
      if (!queueId) return reject('invalid');
      const pb = state.playback;
      const idx = pb.queue.findIndex(e => e.queueId === queueId);
      if (idx === -1) return reject('not_found');
      if (state.autoMode.active) {
        if (isLockedInDj(idx)) return reject('locked');
        if (idx <= pb.index) return reject('invalid_state');
        ports.actions.removeAutoRouteOccurrence(queueId);
      } else {
        ports.actions.removeQueueEntry(queueId);
      }
      return publishAndApply();
    },

    'queue.play_entry': async (args) => {
      const queueId = nonEmptyString(args.queue_id);
      if (!queueId) return reject('invalid');
      const idx = state.playback.queue.findIndex(e => e.queueId === queueId);
      if (idx === -1) return reject('not_found');
      ports.actions.playQueueEntry(queueId);
      return finishPlaybackStart();
    },

    'radio.start': async (args) => {
      if (!isTrackLike(args.track)) return reject('invalid');
      if (isPodcastTrack(args.track)) return reject('invalid_state');
      await ports.actions.startRadio(args.track);
      return finishPlaybackStart();
    },

    'radio.stop': async () => {
      ports.actions.stopRadio();
      return publishAndApply();
    },

    'dj.start': async (args) => {
      if (!isTrackList(args.tracks) || typeof args.label !== 'string') return reject('invalid');
      const music = args.tracks.filter(t => !isPodcastTrack(t) && !t.unavailable);
      if (!music.length) return reject('invalid_state');
      if (!state.autoMode.active) {
        if (state.playback.currentTrack && isPodcastTrack(state.playback.currentTrack)) return reject('invalid_state');
        ports.actions.enterAutoMode({ source: music[0], deferPlanning: true });
      }
      if (!ports.actions.startDjSelection(args.tracks, args.label)) return reject('invalid_state');
      return finishPlaybackStart();
    },

    'dj.start_from_current': async () => {
      if (state.playback.currentTrack && isPodcastTrack(state.playback.currentTrack)) return reject('invalid_state');
      ports.actions.enterAutoMode();
      return publishAndApply();
    },

    'dj.stop': async () => {
      if (!state.autoMode.active) return reject('invalid_state');
      ports.actions.exitAutoMode();
      return publishAndApply();
    },

    'dj.place': async (args) => {
      if (!state.autoMode.active) return reject('invalid_state');
      if (!isTrackList(args.tracks)) return reject('invalid');
      const beforeQueueId = optionalString(args.before_queue_id);
      if (beforeQueueId === null) return reject('invalid');
      if (beforeQueueId !== undefined) {
        const idx = state.playback.queue.findIndex(e => e.queueId === beforeQueueId);
        if (idx === -1) return reject('not_found');
        if (isLockedInDj(idx)) return reject('locked');
        if (idx <= state.playback.index) return reject('invalid_state');
      }
      const hadTrack = Boolean(state.playback.currentTrack);
      await ports.actions.placeAutoTracks(args.tracks, beforeQueueId);
      return hadTrack ? publishAndApply() : finishPlaybackStart();
    },

    'dj.promote': async (args) => {
      if (!state.autoMode.active) return reject('invalid_state');
      const queueId = nonEmptyString(args.queue_id);
      if (!queueId) return reject('invalid');
      const idx = state.playback.queue.findIndex(e => e.queueId === queueId);
      if (idx === -1) return reject('not_found');
      if (isLockedInDj(idx)) return reject('locked');
      if (idx <= state.playback.index) return reject('invalid_state');
      ports.actions.promoteInAutoRoute(queueId);
      return publishAndApply();
    },

    'dj.avoid': async (args) => {
      if (!state.autoMode.active) return reject('invalid_state');
      const queueId = nonEmptyString(args.queue_id);
      if (!queueId) return reject('invalid');
      const idx = state.playback.queue.findIndex(e => e.queueId === queueId);
      if (idx === -1) return reject('not_found');
      if (isLockedInDj(idx)) return reject('locked');
      if (idx <= state.playback.index) return reject('invalid_state');
      ports.actions.avoidAutoTrackForSession(queueId);
      return publishAndApply();
    },

    'dj.add_source': async (args) => {
      if (!state.autoMode.active) return reject('invalid_state');
      if (!isTrackList(args.tracks) || typeof args.label !== 'string') return reject('invalid');
      if (!args.tracks.some(t => !isPodcastTrack(t))) return reject('invalid_state');
      ports.actions.addAutoSource(args.tracks, args.label);
      return publishAndApply();
    },

    'dj.remove_source': async (args) => {
      if (!state.autoMode.active) return reject('invalid_state');
      const sourceId = nonEmptyString(args.source_id);
      if (!sourceId) return reject('invalid');
      if (!state.autoMode.sources.some(s => s.id === sourceId)) return reject('not_found');
      if (state.autoMode.sources.length <= 1) return reject('invalid_state');
      ports.actions.removeAutoSource(sourceId);
      return publishAndApply();
    },

    'dj.change_session': async (args) => {
      if (!state.autoMode.active) return reject('invalid_state');
      if (!isTrackList(args.tracks) || typeof args.label !== 'string') return reject('invalid');
      const ok = await ports.actions.changeAutoSession(args.tracks, args.label);
      if (!ok) return reject('invalid_state');
      return publishAndApply();
    },

    'dj.repair': async () => {
      if (!state.autoMode.active) return reject('invalid_state');
      await ports.actions.repairAutoRoute();
      return publishAndApply();
    },

    'dj.set_mixing': async (args) => {
      if (typeof args.on !== 'boolean') return reject('invalid');
      const ok = await ports.actions.setDjMixing(args.on);
      if (!ok) return reject('invalid_state');
      return publishAndApply();
    },

    'session.export': async () => {
      if (!state.playback.currentTrack) return reject('nothing_playing');
      const exported = ports.playbackStateBody({
        position_sec: ports.livePosition(),
        includeSession: true,
      });
      const rev = ports.lastRev();
      return {
        status: 'applied',
        ...(rev !== null ? { rev } : {}),
        state: exported as unknown as Record<string, unknown>,
      };
    },

    'session.import': async (args) => {
      const remote = args.state;
      if (!remote || typeof remote !== 'object') return reject('invalid');
      const body = remote as RemotePlaybackState;
      const pos = Math.max(0, Number(body.position_sec) || 0);
      const session = ports.sessionFor(body);
      let started = false;
      if (session) {
        started = ports.playRestoredSession(session, pos);
      } else {
        const track = (body.track_id ? state.library.find(t => t.id === body.track_id) : undefined) ?? body.track ?? null;
        if (track && isTrackLike(track)) {
          if (state.autoMode.active) ports.actions.exitAutoMode();
          ports.actions.playTrack(track);
          if (pos > 0) lifetime.setTimeout(() => ports.actions.seek(pos), 400);
          started = true;
        }
      }
      if (!started) return reject('invalid_state');
      const outcome = await waitForAudioPlaying();
      if (outcome === 'needs_gesture') return reject('needs_gesture');
      if (outcome !== 'playing') return reject('invalid_state');
      return publishAndApply();
    },

    'session.release': async () => {
      if (state.playback.currentTrack) ports.actions.pausePlayback();
      return publishAndApply();
    },
  };

  async function execute(payload: DeviceCommandRequest | null | undefined): Promise<DeviceCommandAck> {
    const name = payload?.name;
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, name)) {
      return reject('unsupported');
    }
    const allowed = ports.allowedCommands?.();
    if (allowed && !allowed.includes(name)) {
      return reject('unsupported');
    }
    const rawArgs = payload?.args;
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    try {
      return await handlers[name as WebRemoteCommand](args);
    } catch {
      return reject('invalid_state');
    }
  }

  return {
    commands: Object.keys(handlers) as WebRemoteCommand[],
    execute,
  };
}
