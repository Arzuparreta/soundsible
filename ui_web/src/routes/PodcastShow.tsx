import Button from '../components/Button';
import { mobileListLayout } from '../lib/listLayout';
import { MusicListRow } from '../components/MusicListRow';
import { openContextMenu } from '../lib/contextMenu';
import { BackIcon, CheckIcon, DownloadIcon, RefreshIcon, menuIcons } from '../components/icons';
import { useAppBar } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from 'solid-js';
import { useParams, useNavigate, useSearchParams } from '@solidjs/router';
import { api } from '../lib/api';
import { state, actions, isPlayingEpisode } from '../stores';
import { t } from '../lib/i18n';
import type { PodcastEpisode, PodcastShowInfo, PodcastSubscription } from '../types/podcast';
import styles from './PodcastShow.module.css';
import { neutralCoverStyle } from '../lib/cover';
import { SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { VirtualRows } from '../components/VirtualRows';
import { navigateBackOr, registerPrimaryScroll } from '../lib/scrollHistory';
import { createResponsiveTap } from '../lib/responsiveTap';
import { followPodcast, shownPodcast } from '../lib/podcasts';
import { toast } from '../lib/toast';
import { attachPullToRefresh, PULL_ARMED, type PullFrame } from '../lib/pullToRefresh';

interface ShowFeed {
  subscription?: PodcastSubscription;
  /** What the feed says about a show that is not followed yet. */
  feed?: { title?: string; author?: string; image_url?: string };
  episodes?: PodcastEpisode[];
  /** Where the rest of a feed too long to read at once picks up. */
  next?: number | null;
}

function fmtDur(s?: number): string {
  if (s == null || !Number.isFinite(s) || s <= 0) return '';
  const m = Math.round(s / 60);
  return t('podcastShow.durationMin', { m });
}

function fmtDate(s?: string): string {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

/**
 * One show: `/podcasts/:id` once it is followed, `/podcasts/feed?url=` when it
 * was opened from the directory before that. The second reads the feed itself
 * and offers to follow it; the moment the show is followed — here or on any
 * other device — the page moves to the first, which keeps the episode cache
 * and the way to unfollow.
 */
export default function PodcastShow() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const feedUrl = () => (!params.id && typeof searchParams.url === 'string' ? searchParams.url : '');
  const sub = createMemo(() => state.podcastSubscriptions.find((s) =>
    params.id ? s.id === params.id : !!feedUrl() && s.rss_url === feedUrl()) ?? null);
  createEffect(() => {
    const followed = sub();
    if (followed && !params.id) navigate(`/podcasts/${encodeURIComponent(followed.id)}`, { replace: true });
  });
  const [failed, setFailed] = createSignal(false);
  type Source = { id: string } | { url: string };
  const source = (): Source | false => {
    const id = params.id;
    return id ? { id } : feedUrl() ? { url: feedUrl() } : false;
  };
  const sameSource = (a: Source) => {
    const b = source();
    return !!b && ('id' in a ? 'id' in b && b.id === a.id : 'url' in b && b.url === a.url);
  };
  /** A show nobody follows is read from its feed every time it is opened. */
  const readFeed = async (url: string): Promise<ShowFeed> => {
    const feed = await api.browsePodcastFeed(url);
    return { episodes: feed.episodes, feed: feed.show, next: feed.next };
  };
  const [data, { refetch, mutate }] = createResource(source, async (from): Promise<ShowFeed | null> => {
    setFailed(false);
    try {
      if (!('id' in from)) return await readFeed(from.url);
      // A followed show opens on what the engine kept of it, and then asks
      // the feed for anything published since: a new episode joins the list a
      // moment later instead of the whole page waiting on the feed.
      const kept = await api.getPodcastEpisodes(from.id, 'cached');
      void lookForNew(from.id);
      return kept;
    } catch { setFailed(true); return null; }
  });
  const lookForNew = async (id: string) => {
    try {
      const fresh = await api.getPodcastEpisodes(id);
      if (fresh.changed && sameSource({ id }) && !refreshing()) mutate(fresh);
    } catch { /* What was kept is already on screen. */ }
  };

  /** Read the feed again by hand, from the button or by pulling the list
   * down: whatever the feed's host serves now, however recently it was read. */
  const [refreshing, setRefreshing] = createSignal(false);
  const refresh = async () => {
    const from = source();
    if (!from || refreshing()) return;
    setRefreshing(true);
    try {
      const fresh = 'id' in from ? await api.getPodcastEpisodes(from.id, 'refresh') : await readFeed(from.url);
      if (!sameSource(from)) return;
      setFailed(false);
      mutate(fresh);
    } catch {
      if (sameSource(from)) toast.error(t('podcastShow.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  };
  const [pull, setPull] = createSignal<PullFrame>({ captured: false, distance: 0, armed: false });

  /** A show nobody follows yet, as the directory row that opened it described
   * it until the feed itself answers. */
  const preview = createMemo<PodcastShowInfo | null>(() => {
    const url = feedUrl();
    if (!url) return null;
    const row = shownPodcast(url);
    const feed = data()?.feed;
    return {
      rss_url: url,
      title: row?.title || feed?.title || '',
      author: row?.author || feed?.author,
      image_url: row?.image_url || feed?.image_url || null,
      itunes_collection_id: row?.itunes_collection_id,
    };
  });

  /** The subscription as the library knows it, or as the feed response reports
   * it while the library list is still syncing. */
  const show = (): PodcastShowInfo | null =>
    sub() ?? data()?.subscription ?? preview();
  const title = () => show()?.title || t('podcastShow.fallbackTitle');
  const image = () => show()?.image_url ?? null;

  const [onlyDownloaded, setOnlyDownloaded] = createSignal(false);
  const [scroller, setScroller] = createSignal<HTMLDivElement | null>(null);
  const localByGuid = createMemo(
    () =>
      new Map(
        state.library
          .filter((t) => t.media_kind === 'podcast_episode' && t.podcast_episode_guid)
          .map((t) => [t.podcast_episode_guid as string, t] as const),
      ),
  );
  const isDownloaded = (ep: PodcastEpisode) => localByGuid().has(ep.guid);

  /** The rest of a feed too long to read at once, a page per request, only
   * when asked for (#250). Starts over with every answer the page loads. */
  const [more, setMore] = createSignal<PodcastEpisode[]>([]);
  const [next, setNext] = createSignal<number | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  createEffect(() => {
    const feed = data();
    setMore([]);
    setNext(feed?.next ?? null);
  });
  const loadMore = async () => {
    const after = next();
    const url = show()?.rss_url;
    if (after == null || !url || loadingMore()) return;
    const base = data();
    setLoadingMore(true);
    try {
      const page = await api.browsePodcastFeed(url, after);
      if (data() !== base) return;
      // A followed show's cached list can end before the entry the next page
      // starts from, so the two may overlap.
      const seen = new Set([...(base?.episodes ?? []), ...more()].map((e) => e.guid));
      setMore((eps) => [...eps, ...(page.episodes ?? []).filter((e) => !seen.has(e.guid))]);
      setNext(page.next ?? null);
    } catch {
      if (data() === base) toast.error(t('common.loadFailed'));
    } finally {
      setLoadingMore(false);
    }
  };

  const episodes = createMemo<PodcastEpisode[]>(() => {
    const eps = [...(data()?.episodes ?? []), ...more()];
    return onlyDownloaded() ? eps.filter((e) => localByGuid().has(e.guid)) : eps;
  });

  /** Play the downloaded local copy when present, else stream via token. */
  const playEp = (ep: PodcastEpisode) => {
    const local = localByGuid().get(ep.guid);
    if (local) actions.playTrack(local);
    else void actions.playEpisode(ep, show()?.title, show()?.id, image());
  };

  const [following, setFollowing] = createSignal(false);
  const follow = async () => {
    const info = preview();
    if (!info || following()) return;
    setFollowing(true);
    try {
      const followed = await followPodcast({
        title: info.title, author: info.author, feed_url: info.rss_url,
        image_url: info.image_url ?? undefined, itunes_collection_id: info.itunes_collection_id ?? undefined,
      });
      // Normally the library sync has already moved the page; this covers a
      // sync that has not caught up with the new show yet.
      if (followed?.id && !sub()) navigate(`/podcasts/${encodeURIComponent(followed.id)}`, { replace: true });
    } catch {
      toast.error(t('podcasts.subscribeFailed'));
    } finally {
      setFollowing(false);
    }
  };

  const unsubscribe = async () => {
    const id = sub()?.id;
    if (!id) return;
    await api.unsubscribePodcast(id).catch(() => {});
    await actions.syncLibrary();
    navigateBackOr(navigate, '/podcasts');
  };

  const back = () => navigateBackOr(navigate, '/podcasts');
  useAppBar({ title, back, backLabel: () => t('podcastShow.ariaBack') });

  return (
    <div class="view">
      <header class={styles.header}>
        <Show when={desktopShell()}>
          <button class={styles.back} type="button" aria-label={t('podcastShow.ariaBack')} onClick={back}>
            <BackIcon size={20} />
          </button>
        </Show>
        <div class={styles.cover} style={neutralCoverStyle(image())} />
        <div class={styles.info}>
          <Show when={desktopShell()}>
            <h1 class={styles.title}>{title()}</h1>
          </Show>
          <span class={styles.author}>{show()?.author}</span>
        </div>
        <Show when={sub()} fallback={<Show when={feedUrl()}>
          <button class={styles.follow} type="button" disabled={following()} aria-busy={following() || undefined} onClick={() => void follow()}>
            {following() ? t('podcasts.subscribing') : t('podcasts.subscribe')}
          </button>
        </Show>}>
          <button class={styles.unsub} type="button" onClick={unsubscribe}>
            {t('podcastShow.unsubscribe')}
          </button>
        </Show>
      </header>

      <div class={styles.filterBar}>
        <button
          class={styles.filter}
          classList={{ [styles.filterOn]: onlyDownloaded() }}
          type="button"
          onClick={() => setOnlyDownloaded((v) => !v)}
        >
          {t('podcastShow.downloadedOnly')}
        </button>
        <button
          class={styles.refresh}
          classList={{ [styles.spinning]: refreshing() }}
          type="button"
          aria-label={t('podcastShow.refresh')}
          title={t('podcastShow.refresh')}
          aria-busy={refreshing() || undefined}
          disabled={refreshing() || !source()}
          onClick={() => void refresh()}
        >
          <RefreshIcon size={18} />
        </button>
      </div>

      {/* The pull follows the finger; once let go far enough it holds while
        * the feed is read. */}
      <div
        class={styles.pull}
        classList={{ [styles.pullArmed]: pull().armed, [styles.spinning]: refreshing() && !pull().captured }}
        style={{ height: `${pull().captured ? pull().distance : refreshing() ? PULL_ARMED * 0.75 : 0}px` }}
        data-pulling={pull().captured ? '' : undefined}
        aria-hidden="true"
      >
        <span class={styles.pullIcon} style={{ transform: `rotate(${Math.round((pull().distance / PULL_ARMED) * 270)}deg)` }}>
          <RefreshIcon size={20} />
        </span>
      </div>

      <div
        ref={(element) => {
          setScroller(element);
          registerPrimaryScroll(element, () => !data.loading);
          onCleanup(attachPullToRefresh(element, {
            onPull: setPull,
            onRefresh: () => void refresh(),
            enabled: () => !data.loading && !refreshing(),
          }));
        }}
        class={styles.scroll}
        data-primary-scroll
      >
        <Show
          when={!data.loading}
          fallback={<SkeletonRows count={8} compact />}
        >
          <Show when={episodes().length} fallback={<EmptyState tone={failed() ? 'danger' : undefined}>{failed() ? t('common.loadFailed') : t('podcastShow.empty')} <Show when={failed()}><Button variant="secondary" onClick={() => void refetch()}>{t('common.retry')}</Button></Show></EmptyState>}>
          {/* Only the rows in view are built. A show that has run for years
            * lists thousands of episodes, most with artwork of their own, and
            * a cover is a background image the browser downloads the moment
            * its row exists: a whole feed's worth was a gigabyte of 3000px
            * JPEGs that took the connection from playback for minutes (#250). */}
          <VirtualRows items={episodes()} scrollElement={scroller} rowHeight={{ cssVar: '--row-h', fallback: 56 }} measureRows>
            {(item) => <Show when={item()} keyed>{(ep) => {
              const id = ep.guid || ep.enclosure_url;
              const downloaded = () => isDownloaded(ep);
              const downloading = () => state.downloads.queue.some((item) => item.song_str === ep.enclosure_url
                && (item.status === 'pending' || item.status === 'downloading'));
              const tap = createResponsiveTap({ onTap: () => playEp(ep) });
              return (
                <Show when={!mobileListLayout()} fallback={<MusicListRow playback title={ep.title}
                  subtitle={[fmtDate(ep.published), fmtDur(ep.duration_sec)].filter(Boolean).join(' · ')}
                  seed={id} cover={ep.image || image()} active={isPlayingEpisode(id)} busy={downloading()} busyLabel={t('collection.downloading')}
                  actionLabel={`${t('podcastShow.ariaPlay')}: ${ep.title}`} onActivate={() => playEp(ep)}
                  onMenu={() => openContextMenu({ title: ep.title, subtitle: title(), actions: [
                    { icon: menuIcons.play(), label: t('podcastShow.ariaPlay'), onSelect: () => playEp(ep) },
                    { icon: downloaded() ? menuIcons.check() : menuIcons.download(), label: t(downloaded() ? 'podcastShow.ariaDownloaded' : downloading() ? 'collection.downloading' : 'podcastShow.ariaDownload'), disabled: downloaded() || downloading(),
                      onSelect: () => void actions.downloadEpisode(ep, show()) },
                  ] })} />}>
                <div
                  class={styles.ep}
                  data-now-playing={isPlayingEpisode(id) ? '' : undefined}
                  data-pressable
                  role="button"
                  tabindex="0"
                  aria-label={`${t('podcastShow.ariaPlay')}: ${ep.title}`}
                  {...tap}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    playEp(ep);
                  }}
                >
                  <button
                    class={styles.epPlay}
                    type="button"
                    aria-label={t('podcastShow.ariaPlay')}
                    onClick={(e) => {
                      e.stopPropagation();
                      playEp(ep);
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <path fill="currentColor" d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                  {/* The same artwork the mobile row draws. Every other desktop
                    * list in the app shows a thumbnail beside the title; this
                    * row was the one that did not, so a show's episodes read as
                    * a wall of text next to an album of the same length. */}
                  <div class={styles.epCover} style={neutralCoverStyle(ep.image || image())} />
                  <div class={styles.epMeta}>
                    <span class={styles.epTitle}>{ep.title}</span>
                    <span class={styles.epSub}>
                      {[fmtDate(ep.published), fmtDur(ep.duration_sec)].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <Show
                    when={downloaded()}
                    fallback={
                      <button
                        class={styles.epDownload}
                        type="button"
                        aria-label={t('podcastShow.ariaDownload')}
                        onClick={(e) => {
                          e.stopPropagation();
                          void actions.downloadEpisode(ep, show());
                        }}
                      >
                        <DownloadIcon size={18} />
                      </button>
                    }
                  >
                    <span class={styles.epDownloaded} aria-label={t('podcastShow.ariaDownloaded')}>
                      <CheckIcon size={16} />
                    </span>
                  </Show>
                </div>
                </Show>
              );
            }}</Show>}
          </VirtualRows>
          </Show>
          <Show when={next() != null}>
            <div class={styles.more}>
              <Button variant="secondary" disabled={loadingMore()} aria-busy={loadingMore() || undefined} onClick={() => void loadMore()}>
                {loadingMore() ? t('common.loading') : t('podcastShow.loadMore')}
              </Button>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
