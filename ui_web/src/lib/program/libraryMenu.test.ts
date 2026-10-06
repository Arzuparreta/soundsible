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
it('places a DJ request in the captured programme and keeps external URLs out of the command', () => {
  let state = { ...initial, programToken: 'dj-owner', dj: { active: true, phase: 'ready', profile: 'adaptive' } } as ProgramState;
  const execute = vi.fn(async () => {});
  const menu = programLibraryMenu({ ...track, url: 'https://untrusted.invalid' } as Track, () => state, () => false, execute);
  const action = menu.actions!.find(item => item.label === 'autoMode.dj.routeAction')!;
  action.onSelect();
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'djRequest', programToken: 'dj-owner', queueToken: 'order', tracks: [{ ...track, source: 'local' }] });
  for (const changed of [{ ...state, queueToken: 'refilled' }, { ...state, programToken: 'new-programme' }, { ...state, generation: 2 }]) {
    state = changed; action.onSelect();
  }
  expect(execute).toHaveBeenCalledTimes(1);
});
it('keeps podcasts out of a DJ route while leaving their explicit Play flow separate', () => {
  const state = { ...initial, programToken: 'dj-owner', dj: { active: true, phase: 'ready', profile: 'adaptive' } } as ProgramState;
  const podcast = { ...track, media_kind: 'podcast_episode', podcast_episode_guid: 'episode', podcast_feed_id: 'feed' };
  const execute = vi.fn(async () => {});
  const menu = programLibraryMenu(podcast, () => state, () => false, execute);
  expect(menu.actions!.every(action => action.disabled)).toBe(true);
  menu.actions!.forEach(action => action.onSelect());
  expect(execute).not.toHaveBeenCalled();
});
it('starts radio from the actual current music occurrence without replacing audio', () => {
  const state = { ...initial, index: 0, items: [{ ...track, source: 'local', key: 'current' }] } as ProgramState;
  const execute = vi.fn(async () => {});
  const menu = programLibraryMenu(track, () => state, () => false, execute);
  menu.actions!.find(action => action.label === 'trackActions.startRadio')!.onSelect();
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'radio', enabled: true, profile: 'balanced', queueToken: 'order', key: 'current' });
});
it('stops native radio through an explicit contextual action', () => {
  const state = { ...initial, index: 0, items: [{ ...track, source: 'local', key: 'current' }], radio: { active: true, phase: 'ready', profile: 'explore' } } as ProgramState;
  const execute = vi.fn(async () => {});
  programLibraryMenu(track, () => state, () => false, execute).actions!.find(action => action.label === 'nowPlaying.stopRadioConfirm')!.onSelect();
  expect(execute).toHaveBeenCalledWith({ action: 'radio', enabled: false, profile: 'explore', queueToken: 'order', key: 'current' });
});

it('replans a selected radio profile and rejects selection after the seed occurrence advances', () => {
  let state = { ...initial, index: 0, items: [{ ...track, source: 'local', key: 'current' }], radio: { active: true, phase: 'ready', profile: 'balanced' } } as ProgramState;
  const execute = vi.fn(async () => {});
  const menu = programLibraryMenu(track, () => state, () => false, execute);
  menu.actions!.find(action => action.label === 'autoMode.profile.explore')!.onSelect();
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'radio', enabled: true, profile: 'explore', queueToken: 'order', key: 'current' });
  state = { ...state, items: [{ ...state.items[0], key: 'next-occurrence' }] };
  menu.actions!.find(action => action.label === 'autoMode.profile.familiar')!.onSelect();
  expect(execute).toHaveBeenCalledTimes(1);
});
it('starts a song context without passing URLs or switching playback directly', () => {
  const execute = vi.fn(async () => {});
  const menu = programLibraryMenu({ ...track, url: 'https://external.invalid' } as Track, () => initial, () => false, execute);
  menu.actions!.find(action => action.label === 'musicExplorer.startDjFromSong')!.onSelect();
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'djContext', tracks: [{ ...track, source: 'local' }], queueToken: 'order', programToken: undefined, key: 'second' });
});
it('rejects a deferred context after the current programme or order changed', () => {
  let state = initial; const execute = vi.fn(async () => {});
  const action = programLibraryMenu(track, () => state, () => false, execute).actions!.find(action => action.label === 'musicExplorer.startDjFromSong')!;
  state = { ...initial, programToken: 'different' }; action.onSelect();
  state = { ...initial, queueToken: 'different' }; action.onSelect();
  expect(execute).not.toHaveBeenCalled();
});
it('adds a source from normalized metadata while preserving newer directions', () => {
  let state = { ...initial, programToken: 'dj', dj: { active: true, phase: 'ready', profile: 'adaptive', sources: [] } } as ProgramState;
  const execute = vi.fn(async () => {});
  const action = programLibraryMenu(track, () => state, () => false, execute).actions!.find(action => action.label === 'musicExplorer.reference')!;
  state = { ...state, dj: { ...state.dj!, sources: [{ id: 'newer', label: 'Newer', activation: 4, tracks: [{ ...track, id: 'other' }] }] } };
  action.onSelect();
  expect(execute).toHaveBeenCalledWith({ action: 'djSettings', programToken: 'dj', sources: [state.dj!.sources![0], { id: expect.any(String), label: 'Song', activation: 5, tracks: [{ ...track, source: undefined }] }] });
});
it('keeps duplicate sources and podcasts out of context actions', () => {
  const execute = vi.fn(async () => {});
  const state = { ...initial, programToken: 'dj', dj: { active: true, phase: 'ready', profile: 'adaptive', sources: [{ id: 'existing', label: 'Song', activation: 1, tracks: [track] }] } } as ProgramState;
  const reference = programLibraryMenu(track, () => state, () => false, execute).actions!.find(action => action.label === 'musicExplorer.reference')!;
  expect(reference.selected).toBe(true); expect(reference.disabled).toBe(true); reference.onSelect();
  expect(execute).not.toHaveBeenCalled();
  const podcastState = { ...initial, index: 0, items: [{ ...track, id: 'episode-id', source: 'podcast', mediaKind: 'podcast_episode', key: 'episode' }] } as ProgramState;
  const action = programLibraryMenu(track, () => podcastState, () => false, execute).actions!.find(action => action.label === 'musicExplorer.startDjFromSong')!;
  expect(action.disabled).toBe(true); action.onSelect();
  expect(execute).not.toHaveBeenCalled();
});
