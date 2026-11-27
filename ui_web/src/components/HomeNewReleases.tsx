import { createSignal, For, onMount, Show } from 'solid-js';
import { coverGradient } from '../lib/cover';
import { t } from '../lib/i18n';
import { createNewReleases, releaseDestination } from '../lib/newReleases';
import { discoveryEntitySubtitle } from '../lib/searchDiscovery';
import { userKey } from '../lib/session';
import Button from './Button';
import { CoverImage } from './CoverImage';
import { MusicLink } from './MusicLinks';
import styles from './HomeNewReleases.module.css';

/** Taste-profile New Releases rail rendered lazily on the Library Home page. */
export default function HomeNewReleases() {
  const { items, load, subscribe } = createNewReleases(() => userKey('home-new-releases'));
  const [expanded, setExpanded] = createSignal(false);

  onMount(() => {
    void load();
    subscribe();
  });

  return (
    <Show when={items().length > 0}>
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
              <MusicLink class={styles.card} path={releaseDestination(item)} label={item.title}>
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
              </MusicLink>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
