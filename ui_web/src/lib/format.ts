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

/** A download's rough size: whole MB below a gigabyte, one decimal above. */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

/** Total runtime of a collection in rounded minutes (e.g. "52 min"). */
export function formatTotalDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  return t('podcastShow.durationMin', { m: Math.max(1, Math.round(seconds / 60)) });
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Localized full release date when an ISO date is known, else the bare year. */
export function formatReleaseDate(releaseDate?: string | null, year?: number | null): string {
  const raw = releaseDate?.trim();
  if (raw) {
    const match = ISO_DATE_RE.exec(raw);
    if (match) {
      const y = Number(match[1]);
      const m = Number(match[2]);
      const d = Number(match[3]);
      const date = new Date(Date.UTC(y, m - 1, d));
      if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) {
        return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
      }
    }
  }
  return year ? String(year) : '';
}

/** Localized release kind (Album / Single / EP). */
export function formatRecordType(recordType?: string | null): string {
  const kind = recordType?.trim().toLowerCase();
  if (kind === 'single') return t('searchHome.recordTypeSingle');
  if (kind === 'ep') return t('searchHome.recordTypeEp');
  if (kind) return t('search.typeAlbum');
  return '';
}
