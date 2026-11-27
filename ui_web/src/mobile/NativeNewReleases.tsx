import { createEffect, createSignal, For, on, Show } from 'solid-js';
import Button from '../components/Button';
import { CoverImage } from '../components/CoverImage';
import styles from '../components/HomeNewReleases.module.css';
import { coverGradient } from '../lib/cover';
import { t } from '../lib/i18n';
import { createNewReleases, releaseDestination } from '../lib/newReleases';
import { discoveryEntitySubtitle } from '../lib/searchDiscovery';

/** Native Android Home New Releases rail backed by the user's Taste Profile. */
export default function NativeNewReleases(props: {
  generation: () => number;
  disconnected: () => boolean;
  onOpenEntityPath: (path: string) => void;
}) {
  const { items, load, reset, subscribe } = createNewReleases(props.generation, props.disconnected);
  const [expanded, setExpanded] = createSignal(false);

  createEffect(on(() => [props.generation(), props.disconnected()] as const, ([generation, disconnected], previous) => {
    if (!previous || generation !== previous[0]) reset();
    if (!disconnected) void load();
  }));

  subscribe();

  return (
    <Show when={!props.disconnected() && items().length > 0}>
      <section class={styles.section} aria-label={t('searchHome.newReleases')}>
        <div class={styles.header}>
          <h2>{t('searchHome.newReleases')}</h2>
          <Show when={items().length > 2}>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={expanded()}
              aria-label={`${expanded() ? t('savedEntities.showLess') : t('searchHome.seeAll')}: ${t('searchHome.newReleases')}`}
              onClick={() => setExpanded(prev => !prev)}
            >
              {expanded() ? t('savedEntities.showLess') : t('searchHome.seeAll')}
            </Button>
          </Show>
        </div>
        <div class={expanded() ? styles.expanded : styles.rail} data-horizontal-scroll={expanded() ? undefined : ''}>
          <For each={items()}>
            {item => (
              <Button
                variant="ghost"
                size="sm"
                class={styles.nativeCard}
                aria-label={item.title}
                onClick={() => props.onOpenEntityPath(releaseDestination(item))}
              >
                <span class={styles.cover} style={{ background: coverGradient(item.title) }}>
                  <CoverImage src={item.cover} />
                  <Show when={item.is_new}>
                    <span class={styles.newBadge}>{t('searchHome.badgeNew')}</span>
                  </Show>
                </span>
                <span class={styles.name}>{item.title}</span>
                <Show when={discoveryEntitySubtitle(item, false, { showReleaseDate: true })}>
                  {subtitle => <span class={styles.subtitle}>{subtitle()}</span>}
                </Show>
              </Button>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
