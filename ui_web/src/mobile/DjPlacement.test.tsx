import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { beforeEach, expect, it, vi } from 'vitest';
import { openNativeDjPlacement } from './DjPlacement';
import type { ProgramState, ProgramTrack } from '../lib/program/runtime';
const mocks = vi.hoisted(() => ({ overlay: vi.fn(), close: vi.fn() }));
vi.mock('../lib/overlay', () => ({ openOverlay: mocks.overlay }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const song: ProgramTrack = { source: 'local', id: 'song', title: 'Requested', artist: 'Artist' };
const initial = { generation: 1, ready: true, programToken: 'dj', queueToken: 'order', index: 0,
  dj: { active: true, profile: 'adaptive', phase: 'ready', editableFrom: 2 },
  items: [{ ...song, key: 'current' }, { ...song, key: 'cued' }, { ...song, key: 'future' }] } as ProgramState;
beforeEach(() => { cleanup(); vi.clearAllMocks(); });
function picker() {
  const [state, change] = createSignal<ProgramState | null>(initial);
  const [pending, setPending] = createSignal(false);
  const execute = vi.fn(async () => {});
  openNativeDjPlacement(song, state, pending, execute);
  const view = render(() => mocks.overlay.mock.calls[0][0](mocks.close));
  return { view, state, change, setPending, execute };
}
it('defaults to musical placement without targeting a cued occurrence', async () => {
  const { view, execute } = picker();
  expect([...view.getByRole('combobox').querySelectorAll('option')].map(option => option.value)).toEqual(['', 'future']);
  await fireEvent.submit(view.getByTestId('android-dj-placement'));
  await waitFor(() => expect(mocks.close).toHaveBeenCalled());
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'djRequest', programToken: 'dj', queueToken: 'order', tracks: [song] });
});
it('keeps the destination key across a refill and submits against the latest order', async () => {
  const { view, change, execute } = picker();
  await fireEvent.change(view.getByRole('combobox'), { target: { value: 'future' } });
  change({ ...initial, queueToken: 'refill', items: [...initial.items, { ...song, key: 'new' }] });
  await fireEvent.submit(view.getByTestId('android-dj-placement'));
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'djRequest', programToken: 'dj', queueToken: 'refill', tracks: [song], beforeKey: 'future' });
});
it('does not substitute automatic placement when a selected destination becomes committed or disappears', async () => {
  const { view, change, execute } = picker();
  await fireEvent.change(view.getByRole('combobox'), { target: { value: 'future' } });
  change({ ...initial, dj: { ...initial.dj!, editableFrom: 3 } });
  await fireEvent.submit(view.getByTestId('android-dj-placement'));
  expect(execute).not.toHaveBeenCalled(); expect(view.getByRole('alert')).toBeTruthy();
  change({ ...initial, items: initial.items.slice(0, 2) });
  await fireEvent.submit(view.getByTestId('android-dj-placement')); expect(execute).not.toHaveBeenCalled();
});
it('closes and blocks deferred submission when the account or programme changes', async () => {
  for (const next of [{ ...initial, generation: 2 }, { ...initial, programToken: 'other' }, null]) {
    const { view, change, execute } = picker(); change(next);
    await fireEvent.submit(view.getByTestId('android-dj-placement'));
    expect(execute).not.toHaveBeenCalled(); expect(mocks.close).toHaveBeenCalled(); cleanup(); vi.clearAllMocks();
  }
});
it('keeps a failed request open for retry and blocks submission during another command', async () => {
  const { view, setPending, execute } = picker();
  setPending(true); await fireEvent.submit(view.getByTestId('android-dj-placement')); expect(execute).not.toHaveBeenCalled();
  setPending(false); execute.mockRejectedValueOnce(new Error('stale order'));
  await fireEvent.submit(view.getByTestId('android-dj-placement'));
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy()); expect(mocks.close).not.toHaveBeenCalled();
  await fireEvent.submit(view.getByTestId('android-dj-placement'));
  await waitFor(() => expect(mocks.close).toHaveBeenCalled()); expect(execute).toHaveBeenCalledTimes(2);
});
