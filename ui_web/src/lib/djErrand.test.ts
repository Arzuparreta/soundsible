import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./toast', () => ({ toast: { info: vi.fn() } }));

import { beginDjErrand, djErrand, endDjErrand, withDjErrand } from './djErrand';
import type { PlayerActions } from '../stores/contracts';
import type { Track } from '../types/music';

const song: Track = { id: 's1', title: 'One', artist: 'A' };
const other: Track = { id: 's2', title: 'Two', artist: 'A' };

function actions() {
  return {
    playTrack: vi.fn(),
    playNow: vi.fn(),
    playFrom: vi.fn(),
    playShuffled: vi.fn(),
    startDjSelection: vi.fn(() => true),
    startDjFromTrack: vi.fn().mockResolvedValue(true),
    placeAutoTrack: vi.fn().mockResolvedValue(undefined),
    placeAutoTracks: vi.fn().mockResolvedValue(undefined),
    useAutoTrackAsSource: vi.fn(),
    addAutoSource: vi.fn(),
    changeAutoSession: vi.fn().mockResolvedValue(true),
    beginAutoSessionChange: vi.fn(() => 8),
    autoSessionToken: vi.fn(() => 7),
    pausePlayback: vi.fn(),
    enqueue: vi.fn(),
  } as unknown as PlayerActions & Record<string, ReturnType<typeof vi.fn>>;
}

afterEach(() => endDjErrand(false));

describe('DJ errands', () => {
  it('leaves the actions alone while no errand is open', () => {
    const base = actions();
    expect(withDjErrand(base)).toBe(base);
  });

  it('turns the next song played into the errand, and closes it', () => {
    const base = actions();
    const end = vi.fn();
    beginDjErrand({ kind: 'route', beforeQueueId: 'q-4' }, end);
    withDjErrand(base).playFrom([other, song], 1, { context: { id: 'x', kind: 'library', label: 'Library' } });
    expect(base.placeAutoTrack).toHaveBeenCalledWith(song, 'q-4');
    expect(base.playFrom).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledWith(true);
    expect(djErrand()).toBeNull();
    // Closed: the next play is a play again.
    withDjErrand(base).playTrack(song);
    expect(base.playTrack).toHaveBeenCalledWith(song);
  });

  it('takes a collection whole for mixing or changing, and song by song at a seam', () => {
    const base = actions();
    beginDjErrand({ kind: 'reference' });
    withDjErrand(base).startDjSelection([song, other], 'Record');
    expect(base.addAutoSource).toHaveBeenCalledWith([song, other], 'Record');

    beginDjErrand({ kind: 'change' });
    withDjErrand(base).playShuffled([song, other], { id: 'p', kind: 'playlist', label: 'Mix' });
    expect(base.changeAutoSession).toHaveBeenCalledWith([song, other], 'Mix');

    beginDjErrand({ kind: 'route' });
    withDjErrand(base).startDjSelection([song, other], 'Record');
    expect(base.placeAutoTracks).toHaveBeenCalledWith([song, other], undefined);
  });

  it('leaves what does not play — and a radio the store starts — untouched', () => {
    const base = actions();
    beginDjErrand({ kind: 'reference' });
    const wrapped = withDjErrand(base);
    wrapped.pausePlayback();
    wrapped.enqueue(song);
    wrapped.playFrom([song], 0, { radio: true });
    expect(base.pausePlayback).toHaveBeenCalled();
    expect(base.enqueue).toHaveBeenCalledWith(song);
    expect(base.playFrom).toHaveBeenCalledWith([song], 0, { radio: true });
    expect(djErrand()).toEqual({ kind: 'reference' });
  });

  it('keeps the playing session while a catalog collection is matched for it', () => {
    const base = actions();
    beginDjErrand({ kind: 'reference' });
    expect(withDjErrand(base).beginAutoSessionChange()).toBe(7);
    beginDjErrand({ kind: 'change' });
    expect(withDjErrand(base).beginAutoSessionChange()).toBe(8);
  });

  it('cancels the errand an open one replaces', () => {
    const first = vi.fn();
    beginDjErrand({ kind: 'reference' }, first);
    beginDjErrand({ kind: 'change' });
    expect(first).toHaveBeenCalledWith(false);
    expect(djErrand()).toEqual({ kind: 'change' });
  });
});
