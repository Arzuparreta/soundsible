import { SkeletonHeading, SkeletonRows } from './Skeleton';
import styles from './SkeletonTopBlock.module.css';

/** Mixed-search TopResult + Songs split skeleton aligned with `Search.module.css .topBlock`. */
export function SkeletonTopBlock() {
  return (
    <div class={styles.wrap} aria-hidden="true">
      <div class={styles.block} data-skeleton-top-block>
        <div class={styles.section}>
          <SkeletonHeading />
          <div class={styles.card}>
            <span class={`${styles.bone} ${styles.cover}`} />
            <div class={styles.meta}>
              <span class={`${styles.bone} ${styles.title}`} />
              <span class={`${styles.bone} ${styles.sub}`} />
            </div>
          </div>
        </div>
        <div class={styles.section}>
          <SkeletonHeading />
          <SkeletonRows count={4} decorative />
        </div>
      </div>
    </div>
  );
}
