import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutopilotController,
  buildLocalCandidates,
  selectAutoBatch,
  type AutoCandidate,
  type AutoModeState,
  type AutoSnapshot,
  type AutoSource,
} from './autopilot';
import type { Track } from '../types/music';

const track = (id: string, artist = `artist-${id}`, extra: Partial<Track> = {}): Track => ({
  id,
  title: `title-${id}`,
  artist,
  ...extra,
});

const candidate = (source: AutoSource, id: string, artist?: string): AutoCandidate => ({
  track: track(id, artist),
  source,
  reasonKey: `reason.${source}`,
});

afterEach(() => vi.useRealTimers());

describe('Auto Mode selection core', () => {
  it('places favourites first in the local pool', () => {
    const out = buildLocalCandidates([track('a'), track('b'), track('c')], ['b'], () => 0);
    expect(out[0].track.id).toBe('b');
    expect(out[0].reasonKey).toBe('autoMode.reason.favorite');
  });

  it('uses the selected profile quotas when every source has candidates', () => {
    const pools = {
      local: Array.from({ length: 8 }, (_, i) => candidate('local', `l${i}`)),
      related: Array.from({ length: 8 }, (_, i) => candidate('related', `r${i}`)),
      node: Array.from({ length: 8 }, (_, i) => candidate('node', `n${i}`)),
    };
    const familiar = selectAutoBatch(pools, 'familiar', 8, new Set());
    const balanced = selectAutoBatch(pools, 'balanced', 8, new Set());
    const explore = selectAutoBatch(pools, 'explore', 8, new Set());
    const count = (items: AutoCandidate[], source: AutoSource) => items.filter((item) => item.source === source).length;

    expect([count(familiar, 'local'), count(familiar, 'related'), count(familiar, 'node')]).toEqual([4, 3, 1]);
    expect([count(balanced, 'local'), count(balanced, 'related'), count(balanced, 'node')]).toEqual([2, 3, 3]);
    expect([count(explore, 'local'), count(explore, 'related'), count(explore, 'node')]).toEqual([1, 3, 4]);
  });

  it('caps local tracks when external candidates exist so discovery is not crowded out', () => {
    const pools = {
      local: Array.from({ length: 8 }, (_, i) => candidate('local', `l${i}`)),
      related: [candidate('related', 'r0'), candidate('related', 'r1')],
      node: [],
    };
    const explore = selectAutoBatch(pools, 'explore', 8, new Set());
    // explore permits ceil(8 * 1/8) = 1 local; the two related fill, the rest
    // miss rather than silently becoming library tracks.
    expect(explore.filter((item) => item.source === 'local').length).toBeLessThanOrEqual(1);
    expect(explore.filter((item) => item.source === 'related')).toHaveLength(2);
  });

  it('lifts the local cap when no external candidates exist so playback still fills', () => {
    const pools = {
      local: Array.from({ length: 8 }, (_, i) => candidate('local', `l${i}`)),
      related: [],
      node: [],
    };
    const out = selectAutoBatch(pools, 'explore', 5, new Set());
    expect(out).toHaveLength(5);
    expect(out.every((item) => item.source === 'local')).toBe(true);
  });

  it('deduplicates preview/local twins and caps an artist at two per batch', () => {
    const pools = {
      local: [candidate('local', 'local-a', 'Same')],
      related: [candidate('related', 'video-a', 'Same'), candidate('related', 'r2', 'Same'), candidate('related', 'r3', 'Same')],
      node: [candidate('node', 'n1', 'Other')],
    };
    pools.local[0].track.youtube_id = 'video-a';
    const out = selectAutoBatch(pools, 'balanced', 8, new Set());

    expect(out.filter((item) => item.track.artist === 'Same')).toHaveLength(2);
    expect(out.filter((item) => ['local-a', 'video-a'].includes(item.track.id))).toHaveLength(1);
  });
});

