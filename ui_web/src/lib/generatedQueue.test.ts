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
    _session?: { id: string; segmentIndex: number; context: Track[] },
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
    deps,
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
    expect(auto.requestPlan.mock.calls[0][6]).toMatchObject({
      id: expect.any(String),
      segmentIndex: 0,
      context: [expect.objectContaining({ id: 'seed' })],
    });
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
      expect.objectContaining({
        id: expect.any(String),
        segmentIndex: 1,
        context: expect.any(Array),
      }),
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

  it('keeps one stateless session lineage and advances only accepted segments', async () => {
    const h = harness();
    await h.controller.start('auto_mode', seed);
    const firstSession = h.requestPlan.mock.calls[0][6]!;

    h.applyPlan.mockReturnValueOnce(0);
    await h.controller.replan('balanced');
    const rejected = h.requestPlan.mock.calls[1][6]!;
    await h.controller.replan('explore');
    const retry = h.requestPlan.mock.calls[2][6]!;

    expect(firstSession.id).toBe(rejected.id);
    expect(rejected.segmentIndex).toBe(1);
    expect(retry.segmentIndex).toBe(1);
    h.controller.stop();

    const next = harness();
    await next.controller.start('auto_mode', seed);
    expect(next.requestPlan.mock.calls[0][6]!.id).not.toBe(firstSession.id);
    next.controller.stop();
  });

  it('continues the session lineage of an already planned source opening', async () => {
    const h = harness();
    h.controller.adopt('auto_mode', seed, 'balanced', {
      sessionId: 'source-session',
      nextSegmentIndex: 4,
    });

    await h.controller.ensureRunway();

    expect(h.requestPlan.mock.calls[0][6]).toMatchObject({
      id: 'source-session',
      segmentIndex: 4,
    });
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

  it('re-arms a starved runway when a session change hands planning back', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.start('auto_mode', seed);
    h.setIndex(6);
    h.requestPlan.mockResolvedValueOnce({ ...response('auto_mode', 0), empty_reason: 'temporary_failure' });

    await h.controller.ensureRunway();

    expect(h.requestPlan).toHaveBeenCalledTimes(2);
    expect(h.onStatus).toHaveBeenLastCalledWith('auto_mode', 'degraded', expect.any(Object), false);

    // Preparing a replacement direction throws the pending retry away.
    h.controller.suspendPlanning();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.requestPlan).toHaveBeenCalledTimes(2);

    // Handing the runway back must re-arm the chain the change interrupted:
    // there may be no track boundary left to wait for. It comes back at the
    // first backoff step, not the minute-long one the abandoned chain had
    // already climbed to.
    h.controller.resumePlanning();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(h.requestPlan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.requestPlan).toHaveBeenCalledTimes(3);
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


describe('exhausted DJ input', () => {
  it('does not retry an unchanged exhausted pool, but resumes on exploration changes and manual retry', async () => {
    vi.useFakeTimers();
    const h = harness();
    let context = 'initial';
    h.deps.planningContext = () => context;
    h.requestPlan.mockResolvedValue({ ...response('auto_mode', 0), empty_reason: 'exhausted' });
    await h.controller.start('auto_mode', seed);
    // The current song is already excluded in both paths.
    await h.controller.refillNow();
    const attempts = h.requestPlan.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    await h.controller.refillNow();
    await h.controller.ensureRunway();
    expect(h.requestPlan).toHaveBeenCalledTimes(attempts);
    expect(h.onStatus).toHaveBeenLastCalledWith('auto_mode', 'exhausted', expect.any(Object), false);
    context = 'heard-automatic-track';
    await h.controller.ensureRunway();
    expect(h.requestPlan).toHaveBeenCalledTimes(attempts + 1);
    await h.controller.retry();
    expect(h.requestPlan).toHaveBeenCalledTimes(attempts + 2);
    h.controller.stop();
  });

  it('stops repeating nonempty plans rejected entirely as duplicates', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.applyPlan.mockReturnValue(0);
    await h.controller.start('auto_mode', seed);
    await vi.advanceTimersByTimeAsync(180_000);
    await h.controller.ensureRunway();
    expect(h.requestPlan).toHaveBeenCalledTimes(1);
    expect(h.onStatus).toHaveBeenLastCalledWith('auto_mode', 'exhausted', expect.any(Object), false);
    h.controller.stop();
  });
});
