import { createEffect, createMemo, createRoot, onCleanup } from 'solid-js';
import type { DjMusicSetSource } from '../api';
import { sameQueueSection, type ContextTrack, type PlaybackQueueEntry } from '../playbackQueue';
import { heldPosition, type HeldState, type RemoteControl } from '../remoteControl';
import { prepareRemoteTrack } from '../remotePlayback';
import { shuffled } from '../shuffle';
import { isPodcastTrack } from '../track';
import type { Track } from '../../types/music';
import type { ProgramCommand, ProgramControl, ProgramOccurrence, ProgramState, ProgramTrack, ProgramTransport } from './runtime';
import { programTrack, queueTrack } from './tracks';

/** The Android app's player surfaces read a `ProgramState` and send `ProgramCommand`s.
 * While another device is controlled, this transport builds that state from the
 * device's published state and sends each command as its contract command
 * (docs/internal/remote/CONTRACT.md), so the same surfaces control it. */

const MAX_TRACKS = 500;
const REPEAT: readonly ('off' | 'one' | 'all')[] = ['off', 'one', 'all'];
const TICK_MS = 500;

/** Which optional controls a device offers, from the commands it declares. Stopping
 * the program, autoplay and the radio profile have no contract command. */
const CONTROL_COMMANDS: [ProgramControl, string[]][] = [
  ['seek', ['transport.seek']],
  ['shuffle', ['transport.set_shuffle']],
  ['repeat', ['transport.set_repeat']],
  ['queueAdd', ['queue.add']],
  ['queueEdit', ['queue.move', 'queue.remove']],
  ['radio', ['radio.start', 'radio.stop']],
  ['dj', ['dj.start', 'dj.start_from_current']],
  ['djSources', ['dj.add_source', 'dj.remove_source']],
  ['djPlace', ['dj.place']],
  ['djRepair', ['dj.repair']],
];

/** A command this transport does not send: nothing offered it for another device. */
export class RemoteProgramUnsupported extends Error {}

interface Projection {
  entries: PlaybackQueueEntry[];
  state: Omit<ProgramState, 'sequence' | 'positionMs'>;
}

function occurrence(entry: PlaybackQueueEntry, key: string): ProgramOccurrence {
  const track: ProgramTrack = programTrack(entry) ?? {
    source: entry.source === 'preview' ? 'preview' : 'local', id: entry.id, title: entry.title, artist: entry.artist, album: entry.album, duration: entry.duration,
  };
  const generatedSource = entry.queueSource === 'radio' || entry.queueSource === 'autoplay' ? entry.queueSource : null;
  return {
    ...track, key, lane: entry.queueLane, generated: entry.queueLane === 'generated' && generatedSource !== null, generatedSource,
    routeOwnerKey: entry.autoRoute?.kind === 'bridge' ? entry.autoRoute.ownerQueueId ?? null : null,
  };
}

