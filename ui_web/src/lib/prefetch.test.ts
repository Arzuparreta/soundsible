import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';

const apiMock = vi.hoisted(() => ({
  prefetchPreviews: vi.fn(() => Promise.resolve({
    status: 'queued',
    preparation: undefined as Record<string, { state: string; [key: string]: unknown }> | undefined,
  })),
  previewStatuses: vi.fn(() => Promise.resolve({ preparation: {} })),
}));
vi.mock('./api', () => ({ api: apiMock }));

import {
  prefetchPreviews,
  previewPreparation,
  previewPreparationState,
  upcomingPreviewIds,
} from './prefetch';

const preview = (id: string): Track => ({ id, title: id, artist: 'A', source: 'preview' });
const local = (id: string): Track => ({ id, title: id, artist: 'A' });
const podcast = (id: string): Track => ({
  id,
  title: id,
  artist: 'A',
  source: 'preview',
  podcast_episode_guid: id,
});

describe('upcomingPreviewIds', () => {
  it('collects the next previews in linear order, skipping local tracks and podcasts', () => {
    const queue = [local('l1'), podcast('p0'), preview('v1'), local('l2'), preview('v2'), preview('v3')];
    expect(upcomingPreviewIds(queue, 0, false)).toEqual(['v1', 'v2']);
  });

  it('stops at the end of the queue unless repeat-all wraps around', () => {
    const queue = [preview('v1'), local('l1'), preview('v2')];
    expect(upcomingPreviewIds(queue, 2, false)).toEqual([]);
    expect(upcomingPreviewIds(queue, 2, true)).toEqual(['v1']);
  });

  it('handles an empty queue', () => {
    expect(upcomingPreviewIds([], 0, true)).toEqual([]);
  });
});

describe('prefetchPreviews', () => {
  beforeEach(() => {
    apiMock.prefetchPreviews.mockClear();
    apiMock.previewStatuses.mockClear();
  });

  it('drops non-YouTube ids and dedupes recently warmed ids', () => {
    prefetchPreviews(['AbC123-_xyz', 'not an id', 'pcast_guid']);
    expect(apiMock.prefetchPreviews).toHaveBeenCalledTimes(1);
    expect(apiMock.prefetchPreviews).toHaveBeenCalledWith(['AbC123-_xyz'], false);

    apiMock.prefetchPreviews.mockClear();
    prefetchPreviews(['AbC123-_xyz']); // still warm → skipped entirely
    expect(apiMock.prefetchPreviews).not.toHaveBeenCalled();
  });

  it('lets download requests through even for warm ids (server dedupes on disk)', () => {
    prefetchPreviews(['zzz123-_AAA']);
    apiMock.prefetchPreviews.mockClear();
    prefetchPreviews(['zzz123-_AAA'], { download: true });
    expect(apiMock.prefetchPreviews).toHaveBeenCalledWith(['zzz123-_AAA'], true);
  });

  it('never sends an empty batch', () => {
    prefetchPreviews(['nope']);
    expect(apiMock.prefetchPreviews).not.toHaveBeenCalled();
  });

  it('allows a retry when the engine rejects a warm-up request', async () => {
    apiMock.prefetchPreviews.mockRejectedValueOnce(new Error('offline'));

    prefetchPreviews(['retry12-_AB']);
    await vi.waitFor(() => expect(apiMock.prefetchPreviews).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    prefetchPreviews(['retry12-_AB']);
    expect(apiMock.prefetchPreviews).toHaveBeenCalledTimes(2);
  });

  it('does not call accepted preparation ready until the engine confirms disk bytes', async () => {
    apiMock.prefetchPreviews.mockResolvedValueOnce({
      status: 'queued',
      preparation: { 'pending1-_A': { state: 'pending' } },
    });

    prefetchPreviews(['pending1-_A'], { download: true });
    await vi.waitFor(() => expect(previewPreparationState('pending1-_A')).toBe('pending'));
    expect(previewPreparationState('pending1-_A')).not.toBe('ready');
    apiMock.prefetchPreviews.mockClear();
    prefetchPreviews(['pending1-_A'], { download: true });
    expect(apiMock.prefetchPreviews).not.toHaveBeenCalled();
  });

  it('keeps measured streamable progress observable without treating it as Auto-ready', async () => {
    apiMock.prefetchPreviews.mockResolvedValueOnce({
      status: 'queued',
      preparation: {
        'stream001_A': {
          state: 'streamable', downloaded_bytes: 500, total_bytes: 1000,
          progress: 0.5, buffered_seconds: 8, eta_seconds: 4,
        },
      },
    });

    prefetchPreviews(['stream001_A'], { download: true });
    await vi.waitFor(() => expect(previewPreparationState('stream001_A')).toBe('streamable'));
    expect(previewPreparation('stream001_A')).toMatchObject({
      downloaded_bytes: 500,
      total_bytes: 1000,
      progress: 0.5,
      buffered_seconds: 8,
      eta_seconds: 4,
    });
    expect(previewPreparationState('stream001_A')).not.toBe('ready');
  });

  it('notifies the runway owner only when the engine reports a terminal verdict', async () => {
    const onStatus = vi.fn();
    apiMock.prefetchPreviews.mockResolvedValueOnce({
      status: 'queued',
      preparation: { 'status12-_A': { state: 'pending' } },
    });
    apiMock.previewStatuses.mockResolvedValueOnce({
      preparation: { 'status12-_A': { state: 'ready', size: 1234 } },
    });

    prefetchPreviews(['status12-_A'], { download: true, onStatus });
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith('status12-_A', { state: 'pending' }));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(
      'status12-_A',
      { state: 'ready', size: 1234 },
    ));
  });

  it('re-submits an accepted download if the engine later reports it cold', async () => {
    apiMock.prefetchPreviews.mockResolvedValue({
      status: 'queued',
      preparation: { 'restart1-_A': { state: 'pending' } },
    });
    apiMock.previewStatuses.mockResolvedValueOnce({
      preparation: { 'restart1-_A': { state: 'cold' } },
    });

    prefetchPreviews(['restart1-_A'], { download: true });
    await vi.waitFor(() => expect(apiMock.prefetchPreviews).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await vi.waitFor(() => expect(apiMock.prefetchPreviews).toHaveBeenCalledTimes(2));
  });
});
