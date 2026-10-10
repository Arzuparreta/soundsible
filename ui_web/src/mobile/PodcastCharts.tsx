import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { countryName, type PodcastCountryState } from '../lib/podcastCountry';
import { MusicListRowView } from '../components/MusicListRowView';
import { toast } from '../lib/toast';
import type { PodcastEpisode, PodcastSearchResult, PopularPodcastEpisode } from '../types/podcast';

/** HTTP discovery only; playback is handed to the native podcast controller. */
export default function PodcastCharts(props: { country: PodcastCountryState; generation: number; disconnected?: boolean; hidden?: boolean; activeId?: string;
  onOpen(row: PodcastSearchResult): void; onPlay(episode: PodcastEpisode, row: PopularPodcastEpisode): Promise<void> }) {
  const [shows, setShows] = createSignal<PodcastSearchResult[]>([]), [episodes, setEpisodes] = createSignal<PopularPodcastEpisode[]>([]);
  const [showError, setShowError] = createSignal(false), [episodeError, setEpisodeError] = createSignal(false);
  const [genre, setGenre] = createSignal(''), [retry, setRetry] = createSignal(0), [playing, setPlaying] = createSignal('');
  let playAbort: AbortController | undefined, disposed = false;
  createEffect(on(() => [props.country.podcastCountry(), props.generation, props.disconnected, retry()] as const, ([country, generation, disconnected]) => {
    const controller = new AbortController();
    playAbort?.abort(); setPlaying(''); setShows([]); setEpisodes([]); setGenre(''); setShowError(false); setEpisodeError(false);
    const current = () => !controller.signal.aborted && generation === props.generation && country === props.country.podcastCountry() && !props.disconnected;
    if (country && !disconnected) {
      void request<{ results: PodcastSearchResult[] }>(`/api/discovery/podcasts/top?country=${country}&limit=20`, { signal: controller.signal, timeoutMs: 25000 })
        .then(result => { if (current()) setShows(result.results); }).catch(() => { if (current()) setShowError(true); });
      void request<{ results: PopularPodcastEpisode[] }>(`/api/discovery/podcasts/top-episodes?country=${country}&limit=20`, { signal: controller.signal, timeoutMs: 25000 })
        .then(result => { if (current()) setEpisodes(result.results); }).catch(() => { if (current()) setEpisodeError(true); });
    }
    onCleanup(() => controller.abort());
  }));
  onCleanup(() => { disposed = true; playAbort?.abort(); });
  const genres = createMemo(() => [...new Map([...shows(), ...episodes()].flatMap(row => row.genres ?? []).map(g => [g.id, g])).values()]);
  const matches = (row: PodcastSearchResult) => !genre() || row.genres?.some(g => g.id === genre());
  const label = () => countryName(props.country.podcastCountry() ?? 'us');
  async function play(row: PopularPodcastEpisode) {
    if (playing() || props.disconnected) return;
    const generation = props.generation, country = props.country.podcastCountry(), previousTrack = props.activeId;
    const controller = new AbortController(); playAbort = controller; setPlaying(row.episode_id);
    const current = () => !disposed && !controller.signal.aborted && !props.disconnected && generation === props.generation && country === props.country.podcastCountry() && previousTrack === props.activeId;
    try {
      const data = await request<{ episode: PodcastEpisode; show_title: string; feed_url: string }>(
        `/api/discovery/podcasts/episode?show_id=${row.itunes_collection_id}&episode_id=${row.episode_id}&country=${country}`, { signal: controller.signal, timeoutMs: 25000 });
      if (current()) await props.onPlay(data.episode, { ...row, title: data.show_title, feed_url: data.feed_url });
    } catch { if (current()) toast.error(t('podcasts.episodeUnavailable')); }
    finally { if (playAbort === controller) setPlaying(''); }
  }
  return <Show when={!props.hidden && !props.disconnected}>
    <Show when={genres().length}><label>{t('podcasts.category')} <select aria-label={t('podcasts.category')} value={genre()} onChange={e => setGenre(e.currentTarget.value)}>
      <option value="">{t('podcasts.allCategories')}</option><For each={genres()}>{g => <option value={g.id}>{g.name}</option>}</For>
    </select></label></Show>
    <Show when={shows().filter(matches).length}><h2>{t('podcasts.topCountry', { country: label() })}</h2>
      <For each={shows().filter(matches)}>{row => <MusicListRowView title={row.title} subtitle={row.author} seed={row.feed_url} cover={row.image_url} onActivate={() => props.onOpen(row)} />}</For>
    </Show>
    <Show when={showError()}><p role="alert">{t('podcasts.chartFailed')} <button onClick={() => setRetry(n => n + 1)}>{t('common.retry')}</button></p></Show>
    <Show when={episodes().filter(matches).length}><h2>{t('podcasts.topEpisodes', { country: label() })}</h2>
      <For each={episodes().filter(matches)}>{row => <MusicListRowView title={row.title} subtitle={row.author} seed={row.episode_id} cover={row.image_url} busy={playing() === row.episode_id} disabled={!!playing()} onActivate={() => void play(row)} />}</For>
    </Show>
    <Show when={episodeError()}><p role="alert">{t('podcasts.episodesFailed')} <button onClick={() => setRetry(n => n + 1)}>{t('common.retry')}</button></p></Show>
    <Show when={genre() && !shows().some(matches) && !episodes().some(matches)}><p>{t('podcasts.noCategoryResults')}</p></Show>
  </Show>;
}
