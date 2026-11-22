import { locale, t } from './i18n';

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
