import type { LiveTransitionPlan } from './audio';
import { metricCuePlacement } from './djCue';
import type { AutoPlanItem } from './generatedQueue';

/** A planned transition below this confidence is played as a plain fade. */
export const TRUSTED_CONFIDENCE = 0.35;
const MIN_PLAY_SECONDS = 90;
const MIN_PLAY_FRACTION = 0.6;
const BEATMATCHED = new Set(['bass_swap', 'filter_blend', 'long_blend']);

/** The transition out of the song playing now (`fromKey`, `duration` seconds)
 * into the entry planned as `item`, or null when the song is too short to mix
 * out of. A cue planned out of another song is never honoured. */
export function resolveTransition(fromKey: string, duration: number, item: AutoPlanItem | undefined, mixing: boolean): LiveTransitionPlan | null {
  if (!Number.isFinite(duration) || duration <= 4) return null;
  if (!mixing) {
    return { technique: 'direct', out_cue: duration, in_cue: 0, overlap_seconds: 0, overlap_bars: 0, playback_rate: 1, confidence: 0 };
  }
  const chained = item?.fromKey === fromKey ? item.transition : undefined;
  const trusted = (chained?.confidence ?? 0) >= TRUSTED_CONFIDENCE;
  const requested = chained?.overlap_seconds ?? 6;
  const overlap = Math.max(1.5, Math.min(trusted ? requested : Math.min(requested, 6), duration * 0.25));
  const latest = duration - overlap - 1;
  if (latest <= 0) return null;
  const earliest = Math.min(Math.min(MIN_PLAY_SECONDS, duration * MIN_PLAY_FRACTION), latest);
  const proposed = chained && Number.isFinite(chained.out_cue) && (chained.out_cue ?? 0) > 0 ? Number(chained.out_cue) : latest;
  const placement = metricCuePlacement(proposed, earliest, latest, trusted ? chained : undefined, overlap);
  const metricFallback = trusted && !!chained && BEATMATCHED.has(chained.technique) && !placement.aligned;
  const honoured = trusted && !metricFallback ? chained : undefined;
  return {
    technique: metricFallback ? 'structural_fade' : trusted ? chained!.technique : 'safe_fade',
    out_cue: placement.cue,
    in_cue: trusted ? chained!.in_cue : 0,
    overlap_seconds: overlap,
    overlap_bars: chained?.overlap_bars ?? 0,
    playback_rate: honoured ? honoured.playback_rate : 1,
    // Both decks meet at a shared tempo; the mixer checks it can still ramp.
    ...(honoured && honoured.out_playback_rate != null
      ? { out_playback_rate: honoured.out_playback_rate, out_rate_ramp: honoured.out_rate_ramp } : {}),
    confidence: chained?.confidence ?? 0,
    ...(trusted && chained!.echo_delay_seconds != null ? { echo_delay_seconds: chained!.echo_delay_seconds } : {}),
    // The planner's phase tolerance, as Android already receives it.
    ...(trusted && chained!.sync ? { sync: { out_bar_seconds: chained!.sync.out_bar_seconds, phase_tolerance_ms: chained!.sync.phase_tolerance_ms } } : {}),
  };
}

/** The same handoff without a blend, for when mixing is switched off. */
export function unmixed(plan: LiveTransitionPlan): LiveTransitionPlan {
  return { ...plan, technique: 'direct', in_cue: 0, overlap_seconds: 0, overlap_bars: 0, playback_rate: 1 };
}

/** A skip blends from wherever the song is now, keeping a trusted technique. */
export function skipTransition(fromKey: string, item: AutoPlanItem | undefined): LiveTransitionPlan {
  const chained = item?.fromKey === fromKey ? item.transition : undefined;
  const trusted = (chained?.confidence ?? 0) >= TRUSTED_CONFIDENCE;
  return {
    technique: trusted ? chained!.technique : 'safe_fade',
    out_cue: 0,
    in_cue: trusted ? chained!.in_cue : 0,
    overlap_seconds: 1.6,
    overlap_bars: chained?.overlap_bars ?? 0,
    playback_rate: trusted ? chained!.playback_rate : 1,
    confidence: chained?.confidence ?? 0,
  };
}

/** A song the listener asked to hear now fades in at once. */
export const IMMEDIATE_TRANSITION: LiveTransitionPlan = {
  technique: 'safe_fade', out_cue: 0, in_cue: 0, overlap_seconds: 1.6, overlap_bars: 0, playback_rate: 1, confidence: 0,
};