/** The controlled device in the shape the player surfaces read. */
export function projectProgram(h: HeldState | null, target: string | null, offline: boolean, commands: readonly string[], generation: number): Projection {
  const session = h?.session ?? null, live = h?.live ?? null;
  const fromSession = Boolean(session && session.queue.length > 0);
  const entries: PlaybackQueueEntry[] = fromSession ? session!.queue
    : h?.track ? [{ ...h.track, queueId: `track:${h.track.id}`, queueLane: 'context', queueSource: 'single' }] : [];
  const index = fromSession ? Math.min(Math.max(session!.index, 0), entries.length - 1) : entries.length ? 0 : -1;
  const items = entries.map(entry => occurrence(entry, entry.queueId));
  const current = items[index];
  const dj = live ? live.dj : null;
  const djActive = live ? dj !== null : session?.mode === 'auto';
  const locked = dj && dj.transition.status !== 'idle' ? dj.transition.next_queue_id : undefined;
  const repeat = session?.repeat ?? 'off';
  const controls = CONTROL_COMMANDS.filter(([, names]) => names.every(name => commands.includes(name))).map(([control]) => control);
  const durationSec = live?.duration || current?.duration || 0;
  const token = `remote:${target ?? ''}`;
  const loading = live?.phase === 'loading' || live?.phase === 'buffering';
  return {
    entries,
    state: {
      generation,
      ready: Boolean(target && h) && !offline,
      playing: !offline && Boolean(h?.isPlaying),
      playWhenReady: !offline && Boolean(h?.isPlaying),
      errorKind: live?.phase === 'error' ? 'source' : '',
      error: live?.phase === 'error' ? 1 : 0,
      errorStatus: 0,
      state: !current ? 1 : loading && !offline ? 2 : 3,
      index,
      id: current?.id ?? '',
      title: current?.title ?? '',
      artist: current?.artist ?? '',
      items,
      queue: items.map(item => item.id),
      queueToken: token,
      programToken: token,
      durationMs: Math.round(durationSec * 1000),
      dj: djActive ? {
        active: true,
        phase: dj?.repairing ? 'repairing' : dj?.phase ?? 'ready',
        editableFrom: index + (locked ? 2 : 1),
        protectedKeys: locked ? [locked] : [],
        sources: (session?.auto?.sources ?? []) as DjMusicSetSource[],
      } : null,
      radio: session?.radio.active ? { active: true, phase: 'ready', profile: 'balanced' } : null,
      leveling: null,
      mixing: null,
      autoplay: null,
      preview: null,
      seekable: controls.includes('seek') && durationSec > 0,
      shuffle: session?.shuffle ?? false,
      repeat: REPEAT.indexOf(repeat) as 0 | 1 | 2,
      hasNext: Boolean(current) && (djActive || index < items.length - 1 || repeat !== 'off'),
      hasPrevious: Boolean(current),
      controls,
    },
  };
}

const descriptor = (track: ProgramTrack): ContextTrack => prepareRemoteTrack(queueTrack(track));
const music = (tracks: readonly ProgramTrack[]) => tracks.filter(track => track.mediaKind !== 'podcast_episode').slice(0, MAX_TRACKS).map(descriptor);

