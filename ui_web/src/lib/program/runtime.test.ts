import { describe, expect, it, vi } from 'vitest';
import { createProgramRuntime, ProgramSessionChanged, type ProgramState, type ProgramTransport } from './runtime';
const state = (generation = 1, sequence = 1): ProgramState => ({ generation, sequence, ready: true, playing: false, state: 2, index: 0, id: 'a', title: 'a', artist: '', items: [{ key: 'first', id: 'a', title: 'a', artist: '' }], queueToken: 'token', queue: ['a'], positionMs: 0, durationMs: 1000, error: 0, errorStatus: 0, shuffle: false, repeat: 0, hasNext: false, hasPrevious: false });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(overrides: Partial<ProgramTransport> = {}) {
  let event!: (state: ProgramState) => void;
  const stop = vi.fn();
  const observer = { state: vi.fn(), pending: vi.fn(), error: vi.fn() };
  const transport: ProgramTransport = { state: async () => state(), command: vi.fn(async () => state(1, 2)), listen: async callback => { event = callback; return stop; }, ...overrides };
  return { runtime: createProgramRuntime(transport, observer), observer, transport, stop, event: (s: ProgramState) => event(s) };
}
describe('asynchronous program ownership', () => {
  it('does not let a late command reply or initial snapshot replace a newer event', async () => {
    const initial = deferred<ProgramState>(); const reply = deferred<ProgramState>();
    const f = fixture({ state: () => initial.promise, command: () => reply.promise });
    const binding = f.runtime.bind(1); await Promise.resolve();
    f.event({ ...state(1, 5), playing: true }); initial.resolve(state(1, 2)); await binding;
    const command = f.runtime.execute({ action: 'pause' }); await Promise.resolve();
    f.event({ ...state(1, 9), playing: false }); reply.resolve(state(1, 6)); await command;
    expect(f.observer.state.mock.calls.filter(([s]) => s).map(([s]) => s.sequence)).toEqual([5, 9]);
    f.event(state(2, 10)); expect(f.observer.state).toHaveBeenLastCalledWith(expect.objectContaining({ sequence: 9 }));
  });
  it('serializes commands and only accepts observed playing state', async () => {
    const first = deferred<ProgramState>(); const second = deferred<ProgramState>();
    const command = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const f = fixture({ command }); await f.runtime.bind(1);
    const a = f.runtime.execute({ action: 'play' }); const b = f.runtime.execute({ action: 'pause' }); await Promise.resolve();
    expect(command).toHaveBeenCalledTimes(1); expect(f.observer.state).toHaveBeenLastCalledWith(expect.objectContaining({ playing: false }));
    first.resolve(state(1, 2)); await a; expect(command).toHaveBeenCalledTimes(2);
    second.resolve(state(1, 3)); await b; expect(f.observer.pending).toHaveBeenLastCalledWith(false);
    expect(command.mock.calls.map(([c]) => c.action)).toEqual(['play', 'pause']);
  });
  it('invalidates queued commands and hides old account errors after unbind', async () => {
    const reply = deferred<ProgramState>(); const command = vi.fn(() => reply.promise);
    const f = fixture({ command }); await f.runtime.bind(1);
    const a = f.runtime.execute({ action: 'play' }); const aResult = a.catch(error => error);
    const b = f.runtime.execute({ action: 'next' }); const bResult = b.catch(error => error);
    await Promise.resolve(); f.runtime.unbind(); reply.reject(new Error('old account'));
    expect(await aResult).toBeInstanceOf(Error); expect(await bResult).toBeInstanceOf(ProgramSessionChanged);
    expect(command).toHaveBeenCalledTimes(1); expect(f.observer.error).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.observer.state).toHaveBeenLastCalledWith(null);
  });
  it('releases a listener acquired after disposal', async () => {
    const acquired = deferred<() => void>(); const stop = vi.fn(); const f = fixture({ listen: () => acquired.promise });
    const binding = f.runtime.bind(1); f.runtime.unbind(); acquired.resolve(stop); await binding;
    expect(stop).toHaveBeenCalledOnce(); expect(f.observer.error).not.toHaveBeenCalled();
  });
  it('recovers command processing after an explicit failure', async () => {
    const command = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(state(1, 2));
    const f = fixture({ command }); await f.runtime.bind(1);
    await expect(f.runtime.execute({ action: 'play' })).rejects.toThrow('network');
    await f.runtime.execute({ action: 'play' }); expect(command).toHaveBeenCalledTimes(2);
    expect(f.observer.pending).toHaveBeenLastCalledWith(false); expect(f.observer.error).toHaveBeenCalledOnce();
  });
});
