import { ViewHeader } from '../components/ViewHeader';
import { mobileListLayout } from '../lib/listLayout';
import { MusicListRow } from '../components/MusicListRow';
import { openContextMenu } from '../lib/contextMenu';
import { openPlayOnDevice } from '../components/DeviceSheet';
import { podcastEpisodeToTrack } from '../lib/track';
import { createEffect, on, createMemo, createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import { A, useNavigate, useSearchParams } from '@solidjs/router';
import { podcastCountry, countryName } from '../lib/podcastCountry';
import { PodcastCountryPicker } from '../components/PodcastCountryPicker';
import { user } from '../lib/session';
import { api, request } from '../lib/api';
import { state } from '../stores';
import { player } from '../stores/player';
import { ensureDiscover, refreshDiscover, topPodcasts, topEpisodes, chartsCountry, chartFailed, episodesFailed, revalidating } from '../lib/discover';
import { t } from '../lib/i18n';
import type { PodcastSearchResult, PopularPodcastEpisode, PodcastEpisode } from '../types/podcast';
import styles from './Podcasts.module.css';
import { CollectionGrid } from '../components/CollectionGrid';
import { neutralCoverStyle } from '../lib/cover';
import type { ActionMenuOptions } from '../components/ActionMenu';
import { followPodcast, podcastPath } from '../lib/podcasts';
import { menuIcons } from '../components/icons';
import { toast } from '../lib/toast';
import { SkeletonCards, SkeletonHeading, SkeletonRegion, SkeletonRows } from '../design/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { createResponsiveTap } from '../lib/responsiveTap';
import { createSearchReveal } from '../components/SearchReveal';
import { createPodcastSearch } from '../lib/podcastSearch';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { CARD_ARTWORK, ROW_ARTWORK, podcastArtwork } from '../lib/podcastArtwork';

/** Podcasts: your subscriptions grid + iTunes directory search. Every show
 * opens its page, followed or not; following is a choice made there, in the
 * row's menu or with the search row's own button — never a side effect of
 * opening one. */
export default function Podcasts() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = createSignal(typeof searchParams.q === 'string' ? searchParams.q : '');
  const [subscribing, setSubscribing] = createSignal<Set<string>>(new Set());
  const subscriptions = () => state.podcastSubscriptions;
  const search = createPodcastSearch({ query: q, subscriptions, country: podcastCountry, account: () => user()?.id });
  const subscribedFeeds = createMemo(() => new Set(state.podcastSubscriptions.map((s) => s.rss_url)));
  const [genre, setGenre] = createSignal('');
  const matchesGenre = (row: PodcastSearchResult) => !genre() || row.genres?.some(g => g.id === genre());
  const recommendedPodcasts = createMemo(() =>
    chartsCountry() === podcastCountry() ? topPodcasts().filter(matchesGenre) : [],
  );
  const popularEpisodes = createMemo(() => chartsCountry() === podcastCountry() ? topEpisodes().filter(matchesGenre) : []);
  const genres = createMemo(() => chartsCountry() === podcastCountry()
    ? [...new Map([...topPodcasts(), ...topEpisodes()].flatMap(row => row.genres ?? []).map(g => [g.id, g])).values()]
        .sort((a, b) => a.name.localeCompare(b.name)) : []);

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

  let disposed = false;
  let episodeRequest: AbortController | undefined;
  const [playingEpisode, setPlayingEpisode] = createSignal<string>();
  const countryLabel = () => countryName(podcastCountry() ?? 'us');
  createEffect(on(podcastCountry, (country, previous) => {
    if (previous && country !== previous) {
      episodeRequest?.abort(); episodeRequest = undefined; setPlayingEpisode(undefined);
      setGenre(''); refreshDiscover();
    }
  }));

  const playPopularEpisode = async (episode: PopularPodcastEpisode, remote = false) => {
    if (playingEpisode()) return;
    const account = user()?.id, country = podcastCountry();
    const previousTrack = player().playback.currentTrack;
    const controller = new AbortController(); episodeRequest = controller;
    setPlayingEpisode(episode.episode_id);
    try {
      const data = await request<{ episode: PodcastEpisode; show_title: string; feed_url: string }>(
        `/api/discovery/podcasts/episode?show_id=${episode.itunes_collection_id}&episode_id=${episode.episode_id}&country=${country}`,
        { timeoutMs: 25000, signal: controller.signal });
      if (disposed || controller.signal.aborted || user()?.id !== account || podcastCountry() !== country || player().playback.currentTrack !== previousTrack) return;
      const feedId = state.podcastSubscriptions.find(show => show.rss_url === data.feed_url)?.id ?? data.feed_url;
      const local = state.library.find(track => track.podcast_episode_guid === data.episode.guid
        && (track.podcast_feed_id === feedId || track.podcast_feed_id === data.feed_url || track.podcast_rss_url === data.feed_url));
      if (remote) openPlayOnDevice(local ?? podcastEpisodeToTrack(data.episode, data.show_title, feedId, data.episode.image ?? episode.image_url));
      else if (local) player().actions.playTrack(local);
      else await player().actions.playEpisode(data.episode, data.show_title, feedId, data.episode.image ?? episode.image_url);
    } catch { if (!disposed && !controller.signal.aborted && user()?.id === account && podcastCountry() === country) toast.error(t('podcasts.episodeUnavailable')); }
    finally { if (episodeRequest === controller) { episodeRequest = undefined; setPlayingEpisode(undefined); } }
  };

  onMount(ensureDiscover);

  const onInput = (value: string) => {
    setQ(value);
    setSearchParams({ q: value.trim() || undefined }, { replace: true });
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
    disposed = true;
    episodeRequest?.abort();
  });

  const reveal = createSearchReveal(() => ({
    placeholder: t('podcasts.searchPlaceholder'), value: q(), onInput,
  }));

  return (
    <div class="view">
      <ViewHeader title={t('nav.podcasts')} trailing={<PodcastCountryPicker />}
        search={reveal}
      />

      <div
        ref={(element) => registerPrimaryScroll(element, () => !search.pending())}
        class={styles.scroll}
        data-primary-scroll
      >
        <Show when={search.pending() && search.results().length > 0}>
          <div class={styles.loadingBar} role="status" aria-live="polite" aria-label={t('common.loading')}>
            <span>{t('common.loading')}</span>
          </div>
        </Show>
        <Show
          when={search.active()}
          fallback={
            <>
              <Show when={state.podcastSubscriptions.length > 0}>
                <h2 class={styles.sectionTitle}>{t('podcasts.yourShows')}</h2>
                <CollectionGrid items={subscriptions()} class={styles.grid}>
                  {(s) => {
                    const href = () => `/podcasts/${encodeURIComponent(s().id)}`;
                    return (
                      <A href={href()} class={styles.card} data-pressable {...openTap(href)}>
                        <div class={styles.cover} style={neutralCoverStyle(podcastArtwork(s().image_url, CARD_ARTWORK))} />
                        <span class={styles.name}>{s().title}</span>
                        <span class={styles.author}>{s().author}</span>
                      </A>
                    );
                  }}
                </CollectionGrid>
              </Show>

              <Show when={genres().length > 0}>
                <label class={styles.genreFilter}>
                  <span>{t('podcasts.category')}</span>
                  <select aria-label={t('podcasts.category')} value={genre()} onChange={event => setGenre(event.currentTarget.value)}>
                    <option value="">{t('podcasts.allCategories')}</option>
                    <For each={genres()}>{g => <option value={g.id}>{g.name}</option>}</For>
                  </select>
                </label>
              </Show>

              <Show when={recommendedPodcasts().length > 0}>
                <h2 class={styles.sectionTitle}>{t('podcasts.topCountry', { country: countryLabel() })}</h2>
                <div class={styles.grid}>
                  <For each={recommendedPodcasts()}>
                    {(p) => (
                      <A href={podcastPath(p)} class={styles.card} data-pressable
                        {...openTap(() => podcastPath(p), () => recommendationMenu(p))}>
                        <div class={styles.cover} style={neutralCoverStyle(podcastArtwork(p.image_url, CARD_ARTWORK))} />
                        <span class={styles.name}>{p.title}</span>
                        <span class={styles.author}>{p.author}</span>
                      </A>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={chartFailed()}><EmptyState compact tone="danger">
                {t('podcasts.chartFailed')} <button type="button" class={styles.retry} onClick={refreshDiscover}>{t('common.retry')}</button>
              </EmptyState></Show>
              <Show when={popularEpisodes().length > 0}>
                <h2 class={styles.sectionTitle}>{t('podcasts.topEpisodes', { country: countryLabel() })}</h2>
                <div class={styles.episodeList}>
                  <For each={popularEpisodes()}>{episode => <MusicListRow title={episode.title} subtitle={episode.author}
                    seed={episode.episode_id} cover={podcastArtwork(episode.image_url, ROW_ARTWORK)} busy={playingEpisode() === episode.episode_id}
                    busyLabel={t('common.loading')} onActivate={() => void playPopularEpisode(episode)}
                    onMenu={() => openContextMenu({ title: episode.title, actions: [{ icon: menuIcons.play(),
                      label: t('common.play'), disabled: !!playingEpisode(), onSelect: () => void playPopularEpisode(episode) },
                      { icon: menuIcons.device(), label: t('trackActions.playOnDevice'), disabled: !!playingEpisode(), onSelect: () => void playPopularEpisode(episode, true) }] })} />}</For>
                </div>
              </Show>
              <Show when={episodesFailed()}><EmptyState compact tone="danger">
                {t('podcasts.episodesFailed')} <button type="button" class={styles.retry} onClick={refreshDiscover}>{t('common.retry')}</button>
              </EmptyState></Show>

              <Show when={genre() && recommendedPodcasts().length === 0 && popularEpisodes().length === 0}>
                <EmptyState compact>{t('podcasts.noCategoryResults')}</EmptyState>
              </Show>
              <Show when={!genre() && state.podcastSubscriptions.length === 0 && recommendedPodcasts().length === 0 && topEpisodes().length === 0 && !chartFailed() && !episodesFailed()}>
                <Show when={state.loading || revalidating()} fallback={<EmptyState>{t('podcasts.hint')}</EmptyState>}>
                  <SkeletonRegion>
                    <SkeletonHeading class={styles.sectionTitle} />
                    <SkeletonCards count={12} lines={2} decorative />
                  </SkeletonRegion>
                </Show>
              </Show>
            </>
          }
        >
          <Show when={search.pending() && !search.results().length}><SkeletonRows count={8} variant="media" /></Show>
          <Show when={search.error()}>
            <EmptyState compact tone="danger">
              {t('search.catalogErrorHint')}{' '}
              <button class={styles.retry} type="button" onClick={search.retry}>{t('common.retry')}</button>
            </EmptyState>
          </Show>
          <Show when={!search.pending() && !search.error() && !search.results().length}>
            <EmptyState compact>{t('podcasts.noResults')}</EmptyState>
          </Show>
          <For each={search.results()}>
            {({ show, subscription }) => {
              const href = () => subscription ? `/podcasts/${encodeURIComponent(subscription.id)}` : podcastPath(show);
              return <MusicListRow
                title={show.title} subtitle={show.author} titlePath={href()}
                annotation={subscription ? t('podcasts.subscribed') : undefined} keepAnnotationVisible
                seed={show.feed_url} cover={podcastArtwork(show.image_url, ROW_ARTWORK)}
                busy={subscribing().has(show.feed_url)} busyLabel={t('podcasts.subscribing')}
                onActivate={() => navigate(href())}
                primaryAction={!subscription && !mobileListLayout()
                  ? { label: t('podcasts.subscribe'), onSelect: () => void subscribe(show) } : undefined}
                onMenu={!subscription && mobileListLayout()
                  ? event => openContextMenu({ title: show.title, subtitle: show.author, actions: [subscribeAction(show)] }, event)
                  : undefined}
              />;
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}
