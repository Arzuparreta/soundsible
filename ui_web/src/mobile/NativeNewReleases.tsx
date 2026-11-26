import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import Button from '../components/Button';
import { CoverImage } from '../components/CoverImage';
import styles from '../components/HomeNewReleases.module.css';
import type { DiscoveryBrowseItem } from '../lib/api';
import { albumPath } from '../lib/artistRoute';
import { coverGradient } from '../lib/cover';
import { onDiscoveryFeedReady } from '../lib/discoveryEvents';
import { t } from '../lib/i18n';
import { newReleasesApi } from '../lib/newReleasesApi';
import { discoveryEntitySubtitle } from '../lib/searchDiscovery';

function releaseDestination(item: DiscoveryBrowseItem): string {
  const deezerId = item.external_ids?.deezer_album_id
    ? String(item.external_ids.deezer_album_id)
    : undefined;
  return albumPath(item.title, item.artist ?? item.subtitle ?? '', {
    view: 'discover',
    deezerId,
  });
}

/** Native Android Home New Releases rail backed by the user's Taste Profile. */
export default function NativeNewReleases(props: {
  generation: () => number;
  disconnected: () => boolean;
  onOpenEntityPath: (path: string) => void;
}) {
  const [items, setItems] = createSignal<DiscoveryBrowseItem[]>([]);
  const [expanded, setExpanded] = createSignal(false);
  let controller: AbortController | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackUsed = false;
  let awaitingRevalidate = false;
  let disposed = false;
  let epoch = 0;

  async function load(fromFallback = false) {
    if (disposed || props.disconnected() || typeof newReleasesApi.getDiscoveryNewReleases !== 'function') {
      return;
    }
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const op = ++epoch;
    const gen = props.generation();
    try {
      const response = await newReleasesApi.getDiscoveryNewReleases(request.signal, 12);
      if (disposed || request.signal.aborted || op !== epoch || gen !== props.generation() || props.disconnected()) {
        return;
      }
      setItems(Array.isArray(response?.items) ? response.items : []);
      if (response?.revalidating) {
        awaitingRevalidate = true;
        if (!fallbackUsed && !fromFallback) {
          fallbackTimer = setTimeout(() => {
            if (!disposed && !props.disconnected()) {
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
      // Offline or unavailable: keep Library responsive without error banner.
    }
  }

  createEffect(on(() => [props.generation(), props.disconnected()] as const, ([, disconnected], previous) => {
    if (!previous || props.generation() !== previous[0]) {
      setItems([]);
      fallbackUsed = false;
      awaitingRevalidate = false;
      clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    }
    if (!disconnected) {
      void load();
    }
  }));

  const stopPush = onDiscoveryFeedReady((data) => {
    if (disposed || props.disconnected()) return;
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
