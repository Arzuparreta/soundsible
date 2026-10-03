import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { podcastEpisodeToTrack } from '../lib/track';
import { MusicListRowView } from '../components/MusicListRowView';
import { EmptyState } from '../components/EmptyState';
import type { PodcastEpisode, PodcastSubscription } from '../types/podcast';
import type { Track } from '../types/music';

/** Feed browsing imports no audio runtime; only the selected episode reaches native NORMAL. */
export default function PodcastBrowser(props: { generation: number; subscriptions: PodcastSubscription[]; acquired: Track[]; disconnected?: boolean; activeId?: string; onPlay(track: Track): Promise<void> }) {
  const [show, setShow] = createSignal<PodcastSubscription | null>(null);
  const [episodes, setEpisodes] = createSignal<PodcastEpisode[]>([]);
  const [next, setNext] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(false);
  let epoch = 0; let controller = new AbortController();
  function reset() { epoch++; controller.abort(); controller = new AbortController(); setEpisodes([]); setNext(null); setError(false); setBusy(false); }
  createEffect(() => { props.generation; reset(); setShow(null); });
  onCleanup(() => { epoch++; controller.abort(); });
  async function load(selected: PodcastSubscription, more = false, refresh = false) {
    controller.abort(); controller = new AbortController(); const signal = controller.signal;
    const job = ++epoch; const generation = props.generation;
    setBusy(true); setError(false);
    try {
      const page = await request<{ episodes?: PodcastEpisode[]; next?: number | null }>(more
        ? `/api/podcasts/episodes-by-url?rss_url=${encodeURIComponent(selected.rss_url)}&after=${next() ?? 0}`
        : `/api/podcasts/feeds/${encodeURIComponent(selected.id)}/episodes${refresh ? '?refresh=1' : ''}`, { signal, timeoutMs: 20000 });
      if (job !== epoch || generation !== props.generation) return;
      const rows = new Map((more ? episodes() : []).map(row => [row.enclosure_url, row]));
      for (const row of page.episodes ?? []) if (row.enclosure_url) rows.set(row.enclosure_url, row);
      setEpisodes([...rows.values()]); setNext(typeof page.next === 'number' && page.next > (more ? next() ?? 0 : 0) ? page.next : null);
    } catch { if (job === epoch && generation === props.generation && !signal.aborted) setError(true); }
    finally { if (job === epoch && generation === props.generation) setBusy(false); }
  }
  function open(selected: PodcastSubscription) { reset(); setShow(selected); void load(selected); }
  function track(episode: PodcastEpisode): Track {
    const acquired = props.acquired.find(row => row.podcast_enclosure_url === episode.enclosure_url
      || (!!episode.guid && row.podcast_episode_guid === episode.guid && row.podcast_feed_id === show()?.id));
    // Acquired engine tracks retain feed/GUID, not the enclosure. Join using
    // that provenance and enrich only this playback descriptor from the RSS.
    return acquired ? { ...acquired, podcast_enclosure_url: episode.enclosure_url }
      : podcastEpisodeToTrack(episode, show()?.title ?? t('podcastShow.fallbackTitle'), show()?.id, show()?.image_url ?? undefined);
  }
  return <section data-testid="android-podcasts">
    <Show when={show()} fallback={<><h2>{t('podcasts.yourShows')}</h2><For each={props.subscriptions} fallback={<EmptyState>{t('podcasts.hint')}</EmptyState>}>{item => <MusicListRowView title={item.title} subtitle={item.author ?? ''} seed={item.id} disabled={props.disconnected} onActivate={() => open(item)} />}</For></>}>
      {selected => <><button onClick={() => { reset(); setShow(null); }}>{t('common.back')}</button><h2>{selected().title}</h2>
        <button disabled={busy() || props.disconnected} onClick={() => void load(selected(), false, true)}>{t('podcastShow.refresh')}</button>
        <Show when={error()}><p role="alert">{t('common.loadFailed')}</p><button disabled={busy() || props.disconnected} onClick={() => void load(selected())}>{t('common.retry')}</button></Show>
        <Show when={busy()}><p role="status">{t('common.loading')}</p></Show>
        <For each={episodes()} fallback={<Show when={!busy() && !error()}><EmptyState>{t('podcastShow.empty')}</EmptyState></Show>}>{episode => <MusicListRowView title={episode.title} subtitle={episode.published ?? ''} seed={episode.guid || episode.enclosure_url}
          annotation={track(episode).source === 'preview' ? undefined : t('podcastShow.ariaDownloaded')} active={props.activeId === track(episode).id} disabled={props.disconnected} onActivate={() => void props.onPlay(track(episode)).catch(() => setError(true))} />}</For>
        <Show when={next() !== null}><button disabled={busy() || props.disconnected} onClick={() => void load(selected(), true)}>{t('podcastShow.loadMore')}</button></Show>
      </>}
    </Show>
  </section>;
}
