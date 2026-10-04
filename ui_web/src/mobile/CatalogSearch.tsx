import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { api, ApiError } from '../lib/api';
import { catalogTrack, itemArtist } from '../lib/catalogTrack';
import { buildIdentityIndex, catalogItemKeys } from '../lib/playbackIdentity';
import { savedFromCatalogItem, savedFromTrack, savedToTrack } from '../lib/saved';
import { programTrack } from '../lib/program/tracks';
import { openContextMenu } from '../lib/contextMenu';
import { t } from '../lib/i18n';
import { coverUrl } from '../lib/media';
import { SearchField } from '../components/SearchField';
import { MusicListRowView } from '../components/MusicListRowView';
import { EmptyState } from '../components/EmptyState';
import type { CatalogItem, SavedEntry, Track } from '../types/music';
import styles from './AndroidStart.module.css';

/** Account-scoped catalog UI; resolution never imports the web audio runtime. */
export default function CatalogSearch(props: {
  generation: number; tracks: Track[]; saved: SavedEntry[]; disconnected: boolean;
  activeId?: string; isActive?: (track: Track) => boolean; onAcquire?: (track: Track) => Promise<void>; onPlay: (track: Track) => Promise<void>; onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = createSignal('');
  const [rows, setRows] = createSignal<CatalogItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [partial, setPartial] = createSignal(false);
  const [pending, setPending] = createSignal<string | null>(null);
  const [retry, setRetry] = createSignal(0);
  const [resolvedTracks, setResolvedTracks] = createSignal(new Map<string, Track>());
  const libraryIndex = createMemo(() => buildIdentityIndex(props.tracks));
  const trackFor = (item: CatalogItem): Track | null => {
    const immediate = catalogTrack(item, props.tracks);
    if (immediate) return immediate;
    for (const key of catalogItemKeys(item)) {
      const track = libraryIndex().get(key);
      if (track && programTrack(track)) return track;
    }
    return resolvedTracks().get(item.id) ?? null;
  };
  let searchEpoch = 0;
  let actionEpoch = 0;
  let actionAbort: AbortController | undefined;
  let disposed = false;
  let account = props.generation;
  const savedKeys = createMemo(() => new Set(props.saved.flatMap(entry => entry.keys)));
  const isSaved = (item: CatalogItem) => catalogItemKeys(item).some(key => savedKeys().has(key));
  createEffect(on(() => [query().trim(), props.generation, props.disconnected, retry()] as const, ([term, generation, disconnected]) => {
    const epoch = ++searchEpoch;
    if (account !== generation) { account = generation; setResolvedTracks(new Map()); }
    actionEpoch++; actionAbort?.abort(); setPending(null);
    const controller = new AbortController();
    setRows([]); setError(''); setPartial(false); setLoading(Boolean(term && !disconnected));
    const timer = term && !disconnected ? setTimeout(() => {
      void api.searchCatalog(term, controller.signal, 'track,library_track').then(result => {
        if (epoch !== searchEpoch || generation !== props.generation || controller.signal.aborted) return;
        setRows(result.items.filter(item => item.type === 'track' || item.type === 'library_track'));
        setPartial(Boolean(result.partial_failures?.length));
      }).catch(failure => {
        if (epoch === searchEpoch && !controller.signal.aborted) setError(t(failure instanceof ApiError && failure.status === 403 ? 'android.permissionDenied' : 'common.loadFailed'));
      }).finally(() => { if (epoch === searchEpoch) setLoading(false); });
    }, 300) : undefined;
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  }));
  onCleanup(() => { disposed = true; searchEpoch++; actionEpoch++; actionAbort?.abort(); });
  async function act(item: CatalogItem, purpose: 'play' | 'save' | 'remove' | 'acquire') {
    if (props.disconnected) return;
    const epoch = ++actionEpoch;
    const generation = props.generation;
    actionAbort?.abort(); const controller = new AbortController(); actionAbort = controller;
    const current = () => !disposed && epoch === actionEpoch && generation === props.generation && !controller.signal.aborted && !props.disconnected;
    setPending(item.id); setError('');
    try {
      let track = trackFor(item);
      let entry = savedFromCatalogItem(item);
      if (purpose !== 'remove' && !track) {
        const artist = itemArtist(item);
        if (!artist || !item.title) throw new Error('Missing recording');
        const result = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration }, controller.signal);
        if (!current()) return;
        if (!result.video_id || !/^[A-Za-z0-9_-]{11}$/.test(result.video_id)) throw new Error('No preview');
        entry = { ...entry, keys: [...new Set([...entry.keys, `yt:${result.video_id}`])] };
        track = savedToTrack(entry, libraryIndex());
        if (track) { const linked = new Map(resolvedTracks()); linked.set(item.id, track); setResolvedTracks(linked); }
      }
      if (!current()) return;
      if (purpose !== 'remove' && track && !programTrack(track)) throw new Error('Unsupported recording');
      if (purpose === 'play') {
        if (!track) throw new Error('No preview');
        await props.onPlay(track);
      } else if (purpose === 'acquire') {
        if (!track || !props.onAcquire) throw new Error('Acquisition unavailable');
        await props.onAcquire(track);
      } else {
        if (purpose === 'save' && track) entry = { ...entry, keys: [...new Set([...entry.keys, ...savedFromTrack(track).keys])] };
        await api.setSavedEntries([entry], purpose === 'save');
        // A submitted mutation belongs to that account even if its query changed.
        if (!disposed && generation === props.generation) await props.onChanged();
      }
    } catch (failure) {
      if (current()) setError(t(failure instanceof ApiError && failure.status === 403 ? 'android.permissionDenied' : purpose === 'play' ? 'search.noPreview' : 'common.loadFailed'));
    } finally { if (current()) setPending(null); }
  }
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
    <Show when={props.disconnected}><p role="status">{t('library.unreachable')}</p></Show>
    <Show when={error()}><p role="alert">{error()} <button onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button></p></Show>
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
