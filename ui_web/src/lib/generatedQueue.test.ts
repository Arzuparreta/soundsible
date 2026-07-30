import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueueEntry, type PlaybackQueueEntry } from './playbackQueue';
import {
  GeneratedQueueController,
  type GeneratedQueueDeps,
} from './generatedQueue';
import type { ListeningPlanIntent, ListeningPlanResponse } from './api';
import type { Track } from '../types/music';

const seed: Track = { id: 'seed', title: 'Seed', artist: 'Artist' };

function response(intent: ListeningPlanIntent, count = 8): ListeningPlanResponse {
  return {
    v: 1,
    plan_id: `plan-${intent}`,
    intent,
    profile: 'balanced',
    seed_identity: 'seed',
    degraded: false,
    generated_at: 1,
    pool_counts: { local: 2, related: 3, discovery: 3 },
    items: Array.from({ length: count }, (_, index) => ({
      id: `${intent}-${index}`,
      youtube_id: `${intent}-${index}`,
      title: `Track ${index}`,
      artist: `Artist ${index}`,
      source: 'preview' as const,
      source_pool: 'related' as const,
      recommendation_identity: `music:${intent}:${index}`,
      recommendation_source: intent,
    })),
  };
}

function harness() {
  let queue: PlaybackQueueEntry[] = [createQueueEntry(seed, 'context', 'single')];
  let index = 0;
  const requestPlan = vi.fn(async (
    intent: ListeningPlanIntent,
    _profile: 'familiar' | 'balanced' | 'explore',
    _seed: Track,
    _limit: number,
    _exclude: string[],
    _signal: AbortSignal,
  ) => response(intent));
  const applyPlan = vi.fn((intent: ListeningPlanIntent, plan: ListeningPlanResponse, replace: boolean) => {
    const generated = plan.items.map((item) => createQueueEntry(
      {
        id: item.id,
        title: item.title,
        artist: item.artist,
        source: 'preview',
      },
      'generated',
      intent,
    ));
    queue = replace ? [...queue.slice(0, index + 1), ...generated] : [...queue, ...generated];
    return generated.length;
  });
  const onStatus = vi.fn();
  const deps: GeneratedQueueDeps = {
    snapshot: () => ({ currentTrack: queue[index] ?? null, queue, index }),
    requestPlan,
    applyPlan,
    onStatus,
    identity: (track) => track.youtube_id || track.id,
  };
  return {
    controller: new GeneratedQueueController(deps),
    requestPlan,
    applyPlan,
    onStatus,
    queue: () => queue,
    setIndex: (value: number) => { index = value; },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GeneratedQueueController', () => {
  it('sends Radio, Autoplay, and Auto Mode through the same planner contract', async () => {
    const radio = harness();
    await radio.controller.start('radio', seed);
    const radioCall = radio.requestPlan.mock.calls[0];
    expect(radioCall[0]).toBe('radio');
    expect(radioCall[1]).toBe('balanced');
    expect(radioCall[2]).toMatchObject(seed);
    expect(radioCall[3]).toBe(8);
    expect(radioCall[4]).toEqual(expect.any(Array));
    expect(radioCall[5]).toBeInstanceOf(AbortSignal);
    radio.controller.stop();

    const autoplay = harness();
    await autoplay.controller.ensureAutoplay(seed, true);
    expect(autoplay.requestPlan.mock.calls[0][0]).toBe('autoplay');
    autoplay.controller.stop();

    const auto = harness();
    await auto.controller.start('auto_mode', seed, 'explore');
    expect(auto.requestPlan.mock.calls[0][0]).toBe('auto_mode');
    expect(auto.requestPlan.mock.calls[0][1]).toBe('explore');
    auto.controller.stop();
  });

  it('continuously refills Radio when its generated runway drops below four', async () => {
    const h = harness();
    await h.controller.start('radio', seed);
    h.setIndex(6);

    await h.controller.ensureRunway();

    expect(h.requestPlan).toHaveBeenCalledTimes(2);
    expect(h.requestPlan.mock.calls[1][2]).toMatchObject(seed);
    h.controller.stop();
  });

  it('replaces the Auto Mode tail immediately when its profile changes', async () => {
    const h = harness();
    await h.controller.start('auto_mode', seed);

    await h.controller.replan('familiar');

    expect(h.requestPlan).toHaveBeenLastCalledWith(
      'auto_mode',
      'familiar',
      expect.any(Object),
      8,
      expect.any(Array),
      expect.any(AbortSignal),
    );
    expect(h.applyPlan).toHaveBeenLastCalledWith(
      'auto_mode',
      expect.any(Object),
      true,
      expect.any(Object),
    );
    expect(h.onStatus).toHaveBeenCalledWith(
      'auto_mode',
      'planning',
      undefined,
      true,
    );
    expect(h.onStatus).toHaveBeenLastCalledWith(
      'auto_mode',
      'ready',
      expect.any(Object),
      true,
    );
    h.controller.stop();
  });

  it('reports a partial but playable plan as ready instead of a retry failure', async () => {
    const h = harness();
    h.requestPlan.mockResolvedValueOnce({ ...response('radio'), degraded: true });

    await h.controller.start('radio', seed);

    expect(h.onStatus).toHaveBeenLastCalledWith(
      'radio',
      'ready',
      expect.objectContaining({ degraded: true }),
      false,
    );
    h.controller.stop();
  });

  it('does not attach a plan after the session is stopped', async () => {
    let resolvePlan!: (value: ListeningPlanResponse) => void;
    const h = harness();
    h.requestPlan.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePlan = resolve;
    }));

    const starting = h.controller.start('radio', seed);
    h.controller.stop('radio');
    resolvePlan(response('radio'));
    await starting;

    expect(h.applyPlan).not.toHaveBeenCalled();
  });
});
