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

export class DjEvidence {
  private session = '';
  private started = 0;
  private direction = 0;
  private ordinal = 0;
  private edges = new Map<string, Edge>();
  constructor(private emit: (event: string, facts: DiagnosticFacts) => void,
    private id = () => crypto.randomUUID() as string, private now = () => performance.now()) {}

  private record(event: string, facts: DiagnosticFacts = {}): void {
    try { this.emit(event, { ...this.context(), ...facts }); } catch { /* Never affect playback. */ }
  }
  context(): DiagnosticFacts {
    return this.session ? { djSession: this.session, sessionMs: Math.max(0, this.now() - this.started), direction: this.direction } : {};
  }
  start(direction: number, known = true): void {
    this.end('replaced');
    this.session = this.id(); this.started = this.now(); this.direction = direction; this.ordinal = 0; this.edges.clear();
    this.record('dj.session_started', { startKnown: known });
  }
  sync(active: boolean, direction: number): void {
    if (!active) { this.end('inactive'); return; }
    if (!this.session) this.start(direction, false);
    if (direction !== this.direction) {
      this.direction = direction;
      this.record('dj.direction_changed');
    }
  }
  end(reason: string): void {
    if (this.session) this.record('dj.session_ended', { reason });
    this.session = ''; this.edges.clear();
  }
  interaction(action: string): void { this.record('dj.interaction', { action }); }
  private edge(from: string, to: string): Edge {
    let edge = this.edges.get(to);
    if (!edge || edge.from !== from) {
      edge = { id: this.id(), from, to, current: { selectionKnown: false, fromAnalysed: null, toAnalysed: null } };
      this.edges.delete(to); this.edges.set(to, edge);
      if (this.edges.size > 64) this.edges.delete(this.edges.keys().next().value!);
    }
    return edge;
  }
  private identity(edge: Edge): DiagnosticFacts { return { edgeId: edge.id, toOccurrence: edge.to }; }
  select(from: string, to: string, a: Analysis | undefined, b: Analysis | undefined,
    plan: DjTransitionPlan | undefined, response: ListeningPlanResponse): void {
    const edge = this.edge(from, to);
    edge.current = { selectionKnown: true, ...pairObservations(a, b), ...planObservations(plan) };
    this.record('dj.selected', { ...this.identity(edge), ...edge.current, planId: response.plan_id,
      plannerSession: response.session_id ?? null, segment: response.segment_index ?? null });
  }
  route(response: ListeningPlanResponse): void {
    const coverage = (response as DjPlanResponse).analysis_coverage;
    this.record('dj.route', { planId: response.plan_id, plannerSession: response.session_id ?? null,
      segment: response.segment_index ?? null, candidateCount: coverage?.candidates ?? null,
      cohortCount: coverage?.cohort ?? null, cohortReady: coverage?.cohort_analysed ?? null, routeCount: response.items.length });
  }
  refine(from: string, to: string, a: Analysis | undefined, b: Analysis | undefined, plan: DjTransitionPlan,
    accepted: boolean): void {
    const edge = this.edge(from, to);
    const observed = { ...pairObservations(a, b), ...planObservations(plan) };
    if (accepted) edge.current = { ...edge.current, ...observed };
    this.record('dj.refined', { ...this.identity(edge), ...observed, accepted });
  }
  arm(from: string, to: string, plan: LiveTransitionPlan, manual: boolean, mixing: boolean): DiagnosticFacts {
    const edge = this.edge(from, to);
    edge.ordinal ??= ++this.ordinal;
    const owned = { ...this.context(), ...this.identity(edge), transitionId: this.id(), ordinal: edge.ordinal };
    this.record('dj.committed', { ...owned, ...edge.current, ...planObservations(plan),
      score: edge.current.score ?? null, alignment: edge.current.alignment ?? null, manual, mixing });
    return owned;
  }
  outcome(owned: DiagnosticFacts, outcome: string, reason?: string): void {
    this.record('dj.outcome', { ...owned, outcome, reason: reason ?? null });
  }
}
