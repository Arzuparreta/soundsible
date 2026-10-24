import { expect, it, vi } from 'vitest';
import { nativeDjSourceActions } from './djSources';
import type { ProgramState } from '../lib/program/runtime';
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const empty: ProgramState = { generation: 1, sequence: 1, ready: true, playWhenReady: false, errorKind: '', playing: false, state: 1, index: -1, id: '', title: '', artist: '', items: [], queueToken: 'empty', queue: [], positionMs: 0, durationMs: 0, error: 0, errorStatus: 0, shuffle: false, repeat: 0, hasNext: false, hasPrevious: false };
const tracks = [{ id: 'song', title: 'Song', artist: 'Artist' }];
it('starts a fresh session across route refills and rejects stale accounts and programmes', () => {
  let state: ProgramState = { ...empty, programToken: 'dj', dj: { active: true, phase: 'ready' } };
  const execute = vi.fn(async () => {});
  const actions = nativeDjSourceActions('album:a', 'Album', tracks, () => state, () => true, () => false, execute);
  expect(actions.map(action => action.label)).toEqual(['autoMode.startDj']);
  actions[0].onSelect();
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'djSelection', label: 'Album', queueToken: 'empty', programToken: 'dj', tracks: [expect.objectContaining({ source: 'local', id: 'song' })] });
  state = { ...state, queueToken: 'refilled' }; actions[0].onSelect();
  expect(execute).toHaveBeenCalledTimes(2);
  for (const changed of [{ ...state, generation: 2 }, { ...state, programToken: 'changed' }]) {
    state = changed; actions[0].onSelect();
  }
  expect(execute).toHaveBeenCalledTimes(2);
});
it('filters podcasts and blocks oversized selections', () => {
  const execute = vi.fn(async () => {});
  const music = [...tracks, { ...tracks[0], id: 'pod', media_kind: 'podcast_episode' as const }];
  nativeDjSourceActions('a', 'A', music, () => empty, () => true, () => false, execute)[0].onSelect();
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ tracks: [expect.objectContaining({ id: 'song' })] }));
  expect(nativeDjSourceActions('a', 'A', Array.from({ length: 1001 }, () => tracks[0]), () => empty, () => true, () => false, execute)[0].disabled).toBe(true);
});
