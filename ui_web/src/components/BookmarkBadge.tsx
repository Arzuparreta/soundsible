import { BookmarkIcon } from './icons';
import { t } from '../lib/i18n';
import styles from './BookmarkBadge.module.css';

export function BookmarkBadge() {
  return <span class={styles.badge} role="img" aria-label={t('bookmarks.saved')}><BookmarkIcon size={18} /></span>;
}
