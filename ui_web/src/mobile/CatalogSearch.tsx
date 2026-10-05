import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { api, ApiError } from '../lib/api';
import { itemArtist } from '../lib/catalogTrack';
import { createNativeCatalogActions } from './catalogActions';
import { createNativeDiscoveryFeed } from './discoveryFeed';
import NativeEntityProfile from './EntityProfile';
import { nativeEntitySubject, type NativeEntitySubject } from './entityProfile';
import { registerNativeBack } from './backNavigation';
import { catalogEntityBookmark, catalogEntityDestination, catalogEntityHeld, catalogEntityHoldings } from '../lib/catalogEntity';
import { sameEntity, type SavedEntity } from '../lib/savedEntityIdentity';
import { createResponsiveTap } from '../lib/responsiveTap';
import { SearchDiscoveryView } from '../components/SearchDiscoveryView';
import { CatalogCollectionStatusView } from '../components/CatalogCollectionStatusView';
import { openContextMenu } from '../lib/contextMenu';
import { t } from '../lib/i18n';
import { coverUrl } from '../lib/media';
import { SearchField } from '../components/SearchField';
import { MusicListRowView } from '../components/MusicListRowView';
import { EmptyState } from '../components/EmptyState';
import type { MenuAction } from '../components/ActionMenu';
import type { CatalogItem, SavedEntry, Track } from '../types/music';
import type { createSearchHistoryStorage } from '../lib/searchHistoryStorage';
import styles from './AndroidStart.module.css';

