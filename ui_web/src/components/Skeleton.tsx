import { For } from 'solid-js';
import { t } from '../lib/i18n';
import styles from './Skeleton.module.css';

function slots(count: number | undefined, fallback: number) {
  return Array.from({ length: Math.max(1, count ?? fallback) });
}

/** Content-shaped loading rows. The geometry mirrors real track/search rows so
 * loading no longer looks like a stack of anonymous grey bars. */
export function SkeletonRows(props: { count?: number; compact?: boolean }) {
  return (
    <div
      classList={{ [styles.rows]: true, [styles.compactRows]: props.compact }}
      role="status"
      aria-live="polite"
      aria-label={t('common.loading')}
    >
      <span class={styles.srOnly}>{t('common.loading')}</span>
      <For each={slots(props.count, 8)}>
        {(_, index) => (
          <div class={styles.row} aria-hidden="true" style={{ '--skeleton-index': index() }}>
            <span class={`${styles.bone} ${styles.cover}`} />
            <span class={styles.rowCopy}>
              <span class={`${styles.bone} ${styles.title}`} />
              <span class={`${styles.bone} ${styles.subtitle}`} />
            </span>
            <span class={`${styles.bone} ${styles.trailing}`} />
          </div>
        )}
      </For>
    </div>
  );
}

/** Cover-first loading grid used by discovery, podcasts, playlists and entity
 * browsers. It preserves the final layout's rhythm across every breakpoint. */
export function SkeletonCards(props: { count?: number; compact?: boolean; shape?: 'square' | 'round' }) {
  return (
    <div
      classList={{ [styles.cards]: true, [styles.compactCards]: props.compact }}
      data-shape={props.shape ?? 'square'}
      role="status"
      aria-live="polite"
      aria-label={t('common.loading')}
    >
      <span class={styles.srOnly}>{t('common.loading')}</span>
      <For each={slots(props.count, 6)}>
        {(_, index) => (
          <div class={styles.card} aria-hidden="true" style={{ '--skeleton-index': index() }}>
            <span
              classList={{
                [styles.bone]: true,
                [styles.cardCover]: true,
                [styles.roundCover]: props.shape === 'round',
              }}
            />
            <span class={`${styles.bone} ${styles.cardTitle}`} />
            <span class={`${styles.bone} ${styles.cardSubtitle}`} />
          </div>
        )}
      </For>
    </div>
  );
}
