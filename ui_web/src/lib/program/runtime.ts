/** Single-output async contract. Independent of Solid, Capacitor and the Web Audio mixer. */
export interface ProgramState {
  generation: number; sequence: number; ready: boolean; playing: boolean;
  state: number; index: number; id: string; title: string; artist: string;
  items: ProgramOccurrence[]; queueToken: string; queue: string[]; positionMs: number; durationMs: number; error: number; errorStatus: number;
  shuffle: boolean; repeat: 0 | 1 | 2; hasNext: boolean; hasPrevious: boolean;
}
export interface ProgramOccurrence extends ProgramTrack { key: string }
export interface ProgramTrack { id: string; title: string; artist: string; album?: string }
export type ProgramCommand =
  | { action: 'play' | 'pause' | 'next' | 'previous' | 'stop' }
  | { action: 'seek'; positionMs: number }
  | { action: 'shuffle'; enabled: boolean }
  | { action: 'repeat'; mode: 0 | 1 | 2 }
  | { action: 'select' | 'remove'; index: number; key: string; queueToken: string }
  | { action: 'move'; index: number; toIndex: number; key: string; queueToken: string }
  | { action: 'append'; tracks: ProgramTrack[]; queueToken: string }
  | { action: 'insertAfter'; tracks: ProgramTrack[]; queueToken: string; index: number; key: string }
  | { action: 'queue'; tracks: ProgramTrack[]; index: number };
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