/** Account-scoped catalog UI; resolution never imports the web audio runtime. */
export default function CatalogSearch(props: {
  scrollTarget?: () => HTMLElement | undefined;
  generation: number; tracks: Track[]; saved: SavedEntry[]; disconnected: boolean; history?: ReturnType<typeof createSearchHistoryStorage>;
  offlineMenuActions?: (tracks: Track[]) => MenuAction[];
  onResolvedMenu?: (track: Track, event?: MouseEvent, actions?: MenuAction[]) => void;
  savedEntities?: SavedEntity[]; onEntityMenu?: (entry: SavedEntity, event?: MouseEvent) => void;
  onPlayCollection?: (tracks: Track[], index: number) => Promise<void>;
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
    onAcquire: props.onAcquire, onChanged: props.onChanged, onPlayCollection: props.onPlayCollection });
  const { pending, trackFor, isSaved, act } = catalog;
  const [expanded, setExpanded] = createSignal<string | undefined>();
  const [entities, setEntities] = createSignal<{ subject: NativeEntitySubject; returnScroll: number }[]>([]);
  const entity = () => entities().at(-1);
  const holdings = createMemo(() => catalogEntityHoldings(props.tracks));
  const entitySaved = (item: CatalogItem) => { const entry = catalogEntityBookmark(item); return !!entry && (props.savedEntities ?? []).some(saved => sameEntity(saved, entry)); };
  const known = (item: CatalogItem) => item.type === 'artist' || item.type === 'album' ? entitySaved(item) || catalogEntityHeld(item, holdings()) : isSaved(item) || !!trackFor(item) && trackFor(item)?.source !== 'preview';
  const feed = createNativeDiscoveryFeed({ generation: () => props.generation, disconnected: () => props.disconnected,
    paused: () => !!query().trim() || !!entity(), expanded, known });
  let navigation = 0;
  let restorePosition: number | undefined;
  let sectionPosition = 0;
  const scrollPosition = () => props.scrollTarget?.()?.scrollTop ?? window.scrollY;
  function restoreScroll() {
    if (restorePosition === undefined) return;
    const position = restorePosition, owner = navigation; restorePosition = undefined;
    requestAnimationFrame(() => {
      if (disposed || owner !== navigation) return;
      const target = props.scrollTarget?.();
      if (target) target.scrollTop = position; else window.scrollTo({ top: position });
    });
  }
  function openEntity(path: string) {
    const subject = nativeEntitySubject(path); if (!subject || props.disconnected) return;
    navigation++; catalog.reset(); restorePosition = 0;
    setEntities(previous => [...previous, { subject, returnScroll: scrollPosition() }]);
  }
  function backEntity() {
    const previous = entity(); if (!previous) return;
    navigation++; catalog.reset(); restorePosition = previous.returnScroll;
    setEntities(values => values.slice(0, -1));
    if (!entity()) restoreScroll();
  }
  function backSection() {
    navigation++; catalog.reset(); setExpanded(undefined); restorePosition = sectionPosition; restoreScroll();
  }
  function openSection(section: string) {
    sectionPosition = scrollPosition(); navigation++; catalog.reset(); setExpanded(section); restorePosition = 0; restoreScroll();
  }
  registerNativeBack(() => {
    if (entity()) { backEntity(); return true; }
    if (expanded()) { backSection(); return true; }
    return false;
  });
  let searchEpoch = 0;
  let disposed = false;
  let account = props.generation;
  createEffect(on(() => [query().trim(), props.generation, props.disconnected, retry()] as const, ([term, generation, disconnected]) => {
    const epoch = ++searchEpoch;
    if (account !== generation) { navigation++; setEntities([]); setExpanded(undefined); }
    catalog.reset(account !== generation); account = generation;
    const controller = new AbortController();
    setRows([]); setError(''); setPartial(false); setLoading(Boolean(term && !disconnected));
    const timer = term && !disconnected ? setTimeout(() => {
      void api.searchCatalog(term, controller.signal, 'track,library_track,artist,album').then(result => {
        if (epoch !== searchEpoch || generation !== props.generation || controller.signal.aborted) return;
        props.history?.remember('music', term);
        setRows(result.items.filter(item => ['track', 'library_track', 'artist', 'album'].includes(item.type)));
        setPartial(Boolean(result.partial_failures?.length));
      }).catch(failure => {
        if (epoch === searchEpoch && !controller.signal.aborted) setError(t(failure instanceof ApiError && failure.status === 403 ? 'android.permissionDenied' : 'common.loadFailed'));
      }).finally(() => { if (epoch === searchEpoch) setLoading(false); });
    }, 300) : undefined;
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  }));
  onCleanup(() => { disposed = true; searchEpoch++; });
  function menu(item: CatalogItem, event?: MouseEvent) {
    const resolved = trackFor(item);
    const generation = props.generation;
    const search = searchEpoch, route = navigation;
    const saved = isSaved(item);
    const run = (purpose: 'play' | 'save' | 'remove' | 'acquire') => { if (generation === props.generation && search === searchEpoch && route === navigation && !disposed) void act(item, purpose); };
    if (resolved && props.onResolvedMenu) {
      if (resolved.source === 'preview') props.onResolvedMenu(resolved, event, [
        { label: t('common.play'), disabled: props.disconnected || pending() === item.id, onSelect: () => run('play') },
        { label: t(saved ? 'collection.unsave' : 'collection.save'), selected: saved, disabled: props.disconnected || pending() === item.id, onSelect: () => run(saved ? 'remove' : 'save') },
      ]);
      else props.onResolvedMenu(resolved, event);
      return;
    }
    openContextMenu({ title: item.title, actions: [
      { label: t('common.play'), disabled: props.disconnected || pending() === item.id, onSelect: () => run('play') },
      { label: t(saved ? 'collection.unsave' : 'collection.save'), selected: saved, disabled: props.disconnected || pending() === item.id, onSelect: () => run(saved ? 'remove' : 'save') },
      ...(props.onAcquire && (!trackFor(item) || trackFor(item)?.source === 'preview') ? [{ label: t('collectionControl.download'), disabled: props.disconnected || pending() === item.id, onSelect: () => run('acquire') }] : []),
    ] }, event);
  }
  function entityMenu(item: CatalogItem, event?: MouseEvent) {
    const entry = catalogEntityBookmark(item); if (entry) props.onEntityMenu?.(entry, event);
  }
  const entityStatus = (item: CatalogItem) => [entitySaved(item) ? t('savedEntities.saved') : '', catalogEntityHeld(item, holdings()) ? t('savedEntities.inLibrary') : ''].filter(Boolean).join(' · ');
  const songRow = (item: CatalogItem) => {
    const track = () => trackFor(item);
    return <MusicListRowView playback title={item.title} subtitle={itemArtist(item)} seed={item.id}
      cover={track()?.source !== 'preview' && track() ? coverUrl(track()!.id, 'thumb') : item.cover}
      active={Boolean(track() && (props.isActive ? props.isActive(track()!) : props.activeId === track()!.id))} busy={pending() === item.id}
      disabled={props.disconnected} onActivate={() => void act(item, 'play')} onMenu={event => menu(item, event)} />;
  };
  return <section class={styles.library} data-testid="android-catalog-search">
    <div style={{ display: entity() ? 'none' : undefined }}>
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
    <Show when={partial() || catalog.partial()}><p role="status">{t('musicExplorer.partial')}</p></Show>
    <Show when={!loading() && query().trim() && !props.disconnected}>
      <For each={rows()} fallback={<EmptyState>{t('search.catalogNoResults')}</EmptyState>}>{item => item.type === 'artist' || item.type === 'album'
        ? <MusicListRowView title={item.title} subtitle={itemArtist(item)} cover={item.cover} seed={item.id} round={item.type === 'artist'} disabled={props.disconnected}
          onActivate={() => { const path = catalogEntityDestination(item); if (path) openEntity(path); }} onMenu={event => entityMenu(item, event)} />
        : songRow(item)}</For>
    </Show>
    <Show when={!query().trim() && !props.disconnected}><SearchDiscoveryView sections={feed.sections()} songs={feed.songs()} expanded={expanded()}
      loading={feed.loading()} error={feed.error()} preparing={!!feed.feed().revalidating}
      onBack={backSection} onRetry={feed.retry}
      renderMore={(section, link) => <button type="button" class={link.class} aria-label={link.label} onClick={() => openSection(section)}>{link.children}</button>}
      renderEntity={(item, link) => { const tap = createResponsiveTap({ onTap: () => { const path = catalogEntityDestination(item); if (path) openEntity(path); }, onLongPress: () => entityMenu(item) });
        return <button type="button" class={link.class} aria-label={link.label} {...tap} onContextMenu={event => { event.preventDefault(); entityMenu(item, event); }}>{link.children}</button>; }}
      renderStatus={item => <CatalogCollectionStatusView label={entityStatus(item)} />} renderSong={songRow} /></Show>
    </div>
    <Show when={entity()?.subject} keyed>{subject => <NativeEntityProfile subject={subject} generation={props.generation} tracks={props.tracks}
      disconnected={props.disconnected} catalog={catalog} isActive={props.isActive} onBack={backEntity} onOpen={openEntity}
      onEntityMenu={props.onEntityMenu} onTrackMenu={menu} onChanged={props.onChanged} savedEntities={props.savedEntities} offlineMenuActions={props.offlineMenuActions} onReady={restoreScroll} />}</Show>
    <Show when={entity() && catalog.error()}><p role="alert">{catalog.error()}</p></Show>
    <Show when={entity() && catalog.partial()}><p role="status">{t('musicExplorer.partial')}</p></Show>
  </section>;
}
