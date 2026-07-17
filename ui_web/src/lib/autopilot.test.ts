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
      removeGeneratedFuture: vi.fn(),
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

  it('removes only generated future identities before rebuilding a profile', async () => {
    const snapshot: AutoSnapshot = {
      currentTrack: track('current'),
      queue: [track('current')],
      index: 0,
      library: Array.from({ length: 12 }, (_, i) => track(`library-${i}`)),
      favorites: [],
    };
    const removeGeneratedFuture = vi.fn();
    const controller = new AutopilotController({
      snapshot: () => snapshot,
      patchState: vi.fn(),
      append: (items) => {
        snapshot.queue.push(...items.map((item) => item.track));
        return items;
      },
      removeGeneratedFuture,
      getRelated: vi.fn().mockResolvedValue([]),
      getNodeCandidates: vi.fn().mockResolvedValue([]),
    }, 'balanced');

    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.setProfile('explore');

    expect(removeGeneratedFuture).toHaveBeenCalledOnce();
    const generated = removeGeneratedFuture.mock.calls[0][0] as Set<string>;
    expect(generated.has('current')).toBe(false);
    expect(generated.size).toBeGreaterThan(0);
    controller.stop();
  });
});
