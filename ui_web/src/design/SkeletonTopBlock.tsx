import { SkeletonHeading, SkeletonRows } from './Skeleton';
import search from '../routes/Search.module.css';
import card from '../components/TopResultCard.module.css';
import styles from './SkeletonTopBlock.module.css';

/** Mixed-search TopResult + Songs split skeleton aligned with `Search.module.css .topBlock`. */
export function SkeletonTopBlock() {
  return (
    <div class={search.topBlock} data-skeleton-top-block aria-hidden="true">
      <div class={search.section}>
        <SkeletonHeading class={search.sectionTitle} />
        <div class={card.card}>
          <span class={`${styles.bone} ${card.cover}`} />
          <div class={`${card.meta} ${styles.copy}`}>
            <span class={`${styles.bone} ${styles.title}`} />
            <span class={`${styles.bone} ${styles.sub}`} />
          </div>
        </div>
      </div>
      <div class={search.section}>
        <SkeletonHeading class={search.sectionTitle} />
        <SkeletonRows count={4} decorative />
      </div>
    </div>
  );
}
