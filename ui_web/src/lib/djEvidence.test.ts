import { describe, expect, it } from 'vitest';
import { DjEvidence, pairObservations } from './djEvidence';
import type { DjTransitionPlan, ListeningPlanResponse } from './api';
import type { DiagnosticFacts } from './playbackDiagnostics';

const plan = { technique: 'bass_swap', out_cue: 200, in_cue: 10, overlap_seconds: 16,
  overlap_bars: 8, playback_rate: 1.01, confidence: 0.9, score: 0.8, fallback: false } satisfies DjTransitionPlan;
const response = { plan_id: 'plan', session_id: 'planner', segment_index: 0 } as ListeningPlanResponse;
function recorder() {
  const rows: Array<{ event: string; facts: DiagnosticFacts }> = [];
  let serial = 0, time = 0;
  const evidence = new DjEvidence((event, facts) => rows.push({ event, facts }), () => `opaque-${++serial}`, () => time);
  return { evidence, rows, tick: () => { time += 1000; } };
}

describe('linked DJ evidence', () => {
  it('links selection and accepted refinement while isolating repeated arm attempts', () => {
    const { evidence, rows } = recorder();
    evidence.start(1);
    evidence.select('private-song', 'occurrence', { analysed: false }, { analysed: false }, plan, response);
    const first = evidence.arm('private-song', 'occurrence', plan, false, true);
    evidence.refine('private-song', 'occurrence', { analysed: true }, { analysed: true }, plan, false);
    const rejected = evidence.arm('private-song', 'occurrence', plan, false, true);
    expect(rows.filter(r => r.event === 'dj.committed').at(-1)?.facts.fromAnalysed).toBe(false);
    evidence.refine('private-song', 'occurrence', { analysed: true }, { analysed: true }, plan, true);
    const refined = evidence.arm('private-song', 'occurrence', plan, false, true);
    expect(first.edgeId).toBe(refined.edgeId);
    expect(first.ordinal).toBe(refined.ordinal);
    expect(first.transitionId).not.toBe(rejected.transitionId);
    expect(refined.transitionId).not.toBe(rejected.transitionId);
    expect(rows.filter(r => r.event === 'dj.committed').at(-1)?.facts).toMatchObject({ fromAnalysed: true, score: 0.8 });
    expect(rows.find(r => r.event === 'dj.selected')?.facts.fromAnalysed).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('private-song');
  });

  it('changes edge with the predecessor and preserves late outcome ownership across sessions', () => {
    const { evidence, rows, tick } = recorder();
    evidence.start(1);
    const old = evidence.arm('song-a', 'occurrence', plan, false, true);
    const repaired = evidence.arm('song-b', 'occurrence', plan, false, true);
    expect(repaired.edgeId).not.toBe(old.edgeId);
    evidence.start(2); tick(); evidence.outcome(old, 'completed');
    expect(rows.at(-1)?.facts.djSession).toBe(old.djSession);
    expect(rows.at(-1)?.facts.djSession).not.toBe(evidence.context().djSession);
  });

  it('marks restored starts and direction changes and preserves unknown measurements', () => {
    const { evidence, rows } = recorder();
    evidence.sync(true, 2); evidence.sync(true, 3);
    expect(rows[0].facts.startKnown).toBe(false);
    expect(rows[1].event).toBe('dj.direction_changed');
    expect(pairObservations(undefined, { analysed: true, note_rate: 0 })).toMatchObject({ fromAnalysed: null, toAnalysed: true, notesDelta: null });
    expect(pairObservations({ note_rate: 0 }, { note_rate: 1 }).notesDelta).toBe(1);
  });

  it('cannot throw recorder failures into playback', () => {
    const evidence = new DjEvidence(() => { throw new Error('storage'); }, () => 'id');
    expect(() => { evidence.start(0); evidence.arm('a', 'b', plan, true, false); evidence.end('exit'); }).not.toThrow();
  });
});
