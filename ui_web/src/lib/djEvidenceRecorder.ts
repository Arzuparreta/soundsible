/** Observations only: no ranking, readiness polling, audio or provider work. */
import type { DjTransitionPlan, ListeningPlanItem, ListeningPlanResponse, DjPlanResponse } from './api';
import type { LiveTransitionPlan } from './audio';
import type { DiagnosticFacts } from './playbackDiagnostics';

type Analysis = Partial<NonNullable<ListeningPlanItem['analysis']>>;
interface Edge { id: string; from: string; to: string; ordinal?: number; current: DiagnosticFacts }
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const ready = (analysis?: Analysis): boolean | null => typeof analysis?.analysed === 'boolean' ? analysis.analysed : null;

export function pairObservations(from?: Analysis, to?: Analysis): DiagnosticFacts {
  const result: DiagnosticFacts = { fromAnalysed: ready(from), toAnalysed: ready(to) };
  for (const [field, name] of [['note_rate', 'notesDelta'], ['loudness_lufs', 'lufsDelta'], ['spectral_flatness', 'flatnessDelta']] as const) {
    const a = number(from?.[field]), b = number(to?.[field]);
    result[name] = a === null || b === null ? null : Math.abs(a - b);
  }
  return result;
}

export function planObservations(plan?: Partial<DjTransitionPlan> | LiveTransitionPlan): DiagnosticFacts {
  return { requestedTechnique: plan?.technique ?? null, outCue: number(plan?.out_cue), inCue: number(plan?.in_cue),
    overlap: number(plan?.overlap_seconds), rate: number(plan?.playback_rate), confidence: number(plan?.confidence),
    score: plan && 'score' in plan ? number(plan.score) : null,
    alignment: plan && 'sync' in plan && plan.sync && 'alignment' in plan.sync ? plan.sync.alignment ?? null : null };
}

export function createDjEvidence(emit: (event: string, facts: DiagnosticFacts) => void,
  id = () => crypto.randomUUID() as string, now = () => performance.now()) {
  let session = '', started = 0, direction = 0, ordinal = 0;
  const edges = new Map<string, Edge>();

  function record(event: string, facts: DiagnosticFacts = {}): void {
    try { emit(event, { ...context(), ...facts }); } catch { /* Never affect playback. */ }
  }
  function context(): DiagnosticFacts {
    return session ? { djSession: session, sessionMs: Math.max(0, now() - started), direction: direction } : {};
  }
  function start(nextDirection: number, known = true, sessionId = id(), startedAt = now()): void {
    end('replaced');
    session = sessionId; started = startedAt; direction = nextDirection; ordinal = 0; edges.clear();
    record('dj.session_started', { startKnown: known });
  }
  function sync(active: boolean, nextDirection: number): void {
    if (!active) { end('inactive'); return; }
    if (!session) start(nextDirection, false);
    if (nextDirection !== direction) {
      direction = nextDirection;
      record('dj.direction_changed');
    }
  }
  function end(reason: string): void {
    if (session) record('dj.session_ended', { reason });
    session = ''; edges.clear();
  }
  function interaction(action: string): void { record('dj.interaction', { action }); }
  function findEdge(from: string, to: string): Edge {
    let edge = edges.get(to);
    if (!edge || edge.from !== from) {
      edge = { id: id(), from, to, current: { selectionKnown: false, fromAnalysed: null, toAnalysed: null } };
      edges.delete(to); edges.set(to, edge);
      if (edges.size > 64) edges.delete(edges.keys().next().value!);
    }
    return edge;
  }
  function identity(edge: Edge): DiagnosticFacts { return { edgeId: edge.id, toOccurrence: edge.to }; }
  function select(from: string, to: string, a: Analysis | undefined, b: Analysis | undefined,
    plan: DjTransitionPlan | undefined, response: ListeningPlanResponse): void {
    const edge = findEdge(from, to);
    edge.current = { selectionKnown: true, ...pairObservations(a, b), ...planObservations(plan) };
    record('dj.selected', { ...identity(edge), ...edge.current, planId: response.plan_id,
      plannerSession: response.session_id ?? null, segment: response.segment_index ?? null });
  }
  function route(response: ListeningPlanResponse): void {
    const coverage = (response as DjPlanResponse).analysis_coverage;
    record('dj.route', { planId: response.plan_id, plannerSession: response.session_id ?? null,
      segment: response.segment_index ?? null, candidateCount: coverage?.candidates ?? null,
      cohortCount: coverage?.cohort ?? null, cohortReady: coverage?.cohort_analysed ?? null, routeCount: response.items.length });
  }
  function refine(from: string, to: string, a: Analysis | undefined, b: Analysis | undefined, plan: DjTransitionPlan,
    accepted: boolean): void {
    const edge = findEdge(from, to);
    const observed = { ...pairObservations(a, b), ...planObservations(plan) };
    if (accepted) edge.current = { ...edge.current, ...observed };
    record('dj.refined', { ...identity(edge), ...observed, accepted });
  }
  function arm(from: string, to: string, plan: LiveTransitionPlan, manual: boolean, mixing: boolean): DiagnosticFacts {
    const edge = findEdge(from, to);
    edge.ordinal ??= ++ordinal;
    const owned = { ...context(), ...identity(edge), transitionId: id(), ordinal: edge.ordinal };
    record('dj.committed', { ...owned, ...edge.current, ...planObservations(plan),
      score: edge.current.score ?? null, alignment: edge.current.alignment ?? null, manual, mixing });
    return owned;
  }
  function outcome(owned: DiagnosticFacts, outcome: string, reason?: string): void {
    record('dj.outcome', { ...owned, outcome, reason: reason ?? null });
  }
  return { context, start, sync, end, interaction, select, route, refine, arm, outcome };
}
