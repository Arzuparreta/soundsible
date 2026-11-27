import { For, Show, type ParentProps } from 'solid-js';
import { t } from '../lib/i18n';
import { mobileListLayout } from '../lib/listLayout';
import song from '../components/SongRow.module.css';
import media from './MediaRow.module.css';
import { PageToolbar } from '../components/PageToolbar';
import { desktopShell } from '../lib/shellLayout';
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
export function SkeletonToolbar(props: { contained?: boolean; meta?: boolean; actions?: boolean }) {
  return <Show when={desktopShell()}>
    <div aria-hidden="true">
      <PageToolbar contained={props.contained}
        field={<span class={`${styles.bone} ${styles.toolbarField}`} />}
        meta={props.meta && <span class={`${styles.bone} ${styles.toolbarMeta}`} />}
        actions={props.actions && <span class={`${styles.bone} ${styles.toolbarAction}`} />} />
    </div>
  </Show>;
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

  const mediaLayout = () => variant() === 'media' || mobileListLayout();

  return (
    <div
      classList={{
        [styles.rows]: true,
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
          <div class={mediaLayout() ? media.row : song.row} data-compact={!mediaLayout() && props.compact ? '' : undefined} data-skeleton-row aria-hidden="true">
            <Show when={!mediaLayout() && props.indexed}>
              <span class={`${styles.bone} ${styles.lead}`} />
            </Show>
            <Show when={!mediaLayout()}><span class={`${styles.bone} ${song.cover} ${props.round ? styles.round : ''}`} data-skeleton-cover /></Show>
            <span class={styles.rowCopy}>
              <span class={`${styles.bone} ${styles.title}`} />
              <span class={`${styles.bone} ${styles.subtitle}`} />
            </span>
            <span class={mediaLayout() ? media.menu : song.actionStripe} data-skeleton-menu>
              <Show when={!mediaLayout() && !props.compact}>
                <span class={`${styles.bone} ${styles.duration}`} />
              </Show>
              <span class={!mediaLayout() ? song.iconBtn : undefined}>
                <span class={`${styles.bone} ${styles.menuPill}`} />
              </span>
            </span>
            <Show when={mediaLayout()}><span class={`${styles.bone} ${media.cover} ${props.round ? styles.round : ''}`} data-skeleton-cover /></Show>
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
  cardClass?: string;
  decorative?: boolean;
  class: string;
}) {
  const layout = () => props.layout ?? 'grid';
  const lines = () => props.lines ?? 2;

  return (
    <div
      class={props.class}
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
          <div class={props.cardClass ? `${styles.card} ${props.cardClass}` : styles.card} aria-hidden="true">
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
