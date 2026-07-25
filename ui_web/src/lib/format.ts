import { t, locale } from './i18n';

/** Localised track-count label with correct singular/plural forms. */
export const trackCount = (n: number): string => {
  if (locale() === 'zh') return `${n} ${t('format.trackOne')}`;
  return `${n} ${n === 1 ? t('format.trackOne') : t('format.trackOther')}`;
};

/**
 * `m:ss` for a track length. Empty string when there is no length to show —
 * for list columns, where a placeholder would be noise.
 */
export function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  return clockTime(seconds);
}

/**
 * `m:ss` for a playback position. Always renders — a transport readout that
 * blanks out mid-track reads as broken, so unknown/negative clamps to `0:00`.
 */
export function clockTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}