import { For, Show, type ParentProps } from 'solid-js';
import { t } from '../lib/i18n';
import styles from './Skeleton.module.css';

const slotCache = new Map<number, readonly number[]>();

export function skeletonSlots(count: number | undefined, fallback: number): readonly number[] {
  const n = Math.max(1, count ?? fallback);
  let cached = slotCache.get(n);
  if (!cached) {
    cached = Array.from({ length: n }, (_, index) => index);
    slotCache.set(n, cached);
  }
  return cached;
}

export function skeletonStatusProps(decorative?: boolean) {
  return decorative
    ? {}
    : { role: 'status' as const, 'aria-live': 'polite' as const, 'aria-label': t('common.loading') };
}

/** Shared status/animation wrapper when composing multiple skeleton sections. */
export function SkeletonRegion(props: ParentProps<{ class?: string }>) {
  return (
    <div class={props.class ? `${styles.region} ${props.class}` : styles.region} {...skeletonStatusProps(false)}>
      <span class={styles.srOnly}>{t('common.loading')}</span>
      {props.children}
    </div>
  );
}

/** Search/command toolbar skeleton aligned with `PageToolbar`. */
export function SkeletonToolbar(props: { always?: boolean; contained?: boolean; meta?: boolean; actions?: boolean }) {
  return (
    <div
      class={props.always ? styles.toolbar : `${styles.toolbar} ${styles.toolbarDesktop}`}
      data-contained={props.contained ? '' : undefined}
      aria-hidden="true"
    >
      <span class={`${styles.bone} ${styles.toolbarField}`} />
      <Show when={props.meta}>
        <span class={`${styles.bone} ${styles.toolbarMeta}`} />
      </Show>
      <Show when={props.actions}>
        <span class={`${styles.bone} ${styles.toolbarAction}`} />
      </Show>
    </div>
  );
}

/** Section heading skeleton aligned with discovery, search and entity headers. */
export function SkeletonHeading(props: { size?: 'h2' | 'h3'; subtitle?: boolean; action?: boolean; class?: string }) {
  return (
    <div class={props.class ? `${styles.heading} ${props.class}` : styles.heading} aria-hidden="true">
      <div class={styles.headingCopy}>
        <span class={`${styles.bone} ${styles.headingTitle} ${props.size === 'h3' ? styles.headingH3 : ''}`} />
        <Show when={props.subtitle}>
          <span class={`${styles.bone} ${styles.headingSub}`} />
        </Show>
      </div>
      <Show when={props.action}>
        <span class={`${styles.bone} ${styles.headingAction}`} />
      </Show>
    </div>
  );
}

export type SkeletonRowVariant = 'song' | 'media';

/** Core track/media loading rows aligned with `SongRow` and `MediaRow`. */
export function SkeletonRows(props: {
  count?: number;
  variant?: SkeletonRowVariant;
  indexed?: boolean;
  round?: boolean;
  compact?: boolean;
  decorative?: boolean;
  class?: string;
}) {
  const variant = () => props.variant ?? 'song';

  return (
    <div
      classList={{
        [styles.rows]: true,
        [styles.compactRows]: props.compact,
        ...(props.class ? { [props.class]: true } : {}),
      }}
      data-variant={variant()}
      data-decorative={props.decorative ? '' : undefined}
      {...skeletonStatusProps(props.decorative)}
    >
      <Show when={!props.decorative}>
        <span class={styles.srOnly}>{t('common.loading')}</span>
      </Show>
      <For each={skeletonSlots(props.count, 10)}>
        {() => (
          <div class={styles.row} data-skeleton-row aria-hidden="true">
            <Show when={variant() === 'song' && props.indexed}>
              <span class={`${styles.bone} ${styles.lead}`} />
            </Show>
            <span
              classList={{
                [styles.bone]: true,
                [styles.cover]: true,
                [styles.round]: Boolean(props.round),
              }}
              data-skeleton-cover
            />
            <span class={styles.rowCopy}>
              <span class={`${styles.bone} ${styles.title}`} />
              <span class={`${styles.bone} ${styles.subtitle}`} />
            </span>
            <span class={styles.trailing} data-skeleton-menu>
              <Show when={variant() === 'song'}>
                <span class={`${styles.bone} ${styles.duration}`} />
              </Show>
              <span class={styles.menuSlot}>
                <span class={`${styles.bone} ${styles.menuPill}`} />
              </span>
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

/** Cover-first loading grid or horizontal rail mirroring `CollectionGrid` and browse shelves. */
export function SkeletonCards(props: {
  count?: number;
  layout?: 'grid' | 'rail';
  shape?: 'square' | 'round';
  lines?: 1 | 2 | 3;
  padded?: boolean;
  compact?: boolean;
  bleedOnTouch?: boolean;
  decorative?: boolean;
  class?: string;
}) {
  const layout = () => props.layout ?? 'grid';
  const lines = () => props.lines ?? 2;

  return (
    <div
      classList={{
        [styles.cards]: true,
        [styles.railCards]: layout() === 'rail',
        [styles.paddedCards]: Boolean(props.padded && layout() === 'grid'),
        [styles.compactCards]: Boolean(props.compact && layout() === 'grid'),
        [styles.bleedOnTouch]: Boolean(props.bleedOnTouch && layout() === 'rail'),
        ...(props.class ? { [props.class]: true } : {}),
      }}
      data-shape={props.shape ?? 'square'}
      data-layout={layout()}
      data-skeleton-cards
      data-decorative={props.decorative ? '' : undefined}
      {...skeletonStatusProps(props.decorative)}
    >
      <Show when={!props.decorative}>
        <span class={styles.srOnly}>{t('common.loading')}</span>
      </Show>
      <For each={skeletonSlots(props.count, layout() === 'rail' ? 8 : 12)}>
        {() => (
          <div class={styles.card} aria-hidden="true">
            <span
              classList={{
                [styles.bone]: true,
                [styles.cardCover]: true,
                [styles.round]: props.shape === 'round',
              }}
            />
            <span class={`${styles.bone} ${styles.cardTitle}`} />
            <Show when={lines() >= 2}>
              <span class={`${styles.bone} ${styles.cardSubtitle}`} />
            </Show>
            <Show when={lines() >= 3}>
              <span class={`${styles.bone} ${styles.cardMeta}`} />
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

/** Home route skeleton aligned with `Home.tsx` shortcuts and bookmark/release rails. */
export function SkeletonHome() {
  return (
    <SkeletonRegion class={styles.homePage}>
      <div class={styles.homeSection} aria-hidden="true">
        <SkeletonHeading class={styles.homeHeading} />
        <div class={styles.shortcuts}>
          <For each={skeletonSlots(6, 6)}>
            {() => (
              <div class={styles.shortcutTile}>
                <span class={`${styles.bone} ${styles.shortcutIcon}`} />
                <span class={`${styles.bone} ${styles.shortcutLabel}`} />
              </div>
            )}
          </For>
        </div>
      </div>
      <div class={styles.homeSection}>
        <SkeletonHeading action class={styles.homeHeading} />
        <SkeletonCards layout="rail" shape="round" lines={1} decorative />
      </div>
    </SkeletonRegion>
  );
}

export { styles as skeletonPageStyles };
