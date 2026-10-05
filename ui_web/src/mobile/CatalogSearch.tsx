import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { api, ApiError } from '../lib/api';
import { itemArtist } from '../lib/catalogTrack';
import { createNativeCatalogActions } from './catalogActions';
import { openContextMenu } from '../lib/contextMenu';
import { t } from '../lib/i18n';
import { coverUrl } from '../lib/media';
import { SearchField } from '../components/SearchField';
import { MusicListRowView } from '../components/MusicListRowView';
import { EmptyState } from '../components/EmptyState';
import type { CatalogItem, SavedEntry, Track } from '../types/music';
import type { createSearchHistoryStorage } from '../lib/searchHistoryStorage';
import styles from './AndroidStart.module.css';

/** Account-scoped catalog UI; resolution never imports the web audio runtime. */
export default function CatalogSearch(props: {
  generation: number; tracks: Track[]; saved: SavedEntry[]; disconnected: boolean; history?: ReturnType<typeof createSearchHistoryStorage>;
  activeId?: string; isActive?: (track: Track) => boolean; onAcquire?: (track: Track) => Promise<void>; onPlay: (track: Track) => Promise<void>; onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = createSignal('');
  const [rows, setRows] = createSignal<CatalogItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [partial, setPartial] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  const catalog = createNativeCatalogActions({ generation: () => props.generation, tracks: () => props.tracks,
    saved: () => props.saved, disconnected: () => props.disconnected, onPlay: props.onPlay,
    onAcquire: props.onAcquire, onChanged: props.onChanged });
  const { pending, trackFor, isSaved, act } = catalog;
  let searchEpoch = 0;
  let disposed = false;
  let account = props.generation;
  createEffect(on(() => [query().trim(), props.generation, props.disconnected, retry()] as const, ([term, generation, disconnected]) => {
    const epoch = ++searchEpoch;
    catalog.reset(account !== generation); account = generation;
    const controller = new AbortController();
    setRows([]); setError(''); setPartial(false); setLoading(Boolean(term && !disconnected));
    const timer = term && !disconnected ? setTimeout(() => {
      void api.searchCatalog(term, controller.signal, 'track,library_track').then(result => {
        if (epoch !== searchEpoch || generation !== props.generation || controller.signal.aborted) return;
        props.history?.remember('music', term);
        setRows(result.items.filter(item => item.type === 'track' || item.type === 'library_track'));
        setPartial(Boolean(result.partial_failures?.length));
      }).catch(failure => {
        if (epoch === searchEpoch && !controller.signal.aborted) setError(t(failure instanceof ApiError && failure.status === 403 ? 'android.permissionDenied' : 'common.loadFailed'));
      }).finally(() => { if (epoch === searchEpoch) setLoading(false); });
    }, 300) : undefined;
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  }));
  onCleanup(() => { disposed = true; searchEpoch++; });
  function menu(item: CatalogItem, event?: MouseEvent) {
    const generation = props.generation;
    const search = searchEpoch;
    const saved = isSaved(item);
    const run = (purpose: 'play' | 'save' | 'remove' | 'acquire') => { if (generation === props.generation && search === searchEpoch && !disposed) void act(item, purpose); };
    openContextMenu({ title: item.title, actions: [
      { label: t('common.play'), disabled: props.disconnected || pending() === item.id, onSelect: () => run('play') },
      { label: t(saved ? 'collection.unsave' : 'collection.save'), selected: saved, disabled: props.disconnected || pending() === item.id, onSelect: () => run(saved ? 'remove' : 'save') },
      ...(props.onAcquire && (!trackFor(item) || trackFor(item)?.source === 'preview') ? [{ label: t('collectionControl.download'), disabled: props.disconnected || pending() === item.id, onSelect: () => run('acquire') }] : []),
    ] }, event);
  }
  return <section class={styles.library} data-testid="android-catalog-search">
    <SearchField value={query()} placeholder={t('search.placeholder')} onInput={setQuery} />
    <Show when={!query().trim() && props.history?.load('music').length}>
      <section aria-label={t('search.recentsSection')}>
        <h2>{t('search.recentsSection')}</h2>
        <For each={props.history?.load('music') ?? []}>{term => <div>
          <button disabled={props.disconnected} onClick={() => setQuery(term)}>{term}</button>
          <button aria-label={t('search.removeRecent', { query: term })} onClick={() => props.history?.forget('music', term)}>×</button>
        </div>}</For>
      </section>
    </Show>
    <Show when={props.disconnected}><p role="status">{t('library.unreachable')}</p></Show>
    <Show when={error() || catalog.error()}><p role="alert">{error() || catalog.error()} <button onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button></p></Show>
    <Show when={loading()}><p role="status">{t('common.loading')}</p></Show>
    <Show when={partial()}><p role="status">{t('musicExplorer.partial')}</p></Show>
    <Show when={!loading() && query().trim() && !props.disconnected}>
      <For each={rows()} fallback={<EmptyState>{t('search.catalogNoResults')}</EmptyState>}>{item => {
        const track = () => trackFor(item);
        return <MusicListRowView playback title={item.title} subtitle={itemArtist(item)} seed={item.id}
          cover={track()?.source !== 'preview' && track() ? coverUrl(track()!.id, 'thumb') : undefined}
          active={Boolean(track() && (props.isActive ? props.isActive(track()!) : props.activeId === track()!.id))} busy={pending() === item.id}
          disabled={props.disconnected} onActivate={() => void act(item, 'play')} onMenu={event => menu(item, event)} />;
      }}</For>
    </Show>
  </section>;
}
