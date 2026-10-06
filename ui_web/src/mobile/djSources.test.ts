import { expect, it, vi } from 'vitest';
import { nativeDjSourceActions } from './djSources';
import type { ProgramState } from '../lib/program/runtime';
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const empty: ProgramState = { generation: 1, sequence: 1, ready: true, playWhenReady: false, errorKind: '', playing: false, state: 1, index: -1, id: '', title: '', artist: '', items: [], queueToken: 'empty', queue: [], positionMs: 0, durationMs: 0, error: 0, errorStatus: 0, shuffle: false, repeat: 0, hasNext: false, hasPrevious: false };
const tracks = [{ id: 'song', title: 'Song', artist: 'Artist' }];
it('starts from a collection without selecting a seed song and rejects another account', () => {
  let state = empty;
  const execute = vi.fn(async () => {});
  const action = nativeDjSourceActions('album:a', 'Album', tracks, () => state, () => true, () => false, execute)[0];
  action.onSelect();
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'dj', profile: 'adaptive', fromCurrent: false, queueToken: 'empty', sources: [{ id: 'album:a', label: 'Album', tracks, activation: 0 }] });
  state = { ...empty, generation: 2 }; action.onSelect();
  expect(execute).toHaveBeenCalledTimes(1);
});
it('adds sources to the retained DJ programme and removes an existing source explicitly', () => {
  const source = { id: 'album:a', label: 'Album', tracks, activation: 0 };
  let state: ProgramState = { ...empty, programToken: 'dj', dj: { active: true, phase: 'ready', profile: 'adaptive', sources: [source] } };
  const execute = vi.fn(async () => {});
  nativeDjSourceActions('album:b', 'Other', tracks, () => state, () => true, () => false, execute).find(action => action.label === 'autoMode.source.add')!.onSelect();
  expect(execute).toHaveBeenLastCalledWith({ action: 'djSettings', programToken: 'dj', sources: [source, { ...source, id: 'album:b', label: 'Other' }] });
  const remove = nativeDjSourceActions('album:a', 'Album', tracks, () => state, () => true, () => false, execute)[0];
  remove.onSelect(); expect(execute).toHaveBeenLastCalledWith({ action: 'djSettings', programToken: 'dj', sources: [] });
  state = { ...state, programToken: 'replacement' }; remove.onSelect();
  expect(execute).toHaveBeenCalledTimes(2);
});
it('moves the whole DJ session onto a collection as its only source', () => {
  const source = { id: 'album:a', label: 'Album', tracks, activation: 0 };
  const state: ProgramState = { ...empty, programToken: 'dj', dj: { active: true, phase: 'ready', profile: 'adaptive', sources: [source] } };
  const execute = vi.fn(async () => {});
  const actions = nativeDjSourceActions('playlist:b', 'Other', tracks, () => state, () => true, () => false, execute);
  expect(actions.map(action => action.label)).toEqual(['musicExplorer.change', 'autoMode.source.add']);
  actions[0].onSelect();
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'djSettings', programToken: 'dj', sources: [{ ...source, id: 'playlist:b', label: 'Other' }] });
  expect(nativeDjSourceActions('album:a', 'Album', tracks, () => state, () => true, () => false, execute).map(action => action.label)).toEqual(['autoMode.source.remove']);
  expect(nativeDjSourceActions('album:b', 'B', tracks, () => ({ ...empty }), () => true, () => false, execute).map(action => action.label)).toEqual(['autoMode.startDj']);
});
