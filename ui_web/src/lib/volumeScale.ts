/**
 * Perceptual (audio-taper) mapping for user-facing volume controls.
 *
 * The playback engine and persistence deliberately keep linear gain in [0, 1].
 * A linear slider makes its lower end change too abruptly to the ear, so UI
 * position follows an exponential taper instead. The base makes half travel
 * equal exactly 0.1 gain (about -20 dB), a conventional audio-taper midpoint.
 */
const AUDIO_TAPER_BASE = 81;

function unit(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Convert normalized slider travel to the linear gain used by the engine. */
export function volumePositionToGain(position: number): number {
  const normalized = unit(position);
  return (AUDIO_TAPER_BASE ** normalized - 1) / (AUDIO_TAPER_BASE - 1);
}

/** Convert engine gain back to normalized slider travel without changing it. */
export function gainToVolumePosition(gain: number): number {
  const normalized = unit(gain);
  return Math.log1p(normalized * (AUDIO_TAPER_BASE - 1)) / Math.log(AUDIO_TAPER_BASE);
}

/** Move an existing gain by a normalized amount of perceptual slider travel. */
export function nudgeVolumeGain(gain: number, positionDelta: number): number {
  return volumePositionToGain(gainToVolumePosition(gain) + positionDelta);
}
