import { createSignal, For, Show, type JSX } from 'solid-js';
import type { DiscoveryBrowseItem } from '../lib/api';
import { coverGradient } from '../lib/cover';
import { t } from '../lib/i18n';
import { discoveryEntitySubtitle } from '../lib/searchDiscovery';
import Button from './Button';
import { CoverImage } from './CoverImage';
import styles from './HomeNewReleases.module.css';

export default function NewReleasesRail(props: {
  items: DiscoveryBrowseItem[];
  renderCard: (item: DiscoveryBrowseItem, content: JSX.Element) => JSX.Element;
}) {
  const [expanded, setExpanded] = createSignal(false);
  return (
    <Show when={props.items.length > 0}>
      <section class={styles.section} aria-label={t('searchHome.newReleases')}>
        <div class={styles.header}>
          <h2>{t('searchHome.newReleases')}</h2>
          <Show when={props.items.length > 2}>
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
          <For each={props.items}>
            {item => props.renderCard(item, (
              <>
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
              </>
            ))}
          </For>
        </div>
      </section>
    </Show>
  );
}
