import { mobileListLayout } from '../lib/listLayout';
import { MusicListRow } from '../components/MusicListRow';
import { openContextMenu } from '../lib/contextMenu';
import { BackIcon, CheckIcon, DownloadIcon, menuIcons } from '../components/icons';
import { useAppBar } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { api } from '../lib/api';
import { state, actions, isPlayingEpisode } from '../stores';
import { t } from '../lib/i18n';
import type { PodcastEpisode } from '../types/podcast';
import styles from './PodcastShow.module.css';
import { neutralCoverStyle } from '../lib/cover';
import { SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { navigateBackOr, registerPrimaryScroll } from '../lib/scrollHistory';
import { createResponsiveTap } from '../lib/responsiveTap';

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

export default function PodcastShow() {
  const params = useParams();
  const navigate = useNavigate();
  const sub = createMemo(() => state.podcastSubscriptions.find((s) => s.id === params.id) ?? null);
  const [data] = createResource(
    () => params.id,
    (id) => api.getPodcastEpisodes(id),
  );

  /** The subscription as the library knows it, or as the feed response reports
   * it while the library list is still syncing. */
  const show = () => sub() ?? data()?.subscription ?? null;
  const title = () => show()?.title ?? t('podcastShow.fallbackTitle');
  const image = () => show()?.image_url ?? null;

  const [onlyDownloaded, setOnlyDownloaded] = createSignal(false);
  const localByGuid = createMemo(
    () =>
      new Map(
        state.library
          .filter((t) => t.media_kind === 'podcast_episode' && t.podcast_episode_guid)
          .map((t) => [t.podcast_episode_guid as string, t] as const),
      ),
  );
  const isDownloaded = (ep: PodcastEpisode) => localByGuid().has(ep.guid);
  const episodes = createMemo<PodcastEpisode[]>(() => {
    const eps = data()?.episodes ?? [];
    return onlyDownloaded() ? eps.filter((e) => localByGuid().has(e.guid)) : eps;
  });

  /** Play the downloaded local copy when present, else stream via token. */
  const playEp = (ep: PodcastEpisode) => {
    const local = localByGuid().get(ep.guid);
    if (local) actions.playTrack(local);
    else void actions.playEpisode(ep, show()?.title, show()?.id, image());
  };

  const unsubscribe = async () => {
    const id = params.id;
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
        <Show when={sub()}>
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
      </div>

      <div
        ref={(element) => registerPrimaryScroll(element, () => !data.loading)}
        class={styles.scroll}
        data-primary-scroll
      >
        <Show
          when={!data.loading}
          fallback={<SkeletonRows count={8} compact />}
        >
          <For each={episodes()} fallback={<EmptyState>{t('podcastShow.empty')}</EmptyState>}>
            {(ep) => {
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
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}
