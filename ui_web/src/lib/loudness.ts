/**
 * Turning a measurement into a gain.
 *
 * Pure, and deliberately so: this is the one place that decides how loud
 * anything plays, and it must be provable in isolation rather than inferred
 * from the mixer's behaviour.
 *
 * The rule is ReplayGain 2.0's, which is also Spotify's and Apple's: correct
 * towards a fixed target, then refuse any part of that correction that would
 * push the file's own true peak past a ceiling. That second step is what makes
 * clipping impossible *without* a limiter — no compression, no pumping, nothing
 * added to the signal that was not in the recording.
 */

import type { Track } from '../types/music';

/** The de-facto streaming target: Spotify, YouTube, Tidal and Amazon all sit
 * here, so a listener's ears arrive already calibrated to it. It is also
 * roughly where YouTube previews land, which keeps an unmeasured preview from
 * jumping against a measured library track. */
export const TARGET_LUFS = -14;

/** Output ceiling. AES TD1004's number, and far enough below full scale to
 * absorb the intersample overshoot a browser's resampler can add on top of an
 * already 4x-oversampled true peak. Keeping every deck under this is what keeps
 * the master limiter (idle threshold 0 dBFS) out of the signal path entirely
 * during ordinary playback. */
export const PEAK_CEILING_DBTP = -1;

/** Beyond +6 dB there is nothing left to recover: what is being amplified is
 * noise floor and codec artefacts, on material whose peak ceiling would be
 * clamping the boost anyway. Under-correcting a very quiet recording is
 * inaudible; over-amplifying one is not. */
export const MAX_GAIN_DB = 6;

/** The most extreme loudness-war masters integrate around -4 LUFS and need
 * about -10 dB. Nothing real reaches this. */
export const MIN_GAIN_DB = -15;

/** The meter's own floor: -70 LUFS is the absolute gate reporting "nothing
 * here", not a reading of the programme. */
export const UNMEASURABLE_LUFS = -69;

/** A gain of zero is silence, and silence on a playing deck is indistinguishable
 * from a dead audio graph — `checkAudible` would tear the graph down and take
 * the live tap with it. Flooring here makes levelling-induced silence
 * impossible as a property of the code rather than of the data. */
export const MIN_LINEAR = 0.05;
export const MAX_LINEAR = 4;

/** A clipped master really can integrate above 0 LUFS; nothing goes past +5. */
const MAX_VALID_LUFS = 5;
const MIN_VALID_PEAK_DBTP = -70;
const MAX_VALID_PEAK_DBTP = 12;

/** How much of an album must be measured before its shared reference is used. */
export const ALBUM_COVERAGE = 0.9;

export interface LoudnessFacts {
  loudness_lufs?: number | null;
  loudness_peak_dbtp?: number | null;
}

function usable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * How many dB to correct this track by. `0` for anything not measured.
 *
 * Never a guess: a track nobody has measured, a reading outside the physically
 * possible, or a value that is not a number at all all come back as no
 * correction rather than an estimate.
 */
export function levelGainDb(lufs: unknown, peakDbtp: unknown): number {
  if (!usable(lufs) || !usable(peakDbtp)) return 0;
  if (lufs <= UNMEASURABLE_LUFS || lufs > MAX_VALID_LUFS) return 0;
  if (peakDbtp < MIN_VALID_PEAK_DBTP || peakDbtp > MAX_VALID_PEAK_DBTP) return 0;

  const wanted = Math.min(Math.max(TARGET_LUFS - lufs, MIN_GAIN_DB), MAX_GAIN_DB);
  // Give up whatever part of the correction would put this file's own true peak
  // over the ceiling. On a loud master this never binds — it is already being
  // attenuated. On a quiet, dynamic recording it binds hard, and that is the
  // right answer: you cannot make a 20 LU-dynamic transfer as loud as a limited
  // pop master without a limiter, and inserting one is the audible false
  // correction this whole design exists to avoid.
  const gain = Math.min(wanted, PEAK_CEILING_DBTP - peakDbtp);
  if (!Number.isFinite(gain)) return 0;
  // Re-clamp: a pathological peak could otherwise drive the result below the
  // floor the first clamp established.
  return Math.min(Math.max(gain, MIN_GAIN_DB), MAX_GAIN_DB);
}

/** dB to a linear multiplier, floored and capped so it is always audible. */
export function gainToLinear(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.min(Math.max(10 ** (db / 20), MIN_LINEAR), MAX_LINEAR);
}

/**
 * The album's shared reference, or `null` when there is not enough to go on.
 *
 * Album mode exists so a record's own dynamics survive: the quiet interlude
 * between two loud songs has to stay quiet. That means every track on the album
 * gets the *same* correction, derived from the album as a whole.
 *
 * The reference is the duration-weighted mean energy of the tracks, in the
 * gated domain the meter reports (hence un-applying and re-applying BS.1770's
 * -0.691 offset). It approximates metering the whole record end to end to well
 * inside a dB — and, more to the point, any error it does have is a single
 * offset applied to every track alike, so the relationships between them, which
 * is the only thing album mode is for, stay exact.
 */
export function albumReference(tracks: readonly (Track & LoudnessFacts)[]): { lufs: number; peak: number } | null {
  let energy = 0;
  let seconds = 0;
  let peak = -Infinity;
  let measured = 0;

  for (const track of tracks) {
    const lufs = track.loudness_lufs;
    const tp = track.loudness_peak_dbtp;
    if (!usable(lufs) || !usable(tp) || lufs <= UNMEASURABLE_LUFS) continue;
    const duration = usable(track.duration) && track.duration > 0 ? track.duration : 1;
    energy += duration * 10 ** ((lufs + 0.691) / 10);
    seconds += duration;
    peak = Math.max(peak, tp);
    measured += 1;
  }

  // A part-measured album is worse than none: the reference would be set by
  // whichever tracks the sweep happened to reach, and would change underneath
  // the listener as it reached more. Below full coverage, fall back to per-track.
  if (!measured || measured < tracks.length * ALBUM_COVERAGE || seconds <= 0) return null;
  return { lufs: -0.691 + 10 * Math.log10(energy / seconds), peak };
}

export interface LevelContext {
  enabled: boolean;
  shuffle: boolean;
  /** The other queue entries, used to find the rest of an album. */
  siblings?: readonly (Track & LoudnessFacts)[];
  /** Identifies which album this entry was played as part of, if any. */
  contextKind?: string | null;
  contextId?: string | null;
}

/**
 * The linear gain for one track. Exactly `1` whenever there is any doubt.
 *
 * Returning literal 1 matters: it is what makes turning the setting off restore
 * the previous output bit for bit, rather than approximately.
 */
export function levelFor(track: (Track & LoudnessFacts) | null | undefined, ctx: LevelContext): number {
  if (!track || !ctx.enabled) return 1;

  // Shuffling an album is listening to songs, not to a record, so it takes
  // per-track levelling — the same choice Spotify makes.
  if (!ctx.shuffle && ctx.contextKind === 'album' && ctx.contextId && ctx.siblings?.length) {
    const reference = albumReference(ctx.siblings);
    if (reference) {
      const db = levelGainDb(reference.lufs, reference.peak);
      return db === 0 ? 1 : gainToLinear(db);
    }
  }

  const db = levelGainDb(track.loudness_lufs, track.loudness_peak_dbtp);
  return db === 0 ? 1 : gainToLinear(db);
}
