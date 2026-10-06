import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { beforeEach, expect, it, vi } from 'vitest';
import { openNativeDjSources } from './DjSources';
import type { ProgramState } from '../lib/program/runtime';
const mocks = vi.hoisted(() => ({ overlay: vi.fn(), close: vi.fn() }));
vi.mock('../lib/overlay', () => ({ openOverlay: mocks.overlay }));
vi.mock('../lib/i18n', () => ({ t: (key: string, args?: { title: string }) => key + (args?.title ? ':' + args.title : '') }));
const sources = [{ id: 'first', label: 'First', activation: 1, tracks: [{ id: 'a', title: 'A', artist: 'Artist' }] },
  { id: 'second', label: 'Second', activation: 2, tracks: [{ id: 'b', title: 'B', artist: 'Artist' }] }];
const initial = { ready: true, generation: 1, programToken: 'dj', dj: { active: true, profile: 'adaptive', phase: 'ready', sources } } as ProgramState;
beforeEach(() => { cleanup(); vi.clearAllMocks(); });
function picker() {
  const [state, change] = createSignal(initial); const [pending, setPending] = createSignal(false);
  const execute = vi.fn(async () => {});
  openNativeDjSources(state, pending, execute);
  const view = render(() => mocks.overlay.mock.calls[0][0](mocks.close));
  return { view, state, change, setPending, execute };
}
it('removes only the chosen source from the latest state and keeps the last source', async () => {
  const { view, state, change, execute } = picker();
  const third = { ...sources[0], id: 'third', label: 'Third', activation: 3 };
  change({ ...state(), dj: { ...state().dj!, sources: [...sources, third] } });
  await fireEvent.click(view.getByRole('button', { name: 'autoMode.source.remove:First' }));
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'djSettings', programToken: 'dj', sources: [sources[1], third] });
  change({ ...state(), dj: { ...state().dj!, sources: [third] } });
  const last = view.getByRole('button', { name: 'autoMode.source.remove:Third' }) as HTMLButtonElement;
  expect(last.disabled).toBe(true); await fireEvent.click(last); expect(execute).toHaveBeenCalledTimes(1);
});
it('blocks pending edits and closes on programme or account replacement', async () => {
  const { view, change, setPending, execute } = picker(); setPending(true);
  await fireEvent.click(view.getByRole('button', { name: 'autoMode.source.remove:First' })); expect(execute).not.toHaveBeenCalled();
  setPending(false); change({ ...initial, generation: 2 });
  await fireEvent.click(view.getByRole('button', { name: 'autoMode.source.remove:First' }));
  expect(execute).not.toHaveBeenCalled(); expect(mocks.close).toHaveBeenCalled();
});
it('shows failure without deleting a source optimistically and permits retry', async () => {
  const { view, execute } = picker(); execute.mockRejectedValueOnce(new Error('unavailable'));
  await fireEvent.click(view.getByRole('button', { name: 'autoMode.source.remove:First' }));
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy()); expect(view.getByText('First')).toBeTruthy();
  await fireEvent.click(view.getByRole('button', { name: 'autoMode.source.remove:First' })); expect(execute).toHaveBeenCalledTimes(2);
});
