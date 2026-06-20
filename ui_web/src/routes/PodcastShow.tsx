import { createMemo, createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { api } from '../lib/api';
import { state, actions } from '../stores';
import type { PodcastEpisode } from '../types/podcast';
import styles from './PodcastShow.module.css';

function fmtDur(s?: number): string {
  if (s == null || !Number.isFinite(s) || s <= 0) return '';
  const m = Math.round(s / 60);
  return `${m} min`;
}

function fmtDate(s?: string): string {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

function coverBg(url?: string | null): JSX.CSSProperties {
  const grad = 'linear-gradient(135deg, var(--bg-elevated), var(--bg-inset))';
  return url ? { background: `url("${url}") center / cover no-repeat, ${grad}` } : { background: grad };
}

export default function PodcastShow() {
  const params = useParams();
  const navigate = useNavigate();
  const sub = createMemo(() => state.podcastSubscriptions.find((s) => s.id === params.id) ?? null);
  const [data] = createResource(
    () => params.id,
    (id) => api.getPodcastEpisodes(id),
  );

  const title = () => sub()?.title ?? data()?.subscription?.title ?? 'Podcast';
  const image = () => sub()?.image_url ?? data()?.subscription?.image_url ?? null;

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
    else void actions.playEpisode(ep, sub()?.title);
  };

  const unsubscribe = async () => {
    const id = params.id;
    if (!id) return;
    await api.unsubscribePodcast(id).catch(() => {});
    await actions.syncLibrary();
    navigate('/podcasts');
  };

  return (
    <div class="view">
      <header class={styles.header}>
        <button class={styles.back} type="button" aria-label="Volver" onClick={() => navigate('/podcasts')}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div class={styles.cover} style={coverBg(image())} />
        <div class={styles.info}>
          <h1 class={styles.title}>{title()}</h1>
          <span class={styles.author}>{sub()?.author ?? data()?.subscription?.author}</span>
        </div>
        <Show when={sub()}>
          <button class={styles.unsub} type="button" onClick={unsubscribe}>
            Dejar de seguir
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
          Solo descargados
        </button>
      </div>

      <div class={styles.scroll}>
        <Show
          when={!data.loading}
          fallback={<For each={Array.from({ length: 8 })}>{() => <div class={styles.skeleton} />}</For>}
        >
          <For each={episodes()} fallback={<p class={styles.hint}>Sin episodios.</p>}>
            {(ep) => {
              const id = ep.guid || ep.enclosure_url;
              const downloaded = () => isDownloaded(ep);
              return (
                <div class={styles.ep} onClick={() => playEp(ep)}>
                  <button
                    class={styles.epPlay}
                    type="button"
                    aria-label="Reproducir episodio"
                    onClick={(e) => {
                      e.stopPropagation();
                      playEp(ep);
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <path fill="currentColor" d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                  <div class={styles.epMeta}>
                    <span
                      class={styles.epTitle}
                      classList={{ [styles.active]: state.playback.currentTrack?.id === id }}
                    >
                      {ep.title}
                    </span>
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
                        aria-label="Descargar episodio"
                        onClick={(e) => {
                          e.stopPropagation();
                          void actions.downloadEpisode(ep, sub());
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M12 3v12M7 11l5 5 5-5M5 21h14" />
                        </svg>
                      </button>
                    }
                  >
                    <span class={styles.epDownloaded} aria-label="Descargado">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5">
                        <path d="M5 12l5 5L20 7" />
                      </svg>
                    </span>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}
