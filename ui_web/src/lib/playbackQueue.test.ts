import { describe, expect, it } from 'vitest';
import { contextContinuation, createQueueEntry, isPendingEntry, upcomingQueueEntries, type PlaybackContextDescriptor } from './playbackQueue';
import type { Track } from '../types/music';

const album: PlaybackContextDescriptor = { id: 'album:record', kind: 'album', label: 'Record' };
const song = (id: string): Track => ({ id, title: id, artist: 'Band' });
const context = (...ids: string[]) =>
  ids.map((id, index) => createQueueEntry(song(id), 'context', 'album', album, index));
const request = (id: string) => createQueueEntry(song(id), 'manual', 'add_to_queue');

describe('the context continuation', () => {
  it('stands for what is left of the context, behind the requests', () => {
    const [a, b, c] = context('a', 'b', 'c');
    const queue = [a, request('asked'), b, c];
    const next = contextContinuation(queue, 0, false);
    expect(next?.context).toEqual(album);
    expect(next?.remaining).toBe(2);
    expect(next?.next).toBe(b);
  });

  it('is gone once nothing of the context is left to play', () => {
    const [a, b] = context('a', 'b');
    expect(contextContinuation([a, b, request('asked')], 1, false)).toBeNull();
    // Requests and generated music are never a context.
    expect(contextContinuation([a, request('x'), createQueueEntry(song('g'), 'generated', 'autoplay')], 0, false))
      .toBeNull();
  });

  it('goes round again with repeat-all, as long as there is something to come back to', () => {
    const [a, b] = context('a', 'b');
    const next = contextContinuation([a, b], 1, true);
    expect(next?.remaining).toBe(0);
    expect(next?.next).toBe(a);
    // A context of one song repeating is the song repeating, not a continuation.
    expect(contextContinuation([b], 0, true)).toBeNull();
  });
});

describe('unmatched context songs', () => {
  it('keeps the catalog reference on the occurrence', () => {
    const entry = createQueueEntry(
      { ...song('pending:x'), source: 'preview', pendingResolve: { catalogItemId: 'deezer:x', artist: 'Band', title: 'x' } },
      'context', 'album', album, 0,
    );
    expect(isPendingEntry(entry)).toBe(true);
    expect(isPendingEntry({ ...entry, pendingResolve: undefined })).toBe(false);
    expect(isPendingEntry(null)).toBe(false);
  });
});

describe('upcomingQueueEntries', () => {
  it('keeps manual requests in Normal mode, includes generated picks in Radio mode, returns the full route in Auto mode, and treats omitted index as -1', () => {
    const manual = request('m1');
    const ctx = createQueueEntry(song('c1'), 'context', 'album', album, 0);
    const radio = createQueueEntry(song('r1'), 'generated', 'radio');
    const autoplay = createQueueEntry(song('a1'), 'generated', 'autoplay');
    const playing = request('cur');
    const queue = [playing, manual, ctx, radio, autoplay];

    expect(upcomingQueueEntries(queue, 0, { auto: false, radioMode: false })).toEqual([manual]);
    expect(upcomingQueueEntries(queue, 0, { auto: false, radioMode: true })).toEqual([manual, radio, autoplay]);
    expect(upcomingQueueEntries(queue, 0, { auto: true })).toEqual([manual, ctx, radio, autoplay]);
    expect(upcomingQueueEntries([manual, ctx], undefined, { auto: false, radioMode: false })).toEqual([manual]);
  });
});
