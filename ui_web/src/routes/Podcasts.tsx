import { useAppBar } from '../lib/appBar';
import { mobileListLayout } from '../lib/listLayout';
import { MusicListRow } from '../components/MusicListRow';
import { openContextMenu } from '../lib/contextMenu';
import { createMemo, createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import { A, useNavigate, useSearchParams } from '@solidjs/router';
import { api } from '../lib/api';
import { state } from '../stores';
import { ensureDiscover, topPodcasts, revalidating } from '../lib/discover';
import { t } from '../lib/i18n';
import type { PodcastSearchResult } from '../types/podcast';
import styles from './Podcasts.module.css';
import { neutralCoverStyle } from '../lib/cover';
import type { ActionMenuOptions } from '../components/ActionMenu';
import { followPodcast, podcastPath } from '../lib/podcasts';
import { menuIcons } from '../components/icons';
import { toast } from '../lib/toast';
import { SkeletonCards, SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { createResponsiveTap } from '../lib/responsiveTap';
import { SearchField } from '../components/SearchField';
import { registerPrimaryScroll } from '../lib/scrollHistory';

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** Podcasts: your subscriptions grid + iTunes directory search. Every show
 * opens its page, followed or not; following is a choice made there, in the
 * row's menu or with the search row's own button — never a side effect of
 * opening one. */
export default function Podcasts() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = createSignal(typeof searchParams.q === 'string' ? searchParams.q : '');
  const [results, setResults] = createSignal<PodcastSearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [subscribing, setSubscribing] = createSignal<Set<string>>(new Set());

  const subscribedFeeds = createMemo(() => new Set(state.podcastSubscriptions.map((s) => s.rss_url)));
  const recommendedPodcasts = createMemo(() =>
    topPodcasts().filter((podcast) => !subscribedFeeds().has(podcast.feed_url)),
  );

  /** Open a show from its card or row. Touch activates on release like every
   * other list, and a held press opens the show's menu instead of it. */
  const openTap = (href: () => string, menu?: () => ActionMenuOptions) => ({
    ...createResponsiveTap({
      onTap: (event) => {
        event.preventDefault();
        navigate(href());
      },
      onLongPress: menu ? () => openContextMenu(menu()) : undefined,
    }),
    onContextMenu: (event: MouseEvent) => {
      if (!menu) return;
      event.preventDefault();
      openContextMenu(menu(), event);
    },
  });

  let aborter: AbortController | undefined;
  let debounce: number | undefined;
  let requestId = 0;

  const run = (query: string) => {
    query = query.trim();
    setSearchParams({ q: query || undefined }, { replace: true });
    const current = ++requestId;
    aborter?.abort();
    aborter = undefined;
    setSearchError(false);
    if (query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    aborter = new AbortController();
    setLoading(true);
    api
      .searchPodcasts(query, aborter.signal)
      .then((next) => {
        if (current !== requestId) return;
        setResults(next);
      })
      .catch((e) => {
        if (current !== requestId || isAbort(e)) return;
        setResults([]);
        setSearchError(true);
      })
      .finally(() => {
        if (current === requestId) setLoading(false);
      });
  };

  onMount(() => {
    ensureDiscover();
    if (q().trim().length >= 2) run(q());
  });

  const onInput = (v: string) => {
    setQ(v);
    clearTimeout(debounce);
    debounce = window.setTimeout(() => run(v), 300);
  };

  const subscribe = async (r: PodcastSearchResult) => {
    setSubscribing((s) => new Set(s).add(r.feed_url));
    try {
      await followPodcast(r);
    } catch {
      toast.error(t('podcasts.subscribeFailed'));
    } finally {
      setSubscribing((s) => {
        const n = new Set(s);
        n.delete(r.feed_url);
        return n;
      });
    }
  };

  const subscribeAction = (p: PodcastSearchResult) => {
    const subscribed = subscribedFeeds().has(p.feed_url);
    return {
      icon: subscribed ? menuIcons.check() : menuIcons.subscribe(),
      label: t(subscribed ? 'podcasts.subscribed' : 'podcasts.subscribe'),
      disabled: subscribed || subscribing().has(p.feed_url),
      onSelect: () => void subscribe(p),
    };
  };

  const recommendationMenu = (p: PodcastSearchResult): ActionMenuOptions => {
    return {
      title: p.title,
      subtitle: p.author,
      actions: [
        subscribeAction(p),
        ...(p.reason ? [{ icon: menuIcons.info(), label: p.reason, disabled: true, onSelect: () => {} }] : []),
        ...(p.recommendation_identity ? [{
          icon: menuIcons.feedback(),
          label: t('trackActions.notInterested'),
          onSelect: () => {
            void api.sendDiscoveryFeedback({
              media_type: 'podcast_show',
              podcast_feed_id: p.feed_url,
              podcast_show_title: p.title,
              podcast_author: p.author,
              itunes_collection_id: p.itunes_collection_id,
              source: 'podcast',
            }).then((result) => {
              if (!result.recorded || !result.event_id) return;
              toast.action(t('trackActions.feedbackSaved'), t('common.undo'), () => {
                void api.undoDiscoveryFeedback(result.event_id!).catch(() => {});
              });
            }).catch(() => toast.error(t('trackActions.feedbackFailed')));
          },
        }] : []),
      ],
    };
  };

  onCleanup(() => {
    requestId += 1;
    aborter?.abort();
    clearTimeout(debounce);
  });

  useAppBar({ title: () => t('nav.podcasts') });

  return (
    <div class="view">
      <div class={styles.bar}>
        <SearchField
          placeholder={t('podcasts.searchPlaceholder')}
          clearLabel={t('searchPanel.clear')}
          value={q()}
          onInput={onInput}
        />
      </div>

      <div
        ref={(element) => registerPrimaryScroll(element, () => !loading())}
        class={styles.scroll}
        data-primary-scroll
      >
        <Show when={loading() && results().length > 0}>
          <div class={styles.loadingBar} role="status" aria-live="polite" aria-label={t('common.loading')}>
            <span>{t('common.loading')}</span>
          </div>
        </Show>
        <Show
          when={q().trim().length >= 2}
          fallback={
            <>
              <Show when={state.podcastSubscriptions.length > 0}>
                <h2 class={styles.sectionTitle}>{t('podcasts.yourShows')}</h2>
                <div class={styles.grid}>
                  <For each={state.podcastSubscriptions}>
                    {(s) => {
                      const href = `/podcasts/${encodeURIComponent(s.id)}`;
                      return (
                        <A href={href} class={styles.card} data-pressable {...openTap(() => href)}>
                          <div class={styles.cover} style={neutralCoverStyle(s.image_url)} />
                          <span class={styles.name}>{s.title}</span>
                          <span class={styles.author}>{s.author}</span>
                        </A>
                      );
                    }}
                  </For>
                </div>
              </Show>

              <Show when={recommendedPodcasts().length > 0}>
                <h2 class={styles.sectionTitle}>{t('podcasts.top')}</h2>
                <div class={styles.grid}>
                  <For each={recommendedPodcasts()}>
                    {(p) => (
                      <A href={podcastPath(p)} class={styles.card} data-pressable
                        {...openTap(() => podcastPath(p), () => recommendationMenu(p))}>
                        <div class={styles.cover} style={neutralCoverStyle(p.image_url)} />
                        <span class={styles.name}>{p.title}</span>
                        <span class={styles.author}>{p.author}</span>
                      </A>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={state.podcastSubscriptions.length === 0 && recommendedPodcasts().length === 0}>
                <Show when={state.loading || revalidating()} fallback={<EmptyState>{t('podcasts.hint')}</EmptyState>}><SkeletonCards /></Show>
              </Show>
            </>
          }
        >
          <Show when={loading() && results().length === 0}>
            <SkeletonRows count={6} compact />
          </Show>
          <Show when={!loading() && results().length === 0}>
            <EmptyState compact tone={searchError() ? 'danger' : 'neutral'}>
              {searchError() ? (
                <>
                  {t('search.catalogErrorHint')}{' '}
                  <button class={styles.retry} type="button" onClick={() => run(q())}>
                    {t('common.retry')}
                  </button>
                </>
              ) : (
                t('podcasts.noResults')
              )}
            </EmptyState>
          </Show>
          <div
            classList={{ [styles.results]: true, [styles.resultsRefreshing]: loading() }}
            aria-busy={loading()}
            aria-disabled={loading()}
            inert={loading() ? true : undefined}
          >
            <For each={results()}>
              {(r) => {
                const disabled = () => subscribing().has(r.feed_url);
                const tap = createResponsiveTap({
                  disabled,
                  onTap: () => void subscribe(r),
                });
                return (
                  <Show when={!mobileListLayout()} fallback={<MusicListRow title={r.title} subtitle={r.author}
                    seed={r.feed_url} cover={r.image_url} busy={disabled()} busyLabel={t('podcasts.subscribing')}
                    onActivate={() => navigate(podcastPath(r))}
                    onMenu={() => openContextMenu({ title: r.title, subtitle: r.author, actions: [subscribeAction(r)] })} />}>
                  <div class={styles.row}>
                    <A href={podcastPath(r)} class={styles.rowOpen} data-pressable {...openTap(() => podcastPath(r))}>
                      <div class={styles.rowCover} style={neutralCoverStyle(r.image_url)} />
                      <div class={styles.meta}>
                        <span class={styles.title}>{r.title}</span>
                        <span class={styles.sub}>{r.author}</span>
                      </div>
                    </A>
                    <Show
                      when={!subscribedFeeds().has(r.feed_url)}
                      fallback={<span class={styles.subbed}>{t('podcasts.subscribed')}</span>}
                    >
                      <button
                        class={styles.subBtn}
                        data-pressable
                        type="button"
                        disabled={disabled()}
                        {...tap}
                      >
                        {disabled() ? t('podcasts.subscribing') : t('podcasts.subscribe')}
                      </button>
                    </Show>
                  </div>
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