/** Each `ProgramCommand` as the contract commands that do the same on the device. */
export function contractCommands(command: ProgramCommand, view: Projection, positionSec: number): [string, Record<string, unknown>][] {
  const { state, entries } = view;
  const entry = (key: string) => entries.find(e => e.queueId === key);
  switch (command.action) {
    case 'play': return [['transport.play', {}]];
    case 'pause': return [['transport.pause', {}]];
    case 'next': return [['transport.next', {}]];
    case 'previous': return [['transport.previous', {}]];
    case 'retry': return [['transport.play', {}]];
    case 'seek': return [['transport.seek', { position_sec: Math.max(0, command.positionMs / 1000) }]];
    case 'skip': {
      const duration = state.durationMs / 1000;
      const at = Math.max(0, positionSec + command.seconds);
      return [['transport.seek', { position_sec: duration > 0 ? Math.min(duration, at) : at }]];
    }
    case 'shuffle': return [['transport.set_shuffle', { on: command.enabled }]];
    case 'repeat': return [['transport.set_repeat', { mode: REPEAT[command.mode] }]];
    case 'select': return [['queue.play_entry', { queue_id: command.key }]];
    case 'remove': return [['queue.remove', { queue_id: command.key }]];
    case 'move': {
      const moved = entry(command.key);
      // `toIndex` is the index after the move; the command names the entry it lands before.
      const before = entries[command.toIndex < command.index ? command.toIndex : command.toIndex + 1];
      const keep = before && moved && (state.dj?.active || sameQueueSection(moved, before));
      return [['queue.move', { queue_id: command.key, ...(keep ? { before_queue_id: before.queueId } : {}) }]];
    }
    case 'clearManual':
      return entries.slice(state.index + 1).filter(e => e.queueLane === 'manual').map(e => ['queue.remove', { queue_id: e.queueId }]);
    case 'append': return command.tracks.map(track => ['queue.add', { track: descriptor(track), at: 'end' }]);
    // Each one goes right after the current song: the last one first keeps their order.
    case 'insertAfter': return command.tracks.slice().reverse().map(track => ['queue.add', { track: descriptor(track), at: 'next' }]);
    case 'queue': {
      if (!command.tracks.length) return [];
      const tracks = command.shuffle ? shuffled(command.tracks) : command.tracks;
      const index = command.shuffle ? 0 : command.index;
      // The registry takes 500 tracks: keep the window around the chosen one.
      const start = Math.max(0, Math.min(index - 100, tracks.length - MAX_TRACKS));
      return [['play.tracks', { tracks: tracks.slice(start, start + MAX_TRACKS).map(descriptor), index: index - start }]];
    }
    case 'radio': {
      if (!command.enabled) return [['radio.stop', {}]];
      const seed = entries[state.index];
      if (!seed || isPodcastTrack(seed) ||
        command.queueToken !== state.queueToken || (command.key !== undefined && command.key !== seed.queueId)) {
        throw new RemoteProgramUnsupported();
      }
      return [['radio.start', { track: prepareRemoteTrack(seed as Track) }]];
    }
    case 'dj':
      if (!command.fromCurrent) throw new RemoteProgramUnsupported();
      return [['dj.start_from_current', {}]];
    case 'djSelection': return music(command.tracks).length ? [['dj.start', { tracks: music(command.tracks), label: command.label }]] : [];
    case 'djContext': {
      const tracks = music(command.tracks);
      return tracks.length ? [['dj.start', { tracks, label: command.tracks[0].title }]] : [];
    }
    case 'djRequest': {
      const tracks = music(command.tracks);
      return tracks.length ? [['dj.place', { tracks, ...(command.beforeKey ? { before_queue_id: command.beforeKey } : {}) }]] : [];
    }
    case 'djRepair': return [['dj.repair', {}]];
    case 'djSettings': {
      if (command.resetRequestGroups) throw new RemoteProgramUnsupported();
      const held = state.dj?.sources ?? [], next = command.sources ?? [];
      const removed = held.filter(source => !next.some(n => n.id === source.id));
      const added = next.filter(source => !held.some(h => h.id === source.id));
      return [
        ...removed.map((source): [string, Record<string, unknown>] => ['dj.remove_source', { source_id: source.id }]),
        ...added.map((source): [string, Record<string, unknown>] => ['dj.add_source', {
          tracks: source.tracks.slice(0, MAX_TRACKS).map(track => prepareRemoteTrack(track)), label: source.label,
        }]),
      ];
    }
    case 'mixing': return [['dj.set_mixing', { on: command.enabled }]];
    // Stopping the program, autoplay, levelling, metadata and file retirement belong to this device.
    default: throw new RemoteProgramUnsupported();
  }
}

/** A `ProgramTransport` over the controlled device. A command resolves once the
 * device has applied it and its state has arrived (contract: controller
 * behaviour), so the surfaces stay pending until then; a failure has already
 * been told to the listener by the controller and rejects. */
export function createRemoteProgramTransport(control: RemoteControl, generation: () => number): ProgramTransport {
  let sequence = 0;
  const declared = () => control.deviceRow(control.target())?.commands ?? [];
  const view = () => projectProgram(control.held(), control.target(), control.unreachable(), declared(), generation());
  const position = (h: HeldState | null, durationMs: number) => (h ? heldPosition(h, durationMs / 1000) : 0);
  const stamp = (projection: Projection): ProgramState => ({
    ...projection.state, sequence: ++sequence, positionMs: Math.round(position(control.held(), projection.state.durationMs) * 1000),
  });
  return {
    state: async () => stamp(view()),
    listen: async callback => createRoot(dispose => {
      const projection = createMemo(view);
      createEffect(() => {
        const current = projection();
        callback(stamp(current));
        // Position is interpolated here, never streamed (contract: position on a controller).
        if (!current.state.playing) return;
        const timer = setInterval(() => callback(stamp(current)), TICK_MS);
        onCleanup(() => clearInterval(timer));
      });
      return dispose;
    }),
    command: async command => {
      const projection = view();
      const sends = contractCommands(command, projection, position(control.held(), projection.state.durationMs));
      for (const [name, args] of sends) {
        if (!(await control.sendCommand(name, args, undefined, undefined, true))) throw new Error(`Remote command ${name} was not applied`);
      }
      return stamp(view());
    },
  };
}
