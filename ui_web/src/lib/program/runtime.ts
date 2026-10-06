import type { DjDirection, DjMusicSetSource, DjProfile, PreviewPreparation } from '../api';
/** Single-output async contract. Independent of Solid, Capacitor and the Web Audio mixer. */
export interface ProgramState {
  generation: number; sequence: number; ready: boolean; playing: boolean;
  playWhenReady: boolean; errorKind: '' | 'connection' | 'server' | 'auth' | 'permission' | 'source';
  state: number; index: number; id: string; title: string; artist: string;
  items: ProgramOccurrence[]; queueToken: string; programToken?: string; queue: string[]; positionMs: number; durationMs: number; error: number; errorStatus: number;
  dj?: { active: boolean; phase: string; profile: DjProfile; editRevision?: number; editableFrom?: number; protectedKeys?: string[]; editOutcome?: string; requestTitle?: string; direction?: DjDirection; sources?: DjMusicSetSource[] } | null;
  radio?: { active: boolean; phase: string; profile: 'familiar' | 'balanced' | 'explore' } | null;
  leveling?: { enabled: boolean | null; settingsPhase: string } | null;
  mixing?: { enabled: boolean | null; settingsPhase: string } | null;
  autoplay?: { enabled: boolean | null; settingsPhase: string; active: boolean; phase: string } | null;
  seekable?: boolean;
  preview?: { key: string; preparation: PreviewPreparation | null; retryAttempt: number; retryPending: boolean; retryNotBeforeMs: number } | null;
  shuffle: boolean; repeat: 0 | 1 | 2; hasNext: boolean; hasPrevious: boolean;
}
export interface ProgramContext { kind: 'album' | 'artist' | 'playlist'; id: string }
export interface ProgramOccurrence extends ProgramTrack { key: string; routeOwnerKey?: string | null; generated?: boolean; generatedSource?: 'radio' | 'autoplay' | null; lane?: 'manual' | 'context' | 'generated' | null }
export interface ProgramTrack { loudness_lufs?: number | null; loudness_peak_dbtp?: number | null; duration?: number; offline?: boolean; source: 'local' | 'preview' | 'podcast' | 'pending'; pendingResolve?: import('../playbackQueue').PendingCatalogReference; mediaKind?: 'podcast_episode'; enclosure?: string; episodeGuid?: string; feedId?: string; id: string; title: string; artist: string; album?: string }
export type ProgramCommand =
  | { action: 'play' | 'pause' | 'next' | 'previous' }
  | { action: 'dj'; profile: DjProfile; fromCurrent: boolean; queueToken: string; key?: string; direction?: DjDirection; sources?: DjMusicSetSource[] }
  | { action: 'djContext'; tracks: ProgramTrack[]; queueToken: string; programToken?: string; key?: string }
  | { action: 'djSettings'; programToken: string; profile?: DjProfile; direction?: DjDirection; sources?: DjMusicSetSource[] }
  | { action: 'djRepair'; programToken: string; queueToken: string }
  | { action: 'djRequest'; programToken: string; queueToken: string; tracks: ProgramTrack[]; beforeKey?: string }
  | { action: 'radio'; enabled: boolean; profile: 'familiar' | 'balanced' | 'explore'; queueToken: string; key?: string }
  | { action: 'metadata'; tracks: { id: string; title: string; artist: string; album: string; album_artist?: string | null; album_id?: string | null; artist_id?: string | null }[] }
  | { action: 'autoplay' | 'leveling' | 'mixing'; enabled: boolean; reload?: boolean }
  | { action: 'stop'; queueToken: string; programToken?: string }
  | { action: 'clearManual'; queueToken: string }
  | { action: 'retireSource'; id: string }
  | { action: 'seek'; positionMs: number }
  | { action: 'skip'; seconds: -15 | 15; index: number; key: string; queueToken: string }
  | { action: 'shuffle'; enabled: boolean }
  | { action: 'repeat'; mode: 0 | 1 | 2 }
  | { action: 'select' | 'remove' | 'retry'; index: number; key: string; queueToken: string }
  | { action: 'move'; index: number; toIndex: number; key: string; queueToken: string }
  | { action: 'append'; tracks: ProgramTrack[]; queueToken: string }
  | { action: 'insertAfter'; tracks: ProgramTrack[]; queueToken: string; index: number; key: string }
  | { action: 'queue'; tracks: ProgramTrack[]; index: number; context?: ProgramContext; shuffle?: boolean };
export interface ProgramTransport {
  state(): Promise<ProgramState>;
  command(command: ProgramCommand & { generation: number }): Promise<ProgramState>;
  listen(callback: (state: ProgramState) => void): Promise<() => void>;
}
export interface ProgramObserver {
  state(state: ProgramState | null): void;
  pending(pending: boolean): void;
  error(error: unknown): void;
}
export class ProgramSessionChanged extends Error {}

/** Native state is authoritative. A resolved command means accepted, never audible success. */
export function createProgramRuntime(transport: ProgramTransport, observer: ProgramObserver) {
  let binding = 0;
  let generation = -1;
  let sequence = -1;
  let remove: (() => void) | undefined;
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();
  const accept = (state: ProgramState, token: number) => {
    if (token !== binding || state.generation !== generation || state.sequence <= sequence) return;
    sequence = state.sequence;
    observer.state(state);
  };
  const report = (error: unknown, token: number) => { if (token === binding) observer.error(error); };
  function unbind() {
    binding++; generation = -1; sequence = -1; pending = 0; tail = Promise.resolve();
    remove?.(); remove = undefined;
    observer.state(null); observer.pending(false);
  }
  async function bind(nextGeneration: number) {
    unbind(); generation = nextGeneration;
    const token = binding;
    try {
      const stop = await transport.listen(state => accept(state, token));
      if (token !== binding) { stop(); return; }
      remove = stop;
      accept(await transport.state(), token);
    } catch (error) { report(error, token); }
  }
  function execute(command: ProgramCommand): Promise<void> {
    const token = binding;
    const account = generation;
    if (account < 0) return Promise.reject(new ProgramSessionChanged());
    pending++; observer.pending(true);
    const result = tail.then(async () => {
      if (token !== binding) throw new ProgramSessionChanged();
      accept(await transport.command({ ...command, generation: account }), token);
      if (token !== binding) throw new ProgramSessionChanged();
    });
    // A failed command must not poison subsequent explicit retry commands.
    tail = result.catch(() => {});
    return result.catch(error => { report(error, token); throw error; }).finally(() => {
      if (token === binding) { pending--; observer.pending(pending > 0); }
    });
  }
  return { bind, unbind, execute };
}
