import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { registerNativeBack } from './backNavigation';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { podcastEpisodeToTrack } from '../lib/track';
import { MusicListRowView } from '../components/MusicListRowView';
import PodcastDirectory from './PodcastDirectory';
import { openContextMenu } from '../lib/contextMenu';
import { EmptyState } from '../components/EmptyState';
import type { PodcastEpisode, PodcastSubscription, PodcastShowInfo } from '../types/podcast';
import type { Track } from '../types/music';

/** Feed browsing imports no audio runtime; only the selected episode reaches native NORMAL. */
export default function PodcastBrowser(props: { generation: number; subscriptions: PodcastSubscription[]; acquired: Track[]; disconnected?: boolean; activeId?: string; onPlay(track: Track): Promise<void>; onChanged?(): Promise<void> }) {
  const [show, setShow] = createSignal<PodcastShowInfo | null>(null);
  const [followResult, setFollowResult] = createSignal<{ url: string; subscription: PodcastShowInfo | null } | null>(null);
  const followed = createMemo(() => followResult()?.url === show()?.rss_url ? followResult()?.subscription : props.subscriptions.find(row => row.rss_url === show()?.rss_url));
  createEffect(on(() => props.subscriptions, () => setFollowResult(null), { defer: true }));
  const selected = () => followed() ?? show();
  type EpisodeJob = { id: string; status: string; source_type?: string; enclosure_url?: string; song_str?: string; progress_percent?: number; error?: string };
  const [jobs, setJobs] = createSignal<EpisodeJob[]>([]);
  const [queueError, setQueueError] = createSignal(false);
  let queueEpoch = 0; let queueAbort: AbortController | undefined; let queueTimer: ReturnType<typeof setTimeout> | undefined;
  const observedComplete = new Set<string>();
  async function loadQueue() {
    if (props.disconnected || disposed) return;
    clearTimeout(queueTimer); queueAbort?.abort(); const controller = new AbortController(); queueAbort = controller;
    const job = ++queueEpoch; const generation = props.generation;
    try {
      const result = await request<{ queue?: EpisodeJob[] }>('/api/downloader/queue/status', { signal: controller.signal, timeoutMs: 15000, cache: 'no-store' });
      if (job !== queueEpoch || generation !== props.generation || controller.signal.aborted || disposed) return;
      const rows = (result.queue ?? []).filter(row => row.source_type === 'podcast_enclosure').slice(-500);
      const gone = jobs().some(previous => !rows.some(row => row.id === previous.id));
      setJobs(rows); setQueueError(false);
      const completed = rows.filter(row => row.status === 'completed' && !observedComplete.has(row.id));
      completed.forEach(row => observedComplete.add(row.id));
      if (completed.length || gone) await props.onChanged?.();
      if (job === queueEpoch && !disposed && rows.some(row => row.status === 'pending' || row.status === 'downloading')) queueTimer = setTimeout(() => void loadQueue(), 1000);
    } catch { if (job === queueEpoch && !controller.signal.aborted) { setQueueError(true); if (jobs().some(row => row.status === 'pending' || row.status === 'downloading')) queueTimer = setTimeout(() => void loadQueue(), 5000); } }
  }
  const episodeJob = (episode: PodcastEpisode) => jobs().find(row => (row.enclosure_url ?? row.song_str) === episode.enclosure_url && row.status !== 'completed');
  const [mutation, setMutation] = createSignal(false);
  let disposed = false; let actionEpoch = 0; let actionAbort: AbortController | undefined;
  const [episodes, setEpisodes] = createSignal<PodcastEpisode[]>([]);
  const [next, setNext] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(false);
  let epoch = 0; let controller = new AbortController();
  function reset() { queueEpoch++; queueAbort?.abort(); clearTimeout(queueTimer); setQueueError(false); setFollowResult(null); actionEpoch++; actionAbort?.abort(); setMutation(false); epoch++; controller.abort(); controller = new AbortController(); setEpisodes([]); setNext(null); setError(false); setBusy(false); }
  createEffect(() => { props.generation; reset(); setJobs([]); observedComplete.clear(); setShow(null); });
  createEffect(on(() => props.disconnected, disconnected => {
    if (disconnected) { queueEpoch++; queueAbort?.abort(); clearTimeout(queueTimer); }
    else if (show()) void loadQueue();
  }, { defer: true }));
  onCleanup(() => { disposed = true; queueEpoch++; queueAbort?.abort(); clearTimeout(queueTimer); actionEpoch++; actionAbort?.abort(); epoch++; controller.abort(); });
  async function load(selected: PodcastShowInfo, more = false, refresh = false) {
    controller.abort(); controller = new AbortController(); const signal = controller.signal;
    const job = ++epoch; const generation = props.generation;
    setBusy(true); setError(false);
    try {
      const page = await request<{ episodes?: PodcastEpisode[]; next?: number | null }>(more
        ? `/api/podcasts/episodes-by-url?rss_url=${encodeURIComponent(selected.rss_url)}&after=${next() ?? 0}`
        : selected.id ? `/api/podcasts/feeds/${encodeURIComponent(selected.id)}/episodes${refresh ? '?refresh=1' : ''}`
        : `/api/podcasts/episodes-by-url?rss_url=${encodeURIComponent(selected.rss_url)}`, { signal, timeoutMs: 20000 });
      if (job !== epoch || generation !== props.generation) return;
      const rows = new Map((more ? episodes() : []).map(row => [row.enclosure_url, row]));
      for (const row of page.episodes ?? []) if (row.enclosure_url) rows.set(row.enclosure_url, row);
      setEpisodes([...rows.values()]); setNext(typeof page.next === 'number' && page.next > (more ? next() ?? 0 : 0) ? page.next : null);
    } catch { if (job === epoch && generation === props.generation && !signal.aborted) setError(true); }
    finally { if (job === epoch && generation === props.generation) setBusy(false); }
  }
  function open(selected: PodcastShowInfo) { reset(); setShow(selected); void load(selected); void loadQueue(); }
  function track(episode: PodcastEpisode): Track {
    const acquired = props.acquired.find(row => row.podcast_enclosure_url === episode.enclosure_url
      || (!!episode.guid && row.podcast_episode_guid === episode.guid && ((!!selected()?.id && row.podcast_feed_id === selected()?.id) || (!!selected()?.rss_url && row.podcast_rss_url === selected()?.rss_url))));
    // Acquired engine tracks retain feed/GUID, not the enclosure. Join using
    // that provenance and enrich only this playback descriptor from the RSS.
    return acquired ? { ...acquired, podcast_enclosure_url: episode.enclosure_url }
      : podcastEpisodeToTrack(episode, show()?.title ?? t('podcastShow.fallbackTitle'), selected()?.id, selected()?.image_url ?? undefined);
  }
  async function follow(remove = false) {
    const item = selected(); if (!item || props.disconnected || mutation()) return;
    const job = ++actionEpoch; const generation = props.generation; const controller = new AbortController(); actionAbort = controller;
    setMutation(true); setError(false);
    try {
      const answer = await request<{ subscription?: PodcastSubscription }>(remove ? `/api/podcasts/subscriptions/${encodeURIComponent(item.id ?? '')}` : '/api/podcasts/subscribe', { method: remove ? 'DELETE' : 'POST', body: remove ? undefined : { rss_url: item.rss_url, title: item.title, author: item.author, image_url: item.image_url, itunes_collection_id: item.itunes_collection_id }, signal: controller.signal, timeoutMs: 30000 });
      if (disposed || generation !== props.generation || controller.signal.aborted) return;
      if (!remove && !answer.subscription) throw new Error('Invalid subscription confirmation');
      await props.onChanged?.();
      if (job !== actionEpoch || generation !== props.generation || disposed || show()?.rss_url !== item.rss_url) return;
      setFollowResult({ url: item.rss_url, subscription: remove ? null : answer.subscription! });
      setShow(remove ? { ...item, id: undefined } : answer.subscription ?? item);
    } catch { if (job === actionEpoch && generation === props.generation && !controller.signal.aborted) setError(true); }
    finally { if (job === actionEpoch && generation === props.generation) setMutation(false); }
  }
  /** Subscribing from the directory, without opening the show; confirmed by the engine before the list changes. */
  async function subscribe(item: PodcastShowInfo) {
    const generation = props.generation;
    if (props.disconnected || disposed) throw new Error('Unavailable');
    const answer = await request<{ subscription?: PodcastSubscription }>('/api/podcasts/subscribe', { method: 'POST', timeoutMs: 20000,
      body: { rss_url: item.rss_url, title: item.title, author: item.author, image_url: item.image_url, itunes_collection_id: item.itunes_collection_id } });
    if (disposed || generation !== props.generation) return;
    if (!answer.subscription) throw new Error('Invalid subscription confirmation');
    await props.onChanged?.();
  }
  const [downloadedOnly, setDownloadedOnly] = createSignal(false);
  const shownEpisodes = () => downloadedOnly() ? episodes().filter(episode => track(episode).source !== 'preview') : episodes();
  async function acquire(episode: PodcastEpisode, action: 'enqueue' | 'retry' | 'remove' = 'enqueue', existing?: EpisodeJob) {
    const item = selected(); if (!item || props.disconnected || mutation()) return;
    const job = ++actionEpoch; const generation = props.generation; const controller = new AbortController(); actionAbort = controller;
    setMutation(true); setError(false);
    try {
      const accepted = await request<{ ids?: string[] }>(action === 'enqueue' ? '/api/downloader/queue' : `/api/downloader/queue/${encodeURIComponent(existing?.id ?? '')}${action === 'retry' ? '/retry' : ''}`, { method: action === 'remove' ? 'DELETE' : 'POST', body: action === 'enqueue' ? { items: [{ source_type: 'podcast_enclosure', enclosure_url: episode.enclosure_url, guid: episode.guid, title: episode.title, show_title: item.title, duration_sec: episode.duration_sec, podcast_feed_id: item.id, podcast_rss_url: item.rss_url }] } : undefined, signal: controller.signal, timeoutMs: 15000 });
      if (action === 'enqueue' && (!Array.isArray(accepted.ids) || !accepted.ids.length)) throw new Error('Episode was not queued');
      if (job === actionEpoch && generation === props.generation && !disposed && !controller.signal.aborted) {
        if (action === 'enqueue') setJobs(rows => [...rows, ...accepted.ids!.map(id => ({ id, status: 'pending', source_type: 'podcast_enclosure', enclosure_url: episode.enclosure_url }))]);
        else if (action === 'retry' && existing) setJobs(rows => rows.map(row => row.id === existing.id ? { ...row, status: 'pending' } : row));
      }
      if (job === actionEpoch && generation === props.generation && !disposed && !controller.signal.aborted) await loadQueue();
    } catch { if (job === actionEpoch && generation === props.generation && !controller.signal.aborted) setError(true); }
    finally { if (job === actionEpoch && generation === props.generation) setMutation(false); }
  }
  function episodeMenu(episode: PodcastEpisode, event?: MouseEvent) {
    const generation = props.generation; const url = selected()?.rss_url; const existing = episodeJob(episode);
    const current = () => !disposed && generation === props.generation && url === selected()?.rss_url && !props.disconnected;
    const disabled = props.disconnected || mutation();
    const acquired = track(episode).source !== 'preview';
    openContextMenu({ title: episode.title, actions: [
      { label: t('common.play'), disabled, onSelect: () => { if (current()) void props.onPlay(track(episode)).catch(() => { if (current()) setError(true); }); } },
      ...(!acquired && !existing ? [{ label: t('podcastShow.ariaDownload'), disabled, onSelect: () => { if (current() && !episodeJob(episode)) void acquire(episode); } }] : []),
      ...(existing && ['failed', 'interrupted'].includes(existing.status) ? [{ label: t('common.retry'), disabled, onSelect: () => { if (current() && episodeJob(episode)?.id === existing.id) void acquire(episode, 'retry', existing); } }] : []),
      ...(existing ? [{ label: t('common.cancel'), disabled, onSelect: () => { if (current() && episodeJob(episode)?.id === existing.id) void acquire(episode, 'remove', existing); } }] : []),
    ] }, event);
  }
  function showMenu(event?: MouseEvent) {
    const item = selected(); if (!item) return;
    const generation = props.generation; const url = item.rss_url; const remove = Boolean(followed()); const id = followed()?.id;
    openContextMenu({ title: item.title, actions: [{ label: t(remove ? 'podcastShow.unsubscribe' : 'podcasts.subscribe'), disabled: mutation() || props.disconnected, onSelect: () => { if (generation === props.generation && show()?.rss_url === url && !disposed && (remove ? followed()?.id === id : !followed())) void follow(remove); } }] }, event);
  }
  const closeShow = () => { reset(); setDownloadedOnly(false); setShow(null); };
  registerNativeBack(() => { if (!selected()) return false; closeShow(); return true; });
  return <section data-testid="android-podcasts">
    <Show when={selected()} fallback={<><PodcastDirectory generation={props.generation} disconnected={props.disconnected} onOpen={open} subscribed={feed => props.subscriptions.some(row => row.rss_url === feed)} onSubscribe={subscribe} /><h2>{t('podcasts.yourShows')}</h2><For each={props.subscriptions} fallback={<EmptyState>{t('podcasts.hint')}</EmptyState>}>{item => <MusicListRowView title={item.title} subtitle={item.author ?? ''} seed={item.id} disabled={props.disconnected} onActivate={() => open(item)} />}</For></>}>
      {selected => <><button onClick={closeShow}>{t('common.back')}</button><h2>{selected().title}</h2><button data-podcast-show-menu aria-label={t('songRow.ariaMore')} disabled={mutation()} onClick={showMenu}>⋯</button>
        <button disabled={busy() || props.disconnected} onClick={() => void load(selected(), false, true)}>{t('podcastShow.refresh')}</button>
        <button data-podcast-downloaded-only aria-pressed={downloadedOnly()} onClick={() => setDownloadedOnly(value => !value)}>{t('podcastShow.downloadedOnly')}</button>
        <Show when={error()}><p role="alert">{t('common.loadFailed')}</p><button disabled={busy() || props.disconnected} onClick={() => void load(selected())}>{t('common.retry')}</button></Show>
        <Show when={queueError()}><p role="status">{t('common.loadFailed')} <button onClick={() => void loadQueue()}>{t('common.retry')}</button></p></Show>
        <Show when={busy()}><p role="status">{t('common.loading')}</p></Show>
        <For each={shownEpisodes()} fallback={<Show when={!busy() && !error()}><EmptyState>{t('podcastShow.empty')}</EmptyState></Show>}>{episode => <MusicListRowView title={episode.title} subtitle={episode.published ?? ''} seed={episode.guid || episode.enclosure_url}
          annotation={track(episode).source !== 'preview' ? t('podcastShow.ariaDownloaded') : episodeJob(episode)?.status === 'failed' || episodeJob(episode)?.status === 'interrupted' ? t('common.loadFailed') : episodeJob(episode) ? t('collection.downloading') : undefined} downloading={episodeJob(episode)?.status === 'pending' || episodeJob(episode)?.status === 'downloading'} busy={mutation()} onMenu={event => episodeMenu(episode, event)} active={props.activeId === track(episode).id} disabled={props.disconnected} onActivate={() => void props.onPlay(track(episode)).catch(() => setError(true))} />}</For>
        <Show when={next() !== null}><button disabled={busy() || props.disconnected} onClick={() => void load(selected(), true)}>{t('podcastShow.loadMore')}</button></Show>
      </>}
    </Show>
  </section>;
}
