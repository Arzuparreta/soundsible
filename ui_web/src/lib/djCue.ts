import type { DjTransitionPlan } from './api';

/**
 * Where a measured blend starts when its planned cue falls outside the window
 * the player allows.
 *
 * The planner puts `out_cue` on a measured downbeat and `in_cue` on the
 * incoming song's, so the two kicks land together. Clamping the cue to the
 * window by an arbitrary amount would start the incoming song between two
 * beats of the outgoing one; moving it by whole bars keeps it on a downbeat.
 * Only when no whole-bar position fits is the cue clamped like an unmeasured
 * one. Android applies the same rule in `ProgramDjPlan.placeOutCue`.
 */
export function placeOutCue(proposed: number, earliest: number, latest: number, barSeconds: number): number {
  if (proposed >= earliest && proposed <= latest) return proposed;
  const clamped = Math.min(latest, Math.max(earliest, proposed));
  if (!(barSeconds >= MIN_BAR_SECONDS && barSeconds <= MAX_BAR_SECONDS)) return clamped;
  const moved = proposed > latest
    ? proposed - Math.ceil((proposed - latest) / barSeconds) * barSeconds
    : proposed + Math.ceil((earliest - proposed) / barSeconds) * barSeconds;
  return moved >= earliest && moved <= latest ? moved : clamped;
}

/** Explicit local bar, including unknown. Only old plans use the four-pulse prior. */
export function planBarSeconds(sync: { out_period?: number; out_bar_seconds?: number | null } | undefined): number {
  if (sync && Object.hasOwn(sync, 'out_bar_seconds')) {
    const bar = Number(sync.out_bar_seconds);
    return Number.isFinite(bar) && bar >= MIN_BAR_SECONDS && bar <= MAX_BAR_SECONDS ? bar : 0;
  }
  const period = Number(sync?.out_period);
  return Number.isFinite(period) && period > 0 ? 4 * period : 0;
}

// Local bars may have different pulse counts; bounds reject pathological plans.
const MIN_BAR_SECONDS = 0.2;
const MAX_BAR_SECONDS = 32;

// Common cycles the server may send: m outgoing beats last as long as n
// incoming beats (shared/dj/timing.py CYCLES; readings related by 2 and 3).
const CYCLES = new Set(['1:1', '1:2', '2:1', '2:3', '3:2', '3:4', '4:3', '1:3', '3:1', '1:4', '4:1']);

/**
 * A relocated measured plan must retain its complete coverage and its phase.
 *
 * Both cues sit on a first beat and the players hold the common cycle
 * (`cycle_beats`: m outgoing beats = n incoming beats at the planned rate).
 * The cue moves only by whole `relocation_seconds`: whole outgoing bars that
 * are also whole cycles, so the outgoing one stays on the incoming one.
 * `bars` also checks the confirmed bars, of equal executed length.
 * Android applies the same rule in `ProgramDjPlan.metricCuePlacement`.
 */
export function metricCuePlacement(proposed: number, earliest: number, latest: number,
  plan: DjTransitionPlan | undefined, overlap: number): { cue: number; aligned: boolean } {
  const sync = plan?.sync;
  const bar = planBarSeconds(sync);
  const fallback = placeOutCue(proposed, earliest, latest, bar);
  if (sync?.alignment === undefined) return { cue: fallback, aligned: !sync || !Object.hasOwn(sync, 'out_bar_seconds') }; // Legacy.
  if (sync.alignment !== 'bars' && sync.alignment !== 'beats') return { cue: fallback, aligned: false };
  const out = sync.out_metre;
  const incoming = sync.in_metre;
  const cycle = sync.cycle_beats;
  const step = Number(sync.relocation_seconds);
  if (!out || !incoming || !plan || !Array.isArray(cycle) || cycle.length !== 2
    || !CYCLES.has(`${cycle[0]}:${cycle[1]}`) || !(step > 0)) return { cue: fallback, aligned: false };
  // The server admits the overlap within its phase tolerance of the measured
  // coverage (`rate_fits`); a stricter edge here moved a fitting cue.
  const tolerance = Math.min(.005, sync.phase_tolerance_ms / 1000);
  const left = Math.max(earliest, out.start - tolerance);
  const right = Math.min(latest, out.end - overlap + tolerance);
  if (![left, right, incoming.start, incoming.end, tolerance].every(Number.isFinite) || left > right) {
    return { cue: fallback, aligned: false };
  }
  const cue = placeOutCue(proposed, left, right, step);
  const pulseRatio = sync.in_period * cycle[1] / (sync.out_period * cycle[0]);
  const rate = plan.playback_rate;
  if (![rate, pulseRatio, tolerance].every(Number.isFinite) || rate < .92 || rate > 1.08
    || sync.out_period <= 0 || sync.in_period <= 0 || tolerance < 0
    || Math.abs(rate / pulseRatio - 1) * overlap > tolerance) return { cue: fallback, aligned: false };
  if (sync.alignment === 'bars' || sync.out_bar_seconds != null || sync.in_bar_seconds != null) {
    const inBar = Number(sync.in_bar_seconds);
    if (!(bar > 0) || !Number.isFinite(inBar) || inBar <= 0 || Math.abs(inBar / rate / bar - 1) * overlap > tolerance) {
      return { cue: fallback, aligned: false };
    }
  }
  const phaseError = Math.abs(cue - proposed - Math.round((cue - proposed) / step) * step);
  return { cue, aligned: phaseError <= tolerance && plan.in_cue >= incoming.start - tolerance
    && plan.in_cue + overlap * plan.playback_rate <= incoming.end + tolerance };
}
