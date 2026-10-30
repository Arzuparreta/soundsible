import { describe, expect, it } from 'vitest';
import { createDjEvidence } from './djEvidence';
import { createDjEvidence as recorder } from './djEvidenceRecorder';
import type { DiagnosticFacts } from './playbackDiagnostics';
import type { LiveTransitionPlan } from './audio';

const plan: LiveTransitionPlan = { technique: 'safe_fade', out_cue: 10, in_cue: 0, overlap_seconds: 6, overlap_bars: 0, playback_rate: 1, confidence: 0 };
function setup() {
  const rows: Array<{ event: string; facts: DiagnosticFacts }> = [];
  let resolve!: (factory: typeof recorder) => void, loads = 0, serial = 0;
  const evidence = createDjEvidence((event, facts) => rows.push({ event, facts }), () => `id-${++serial}`, () => 0,
    () => { loads++; return new Promise(done => { resolve = done; }); });
  return { evidence, rows, loads: () => loads, ready: async () => { resolve(recorder); await Promise.resolve(); } };
}

describe('DJ-only recorder loading', () => {
  it('loads only when needed, preserves session ownership and replays setup in order', async () => {
    const { evidence, rows, loads, ready } = setup();
    evidence.sync(false, 0);
    expect(loads()).toBe(0);
    evidence.start(1);
    const session = evidence.context().djSession;
    evidence.interaction('seek');
    expect(loads()).toBe(1);
    await ready();
    expect(rows.map(row => row.event)).toEqual(['dj.session_started', 'dj.interaction']);
    expect(rows.every(row => row.facts.djSession === session)).toBe(true);
    expect(rows[0].facts.startKnown).toBe(true);
  });

  it('marks a mix that outruns loading as incomplete instead of claiming its opening', async () => {
    const { evidence, rows, ready } = setup();
    evidence.start(1);
    const owned = evidence.arm('from', 'to', plan, false, true);
    expect(owned.ordinal).toBe(0);
    await ready();
    expect(rows[0].facts.startKnown).toBe(false);
    const next = evidence.arm('to', 'next', plan, false, true);
    expect(next.ordinal).toBe(2);
  });

  it('records unavailable instrumentation without rejecting playback', async () => {
    const rows: string[] = [];
    const evidence = createDjEvidence(event => rows.push(event), () => 'session', () => 0, () => Promise.reject(new Error('offline')));
    evidence.start(1);
    await Promise.resolve(); await Promise.resolve();
    expect(rows).toContain('dj.capture_unavailable');
  });
});
