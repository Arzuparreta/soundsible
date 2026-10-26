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

/**
 * A relocated measured plan must retain its complete coverage and its phase.
 *
 * `bars` promises the confirmed first beats: it moves by whole bars of equal
 * executed length. `beats` promises the shared pulse: it moves by whole bars
 * when the server sent a common bar estimate, otherwise by whole beats.
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
  const barsSent = sync.out_bar_seconds != null || sync.in_bar_seconds != null;
  const step = sync.alignment === 'bars' || barsSent ? bar : sync.out_period;
  if (!out || !incoming || !plan || !(step > 0)) return { cue: fallback, aligned: false };
  const left = Math.max(earliest, out.start);
  const right = Math.min(latest, out.end - overlap);
  if (![left, right, incoming.start, incoming.end].every(Number.isFinite) || left > right) {
    return { cue: fallback, aligned: false };
  }
  const cue = placeOutCue(proposed, left, right, step);
  const tolerance = Math.min(.005, sync.phase_tolerance_ms / 1000);
  let pulseRatio = sync.in_period / sync.out_period;
  if (pulseRatio < .7) pulseRatio *= 2;
  else if (pulseRatio > 1.4) pulseRatio /= 2;
  const rate = plan.playback_rate;
  const inBar = barsSent ? Number(sync.in_bar_seconds) : NaN;
  if (![rate, pulseRatio, tolerance].every(Number.isFinite) || rate < .94 || rate > 1.06
    || sync.out_period <= 0 || sync.in_period <= 0 || tolerance < 0
    || Math.abs(rate / pulseRatio - 1) * overlap > tolerance) return { cue: fallback, aligned: false };
  if (sync.alignment === 'bars' || barsSent) {
    if (!Number.isFinite(inBar) || inBar <= 0 || Math.abs(inBar / rate / bar - 1) * overlap > tolerance) {
      return { cue: fallback, aligned: false };
    }
  }
  const phaseError = Math.abs(cue - proposed - Math.round((cue - proposed) / step) * step);
  return { cue, aligned: phaseError <= tolerance && plan.in_cue >= incoming.start - tolerance
    && plan.in_cue + overlap * plan.playback_rate <= incoming.end + tolerance };
}
