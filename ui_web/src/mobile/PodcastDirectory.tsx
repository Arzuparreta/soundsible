import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { SearchField } from '../components/SearchField';
import { MusicListRowView } from '../components/MusicListRowView';
import { EmptyState } from '../components/EmptyState';
import type { PodcastSearchResult, PodcastShowInfo } from '../types/podcast';

export default function PodcastDirectory(props: { generation: number; disconnected?: boolean; onOpen(show: PodcastShowInfo): void }) {
  const [query, setQuery] = createSignal('');
  const [rows, setRows] = createSignal<PodcastSearchResult[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  let epoch = 0;
  createEffect(on(() => [query().trim(), props.generation, props.disconnected, retry()] as const, ([term, generation, disconnected]) => {
    const job = ++epoch; const controller = new AbortController();
    setRows([]); setError(false); setBusy(Boolean(term && !disconnected));
    const timer = term && !disconnected ? setTimeout(() => {
      void request<{ results?: PodcastSearchResult[] }>(`/api/discovery/podcasts/search?q=${encodeURIComponent(term.slice(0, 500))}&limit=25`, { signal: controller.signal, timeoutMs: 20000 }).then(result => {
        if (job !== epoch || generation !== props.generation || controller.signal.aborted) return;
        setRows((result.results ?? []).filter(row => row.feed_url));
      }).catch(() => { if (job === epoch && !controller.signal.aborted) setError(true); })
        .finally(() => { if (job === epoch) setBusy(false); });
    }, 300) : undefined;
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  }));
  onCleanup(() => { epoch++; });
  return <section data-testid="android-podcast-directory">
    <SearchField value={query()} placeholder={t('podcasts.searchPlaceholder')} onInput={setQuery} />
    <Show when={busy()}><p role="status">{t('common.loading')}</p></Show>
    <Show when={error()}><p role="alert">{t('common.loadFailed')}</p><button disabled={busy() || props.disconnected} onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button></Show>
    <Show when={query().trim() && !busy() && !error()}><For each={rows()} fallback={<EmptyState>{t('podcasts.noResults')}</EmptyState>}>{row => <MusicListRowView title={row.title} subtitle={row.author} seed={row.feed_url} disabled={props.disconnected} onActivate={() => props.onOpen({ title: row.title, author: row.author, rss_url: row.feed_url, image_url: row.image_url, itunes_collection_id: row.itunes_collection_id })} />}</For></Show>
  </section>;
}
