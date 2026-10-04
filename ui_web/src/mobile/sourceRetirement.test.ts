import { expect, it, vi } from 'vitest';
import type { ProgramState, ProgramTransport } from '../lib/program/runtime';
import { retireNativeSource } from './sourceRetirement';

const state = (patch: Partial<ProgramState> = {}): ProgramState => ({ generation: 1,
  items: [{ source: 'preview', id: 'same-id', key: 'retained', title: 'Song', artist: 'Artist' }],
  playWhenReady: false, ...patch } as ProgramState);
function transport(reply: ProgramState): ProgramTransport {
  return { command: vi.fn(async () => reply), state: vi.fn(), listen: vi.fn() };
}
it('accepts a surviving preview of the same ID without replacing the program', async () => {
  const native = transport(state());
  await retireNativeSource(native, 'same-id', 1, () => true);
  expect(native.command).toHaveBeenCalledExactlyOnceWith({ action: 'retireSource', id: 'same-id', generation: 1 });
  expect(native.state).not.toHaveBeenCalled();
});
it('requires receipt of all local references removed', async () => {
  const native = transport(state({ items: [{ source: 'local', id: 'same-id', key: 'old', title: 'Song', artist: 'Artist' }] }));
  await expect(retireNativeSource(native, 'same-id', 1, () => true)).rejects.toThrow('not observed');
});
it.each([{ playWhenReady: true }, { radio: { active: true, phase: 'planning', profile: 'balanced' as const } },
  { autoplay: { active: true, enabled: true, settingsPhase: 'ready', phase: 'planning' } }])('requires an empty program to be closed (%j)', async patch => {
  await expect(retireNativeSource(transport(state({ items: [], ...patch })), 'same-id', 1, () => true)).rejects.toThrow('not closed');
});
it('ignores late receipt after ownership changes, without exposing a false error to the next account', async () => {
  let active = true;
  const native = transport(state({ generation: 2 }));
  vi.mocked(native.command).mockImplementation(async () => { active = false; return state({ generation: 2 }); });
  await retireNativeSource(native, 'same-id', 1, () => active);
  await retireNativeSource(native, 'same-id', 1, () => active);
  expect(native.command).toHaveBeenCalledOnce();
});
