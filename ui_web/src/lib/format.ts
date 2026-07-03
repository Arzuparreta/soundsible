import { t, locale } from './i18n';

/** Localised track-count label with correct singular/plural forms. */
export const trackCount = (n: number): string => {
  if (locale() === 'zh') return `${n} ${t('format.trackOne')}`;
  return `${n} ${n === 1 ? t('format.trackOne') : t('format.trackOther')}`;
};