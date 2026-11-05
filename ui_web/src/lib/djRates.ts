/** The players' pitch range (shared/dj/timing.py MAX_STRETCH). */
export const MAX_STRETCH = 0.08;
/** The smallest speed step the players make (shared/dj/timing.py RATE_STEP). */
export const RATE_STEP = 0.0025;

interface RatedPlan {
  playback_rate: number;
  out_playback_rate?: number;
  out_rate_ramp?: { lead_seconds: number; seconds: number };
}

/** A deck speed inside the pitch range; rounding of the plan is tolerated. */
export function deckSpeedFits(speed: number): boolean {
  return Number.isFinite(speed) && speed > 0 && Math.abs(1 - speed) <= MAX_STRETCH + 1e-9;
}

/** The pitch range applied to a speed the player asks a deck for. */
export function clampDeckSpeed(speed: number): number {
  return Math.min(1 + MAX_STRETCH, Math.max(1 - MAX_STRETCH, speed));
}

/**
 * Both deck speeds of a plan, or null when either would leave the pitch
 * range. `playback_rate` is incoming media seconds per outgoing media second;
 * the incoming deck plays at it times the outgoing deck's speed. Android
 * applies the same rule in `ProgramDjPlan.deckRates`.
 */
export function planDeckRates(plan: RatedPlan | undefined): { out: number; in: number } | null {
  if (!plan) return null;
  const relation = Number(plan.playback_rate);
  const out = plan.out_playback_rate == null ? 1 : Number(plan.out_playback_rate);
  const incoming = relation * out;
  if (!deckSpeedFits(out) || !deckSpeedFits(incoming)) return null;
  if (Math.abs(out - 1) > 1e-6) {
    const lead = Number(plan.out_rate_ramp?.lead_seconds);
    const seconds = Number(plan.out_rate_ramp?.seconds);
    if (!Number.isFinite(lead) || !Number.isFinite(seconds) || !(seconds > 0) || seconds >= lead) return null;
  }
  return { out, in: incoming };
}
