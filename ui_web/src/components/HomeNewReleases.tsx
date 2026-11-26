import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { api, type DiscoveryBrowseItem } from '../lib/api';
import { albumPath } from '../lib/artistRoute';
import { coverGradient } from '../lib/cover';
import { onDiscoveryFeedReady } from '../lib/discoveryEvents';
import { t } from '../lib/i18n';
import { discoveryEntitySubtitle } from '../lib/searchDiscovery';
import { userKey } from '../lib/session';
import Button from './Button';
import { CoverImage } from './CoverImage';
import { MusicLink } from './MusicLinks';
import styles from './HomeNewReleases.module.css';

function releaseDestination(item: DiscoveryBrowseItem): string {
  const deezerId = item.external_ids?.deezer_album_id
    ? String(item.external_ids.deezer_album_id)
    : undefined;
  return albumPath(item.title, item.artist ?? item.subtitle ?? '', {
    view: 'discover',
    deezerId,
  });
}

/** Taste-profile New Releases rail rendered lazily on the Library Home page. */
export default function HomeNewReleases() {
  const [items, setItems] = createSignal<DiscoveryBrowseItem[]>([]);
  const [expanded, setExpanded] = createSignal(false);
  let controller: AbortController | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackUsed = false;
  let awaitingRevalidate = false;
  let disposed = false;
  let epoch = 0;

  async function load(fromFallback = false) {
    if (typeof api.getDiscoveryNewReleases !== 'function') return;
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const op = ++epoch;
    const account = userKey('home-new-releases');
    try {
      const response = await api.getDiscoveryNewReleases(request.signal, 12);
      if (disposed || request.signal.aborted || op !== epoch || userKey('home-new-releases') !== account) return;
      setItems(Array.isArray(response?.items) ? response.items : []);
      if (response?.revalidating) {
        awaitingRevalidate = true;
        if (!fallbackUsed && !fromFallback) {
          fallbackTimer = setTimeout(() => {
            if (!disposed) {
              fallbackUsed = true;
              void load(true);
            }
          }, 5000);
        }
      } else {
        awaitingRevalidate = false;
      }
    } catch {
      awaitingRevalidate = false;
      // Keep Home clean and silent when offline or unavailable.
    }
  }

  onMount(() => {
    void load();
    const stopPush = onDiscoveryFeedReady((data) => {
      if (disposed) return;
      if (data.reason !== 'new_releases' && !(data.reason === undefined && awaitingRevalidate)) return;
      awaitingRevalidate = false;
      void load();
    });
    onCleanup(() => {
      disposed = true;
      clearTimeout(fallbackTimer);
      stopPush();
      controller?.abort();
    });
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
