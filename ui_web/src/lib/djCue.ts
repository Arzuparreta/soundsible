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

/** Four beats of the outgoing song at its cue, as the planner measured them; 0 if unknown. */
export function planBarSeconds(sync: { out_period?: number } | undefined): number {
  const period = Number(sync?.out_period);
  return Number.isFinite(period) && period > 0 ? 4 * period : 0;
}

// 4/4 bars between 300 and 30 BPM: anything outside is not a measured beat.
const MIN_BAR_SECONDS = 0.8;
const MAX_BAR_SECONDS = 8;