describe('AutopilotController queue ownership', () => {
  it('keeps the user queue, appends only the missing lookahead, and leaves it on stop', async () => {
    const userQueue = [track('current'), track('manual-1'), track('manual-2')];
    const snapshot: AutoSnapshot = {
      currentTrack: userQueue[0],
      queue: userQueue.slice(),
      index: 0,
      library: Array.from({ length: 12 }, (_, i) => track(`library-${i}`)),
      favorites: [],
    };
    const patches: Partial<AutoModeState>[] = [];
    const controller = new AutopilotController({
      snapshot: () => snapshot,
      patchState: (patch) => patches.push(patch),
      append: (items) => {
        snapshot.queue.push(...items.map((item) => item.track));
        return items;
      },
      replaceUpcoming: vi.fn(),
      getRelated: vi.fn().mockResolvedValue([]),
      getNodeCandidates: vi.fn().mockResolvedValue([]),
    }, 'balanced');

    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(snapshot.queue.slice(0, 3).map((item) => item.id)).toEqual(['current', 'manual-1', 'manual-2']);
    expect(snapshot.queue).toHaveLength(9); // current + eight upcoming
    expect(patches).toContainEqual(expect.objectContaining({
      activity: expect.objectContaining({
        status: 'working',
        key: 'autoMode.agent.searching',
        values: { title: 'title-current' },
      }),
    }));
    expect(patches).toContainEqual(expect.objectContaining({
      activity: expect.objectContaining({
        status: 'done',
        key: 'autoMode.agent.queued',
        values: expect.objectContaining({ count: 6, related: 0, node: 0, local: 12 }),
      }),
    }));
    controller.stop();
    expect(snapshot.queue).toHaveLength(9);
    expect(patches.at(-1)).toEqual(expect.objectContaining({ active: false }));
  });

  it('folds chart candidates into the node pool and artist candidates into related', async () => {
    const snapshot: AutoSnapshot = {
      currentTrack: track('current'),
      queue: [track('current')],
      index: 0,
      library: [],
      favorites: [],
    };
    const controller = new AutopilotController({
      snapshot: () => snapshot,
      patchState: vi.fn(),
      append: (items) => {
        snapshot.queue.push(...items.map((item) => item.track));
        return items;
      },
      replaceUpcoming: vi.fn(),
      getRelated: vi.fn().mockResolvedValue([]),
      getNodeCandidates: vi.fn().mockResolvedValue([]),
      getChartCandidates: vi.fn().mockResolvedValue([candidate('node', 'chart-1'), candidate('node', 'chart-2')]),
      getArtistCandidates: vi.fn().mockResolvedValue([candidate('related', 'artist-1')]),
    }, 'explore');

    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ids = snapshot.queue.map((item) => item.id);
    expect(ids).toContain('chart-1');
    expect(ids).toContain('artist-1');
    controller.stop();
  });

  it('replaces the upcoming tail with a fresh lookahead when the profile changes', async () => {
    const snapshot: AutoSnapshot = {
      currentTrack: track('current'),
      queue: [track('current')],
      index: 0,
      // Larger than 2×lookahead so the replan, which excludes the just-queued
      // tail as "recent", still has enough fresh library tracks to fill.
      library: Array.from({ length: 24 }, (_, i) => track(`library-${i}`)),
      favorites: [],
    };
    const replaceUpcoming = vi.fn((items: AutoCandidate[]) => {
      snapshot.queue = [...snapshot.queue.slice(0, snapshot.index + 1), ...items.map((item) => item.track)];
      return items;
    });
    const controller = new AutopilotController({
      snapshot: () => snapshot,
      patchState: vi.fn(),
      append: (items) => {
        snapshot.queue.push(...items.map((item) => item.track));
        return items;
      },
      replaceUpcoming,
      getRelated: vi.fn().mockResolvedValue([]),
      getNodeCandidates: vi.fn().mockResolvedValue([]),
    }, 'balanced');

    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(snapshot.queue).toHaveLength(9); // current + eight from the first plan
    expect(replaceUpcoming).not.toHaveBeenCalled(); // start appends, never replaces

    controller.setProfile('explore');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The current track is preserved and the tail is swapped for a full, fresh
    // lookahead — so the very next track already reflects the new profile.
    expect(replaceUpcoming).toHaveBeenCalledOnce();
    expect(snapshot.queue[0].id).toBe('current');
    expect(snapshot.queue).toHaveLength(9);
    controller.stop();
  });
});
