import type { MenuEvent } from '../lib/menuEvent';
import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { SearchField } from '../components/SearchField';
import { PageToolbar } from '../components/PageToolbar';
import Button from '../components/Button';
import { MusicListRowView } from '../components/MusicListRowView';
import { EmptyState } from '../components/EmptyState';
import type { PodcastSearchResult, PodcastShowInfo, PodcastSubscription } from '../types/podcast';
import { podcastRecommendations, type RawPodcastRow } from '../lib/podcastRecommendations';
import { openContextMenu } from '../lib/contextMenu';
import { toast } from '../lib/toast';
import { nativeFeedbackActions, podcastFeedback } from './songActions';
import { createPodcastCountry } from '../lib/podcastCountry';
import { PodcastCountryPicker } from '../components/PodcastCountryPicker';
import PodcastCharts from './PodcastCharts';
import type { PodcastEpisode, PopularPodcastEpisode } from '../types/podcast';
import { ROW_ARTWORK, podcastArtwork } from '../lib/podcastArtwork';
import { createPodcastSearch, podcastShowInfo } from '../lib/podcastSearch';

export default function PodcastDirectory(props: { generation: number; disconnected?: boolean; activeId?: string; onOpen(show: PodcastShowInfo): void;
  subscriptions?: PodcastSubscription[]; children?: JSX.Element;
  onSubscribe?: (show: PodcastShowInfo) => Promise<void>;
  onPlay?: (episode: PodcastEpisode, row: PopularPodcastEpisode) => Promise<void> }) {
  const country = createPodcastCountry(() => String(props.generation));
  const [countryError, setCountryError] = createSignal(false), [countryRetry, setCountryRetry] = createSignal(0);
  createEffect(on(() => [props.generation, props.disconnected, countryRetry()] as const, () => {
    let current = true;
    country.resetPodcastCountry(); setCountryError(false);
    if (!props.disconnected) void country.loadPodcastCountry().catch(() => { if (current && !props.disconnected) setCountryError(true); });
    onCleanup(() => { current = false; country.resetPodcastCountry(); });
  }));
  const [top, setTop] = createSignal<PodcastSearchResult[]>([]);
  const [subscribing, setSubscribing] = createSignal<string | null>(null);
  // Recommended shows for this account; refreshed per account and connection, never across them.
  createEffect(on(() => [props.generation, props.disconnected, country.podcastCountry()] as const, ([generation, disconnected]) => {
    setTop([]);
    if (disconnected) return;
    const controller = new AbortController();
    void request<{ items?: RawPodcastRow[] }>('/api/discovery/podcasts/recommendations?limit=20', { signal: controller.signal, timeoutMs: 20000 })
      .then(result => { if (generation === props.generation && !controller.signal.aborted) setTop(podcastRecommendations(result.items)); }).catch(() => {});
    onCleanup(() => controller.abort());
  }));
  const subscribed = (feed: string) => props.subscriptions?.some(row => row.rss_url === feed);
  const recommended = () => top().filter(row => !subscribed(row.feed_url));
  function topMenu(row: PodcastSearchResult, event?: MenuEvent) {
    const generation = props.generation;
    const current = () => generation === props.generation && !props.disconnected;
    openContextMenu({ title: row.title, subtitle: row.author, actions: [
      ...(props.onSubscribe ? [{ label: t('podcasts.subscribe'), disabled: !current() || !!subscribing() || !!subscribed(row.feed_url), onSelect: () => {
        if (!current() || subscribing()) return;
        setSubscribing(row.feed_url);
        void props.onSubscribe!(podcastShowInfo(row)).catch(() => { if (current()) toast.error(t('podcasts.subscribeFailed')); }).finally(() => setSubscribing(null));
      } }] : []),
      ...nativeFeedbackActions(podcastFeedback(row), current),
    ] }, event);
  }
  const [query, setQuery] = createSignal('');
  const search = createPodcastSearch({
    query, subscriptions: () => props.subscriptions ?? [], country: country.podcastCountry,
    account: () => props.generation, disconnected: () => props.disconnected,
  });
  return <section data-testid="android-podcast-directory">
    <h2>{t('nav.podcasts')}</h2>
    <PageToolbar contained field={<SearchField value={query()} placeholder={t('podcasts.searchPlaceholder')} onInput={setQuery} />}
      actions={<PodcastCountryPicker state={country} disabled={props.disconnected} />} />
    <Show when={countryError()}><p role="alert">{t('common.loadFailed')} <button disabled={props.disconnected} onClick={() => setCountryRetry(n => n + 1)}>{t('common.retry')}</button></p></Show>
    <Show when={!search.active()}>{props.children}</Show>
    <PodcastCharts country={country} generation={props.generation} activeId={props.activeId} disconnected={props.disconnected} hidden={search.active()} onOpen={row => props.onOpen(podcastShowInfo(row))} onPlay={(episode, row) => props.onPlay?.(episode, row) ?? Promise.reject(new Error('Playback unavailable'))} />
    <Show when={search.pending()}><p role="status">{t('common.loading')}</p></Show>
    <Show when={search.error()}>
      <EmptyState compact tone="danger">{t('search.catalogErrorHint')} <Button variant="secondary" onClick={search.retry}>{t('common.retry')}</Button></EmptyState>
    </Show>
    <Show when={search.active() && !search.pending() && !search.error() && !search.results().length && !props.disconnected}>
      <EmptyState>{t('podcasts.noResults')}</EmptyState>
    </Show>
    <For each={search.results()}>{({ show, subscription }) => <MusicListRowView
      title={show.title} subtitle={show.author} seed={show.feed_url} cover={podcastArtwork(show.image_url, ROW_ARTWORK)}
      annotation={subscription ? t('podcasts.subscribed') : undefined} keepAnnotationVisible disabled={props.disconnected}
      onActivate={() => props.onOpen(subscription ?? podcastShowInfo(show))} />}</For>
    <Show when={!search.active() && recommended().length}><section data-podcast-top aria-label={t('podcasts.top')}><h2>{t('podcasts.top')}</h2>
      <For each={recommended()}>{row => <MusicListRowView title={row.title} subtitle={row.author} seed={row.feed_url} cover={podcastArtwork(row.image_url, ROW_ARTWORK)} disabled={props.disconnected}
        busy={subscribing() === row.feed_url} onActivate={() => props.onOpen(podcastShowInfo(row))} onMenu={event => topMenu(row, event)} />}</For>
    </section></Show>
  </section>;
}
