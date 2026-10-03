import { expect, it, vi } from 'vitest';
import { programLibraryMenu } from './libraryMenu';
import type { ProgramState } from './runtime';
import type { Track } from '../../types/music';
vi.mock('../i18n', () => ({ t: (key: string) => key }));
const track = { id: 'a', title: 'Song', artist: 'Artist', album: 'Album' } as Track;
const initial = { ready: true, generation: 1, index: 1, queueToken: 'order', items: [{ key: 'first' }, { key: 'second' }] } as ProgramState;
it('captures the current occurrence and sends only metadata', () => {
  let state = initial; const execute = vi.fn(async (_command: unknown) => {});
  const menu = programLibraryMenu({ ...track, url: 'https://untrusted.invalid' } as Track, () => state, () => false, execute);
  state = { ...initial, index: 0, queueToken: 'changed' };
  menu.actions![0].onSelect(); menu.actions![1].onSelect();
  expect(execute.mock.calls).toEqual([
    [{ action: 'insertAfter', tracks: [{ ...track, source: 'local' }], queueToken: 'order', index: 1, key: 'second' }],
    [{ action: 'append', tracks: [{ ...track, source: 'local' }], queueToken: 'order' }],
  ]);
});
it('permits empty-queue insertions with no anchor', () => {
  const execute = vi.fn(async () => {});
  programLibraryMenu(track, () => ({ ...initial, index: 0, items: [] }), () => false, execute).actions![0].onSelect();
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ index: -1, key: '' }));
});
it('blocks unavailable, preview, full and pending queues', () => {
  for (const [state, song, pending] of [[null, track, false], [{ ...initial, ready: false }, track, false], [initial, { ...track, source: 'preview' }, false], [{ ...initial, items: Array(1000).fill({ key: 'a' }) }, track, false], [initial, track, true]] as const) {
    const execute = vi.fn(async () => {});
    const menu = programLibraryMenu(song as Track, () => state as ProgramState | null, () => pending, execute);
    expect(menu.actions!.every(a => a.disabled)).toBe(true);
    menu.actions!.forEach(a => a.onSelect()); expect(execute).not.toHaveBeenCalled();
  }
});
it('blocks deferred selections after an account change or during a command', () => {
  let state = initial; let pending = false; const execute = vi.fn(async () => {});
  const menu = programLibraryMenu(track, () => state, () => pending, execute);
  state = { ...initial, generation: 2 }; menu.actions![1].onSelect();
  state = initial; pending = true; menu.actions![0].onSelect();
  expect(execute).not.toHaveBeenCalled();
});
it('allows a valid saved preview and forwards its source without external metadata', () => {
  const execute = vi.fn(async () => {});
  programLibraryMenu({ ...track, source: 'preview', id: 'A1111111111', cover: 'https://external.invalid' }, () => initial, () => false, execute).actions![1].onSelect();
  expect(execute).toHaveBeenCalledWith({ action: 'append', queueToken: 'order', tracks: [{ ...track, id: 'A1111111111', source: 'preview' }] });
});
it('starts radio from the actual current music occurrence without replacing audio', () => {
  const state = { ...initial, index: 0, items: [{ ...track, source: 'local', key: 'current' }] } as ProgramState;
  const execute = vi.fn(async () => {});
  const menu = programLibraryMenu(track, () => state, () => false, execute);
  menu.actions!.find(action => action.label === 'trackActions.startRadio')!.onSelect();
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'radio', enabled: true, profile: 'balanced', queueToken: 'order' });
});
it('stops native radio through an explicit contextual action', () => {
  const state = { ...initial, index: 0, items: [{ ...track, source: 'local', key: 'current' }], radio: { active: true, phase: 'ready', profile: 'explore' } } as ProgramState;
  const execute = vi.fn(async () => {});
  programLibraryMenu(track, () => state, () => false, execute).actions!.find(action => action.label === 'nowPlaying.stopRadioConfirm')!.onSelect();
  expect(execute).toHaveBeenCalledWith({ action: 'radio', enabled: false, profile: 'explore', queueToken: 'order' });
});
