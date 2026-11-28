import type { MenuEvent } from '../lib/menuEvent';
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { api, ApiError } from '../lib/api';
import { itemArtist } from '../lib/catalogTrack';
import { savedFromCatalogItem, savedToTrack } from '../lib/saved';
import { createNativeCatalogActions, pendingCatalogTrack } from './catalogActions';
import { createNativeDiscoveryFeed } from './discoveryFeed';
import NativeEntityProfile from './EntityProfile';
import { catalogFeedback, nativeFeedbackActions, nativeMusicLinkActions } from './songActions';
import { artistDestination, catalogItemMusic, performerNames } from '../lib/musicLinks';
import linkStyles from '../components/MusicLinks.module.css';
import { nativeEntitySubject, type NativeEntitySubject } from './entityProfile';
import { registerNativeBack } from './backNavigation';
import { catalogEntityBookmark, catalogEntityDestination, catalogEntityHeld, catalogEntityHoldings } from '../lib/catalogEntity';
import { sameEntity, type SavedEntity } from '../lib/savedEntityIdentity';
import { createResponsiveTap } from '../lib/responsiveTap';
import { discoveryHasVisible, isColdDiscoveryFeed } from '../lib/searchDiscovery';
import { SearchDiscoveryView } from '../components/SearchDiscoveryView';
import { CatalogCollectionStatusView } from '../components/CatalogCollectionStatusView';
import { openContextMenu } from '../lib/contextMenu';
import { t } from '../lib/i18n';
import { coverUrl } from '../lib/media';
import { IconButton } from '../design/Control';
import { RefreshIcon } from '../components/icons';
import { SearchField } from '../components/SearchField';
import { PageToolbar } from '../components/PageToolbar';
import { MusicListRowView } from '../components/MusicListRowView';
import { SkeletonRows } from '../design/Skeleton';
import { EmptyState } from '../components/EmptyState';
import type { MenuAction } from '../components/ActionMenu';
import type { CatalogItem, SavedEntry, Track } from '../types/music';
import type { createSearchHistoryStorage } from '../lib/searchHistoryStorage';
import styles from './AndroidStart.module.css';

function NativeArtistLink(props: { path: string; name: string; onOpen: (path: string) => void }) {
  const tap = createResponsiveTap({
    onTap: event => {
      event.stopPropagation();
      event.preventDefault();
      props.onOpen(props.path);
    },
  });
  return <a href={`#${props.path}`} class={linkStyles.link} draggable={false} {...tap}
    onKeyDown={event => event.stopPropagation()}
    onContextMenu={event => event.stopPropagation()}
    onDragStart={event => event.stopPropagation()}>{props.name}</a>;
}

/** Account-scoped catalog UI; resolution never imports the web audio runtime. */
export default function CatalogSearch(props: {
  scrollTarget?: () => HTMLElement | undefined;
  detailOnly?: boolean;
  closeDetailToken?: number;
  onDetailChange?: (open: boolean) => void;
  generation: number; tracks: Track[]; saved: SavedEntry[]; disconnected: boolean; history?: ReturnType<typeof createSearchHistoryStorage>;
  offlineMenuActions?: (tracks: Track[]) => MenuAction[];
  onResolvedMenu?: (track: Track, event?: MenuEvent, actions?: MenuAction[]) => void;
  /** "Play next" and "Add to queue" for a song, matched to a video or not. */
  queueActions?: (track: Track) => MenuAction[];
  onPlayOnDevice?: (track: Track) => void;
  onStartRadio?: (track: Track) => Promise<void>;
  onStartDj?: (tracks: Track[], label: string) => Promise<void>;
  savedEntities?: SavedEntity[]; onEntityMenu?: (entry: SavedEntity, event?: MenuEvent) => void;
  onPlayCollection?: (tracks: Track[], index: number) => Promise<void>;
  activeId?: string; isActive?: (track: Track) => boolean; onAcquire?: (track: Track) => Promise<void>; onPlay: (track: Track) => Promise<void>; onChanged: () => Promise<void>;
  /** An artist or album page asked for from a song menu elsewhere; each id opens once. */
  openRequest?: { path: string; id: number } | null; onRequestHandled?: (id: number) => void;
}) {
  const [query, setQuery] = createSignal('');
  const [rows, setRows] = createSignal<CatalogItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [partial, setPartial] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  const catalog = createNativeCatalogActions({ generation: () => props.generation, tracks: () => props.tracks,
    saved: () => props.saved, disconnected: () => props.disconnected, onPlay: props.onPlay,
    onStartRadio: props.onStartRadio, onStartDj: props.onStartDj, onAcquire: props.onAcquire, onChanged: props.onChanged, onPlayCollection: props.onPlayCollection });
  const { pending, trackFor, isSaved, act } = catalog;
  const [expanded, setExpanded] = createSignal<string | undefined>();
  const [dismissed, setDismissed] = createSignal<Set<string>>(new Set());
  const [dismissedArtists, setDismissedArtists] = createSignal<Set<string>>(new Set());
  const foldArtist = (name: string | undefined) => (name ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const itemArtistNames = (item: CatalogItem, fallback?: string): string[] => {
    const structured = item.raw?.artists?.map((name) => name.trim()).filter(Boolean);
    if (structured?.length) return structured;
    const single = (fallback ?? itemArtist(item)).trim();
    return single ? [single] : [];
  };
  const [entities, setEntities] = createSignal<{ subject: NativeEntitySubject; scope: ReturnType<typeof createSignal<NativeEntitySubject["view"]>>; returnScroll: number }[]>([]);
  const entity = () => entities().at(-1);
  function updateEntities(next: ReturnType<typeof entities>) {
    const wasOpen = entities().length > 0;
    setEntities(next);
    const isOpen = next.length > 0;
    if (wasOpen !== isOpen) props.onDetailChange?.(isOpen);
  }
  const holdings = createMemo(() => catalogEntityHoldings(props.tracks));
  const entitySaved = (item: CatalogItem) => { const entry = catalogEntityBookmark(item); return !!entry && (props.savedEntities ?? []).some(saved => sameEntity(saved, entry)); };
  const known = (item: CatalogItem) => item.type === 'artist' || item.type === 'album' ? entitySaved(item) || catalogEntityHeld(item, holdings()) : isSaved(item) || !!trackFor(item) && trackFor(item)?.source !== 'preview';
  const feed = createNativeDiscoveryFeed({ generation: () => props.generation, disconnected: () => props.disconnected,
    paused: () => !!props.detailOnly || !!query().trim() || !!entity(), expanded, known });
  const visibleSections = createMemo(() => {
    const hiddenArtists = dismissedArtists();
    const sections = feed.sections();
    if (!hiddenArtists.size) return sections;
    return sections
      .map(section => ({
        ...section,
        items: section.items.filter(item => {
          const fallback = item.type === 'artist' ? (item.artist || item.title) : (item.artist || item.subtitle);
          return !itemArtistNames(item, fallback).some(name => {
            const key = foldArtist(name);
            return Boolean(key && hiddenArtists.has(key));
          });
        }),
      }))
      .filter(section => section.items.length > 0);
  });
  const visibleTrackShelves = createMemo(() => {
    const hidden = dismissed();
    const hiddenArtists = dismissedArtists();
    const shelves = feed.trackShelves();
    if (!hidden.size && !hiddenArtists.size) return shelves;
    return shelves
      .map(shelf => ({
        ...shelf,
        items: shelf.items.filter(item => {
          if (hidden.has(item.id)) return false;
          if (hiddenArtists.size) {
            for (const name of itemArtistNames(item)) {
              const key = foldArtist(name);
              if (key && hiddenArtists.has(key)) return false;
            }
          }
          return true;
        }),
      }))
      .filter(shelf => shelf.items.length > 0);
  });
  const refreshFeed = () => { setDismissed(new Set<string>()); setDismissedArtists(new Set<string>()); feed.refresh(); };
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
    const subject = nativeEntitySubject(path); if (!subject || props.disconnected && subject.view !== 'library') return;
    navigation++; catalog.reset(); restorePosition = 0;
    updateEntities([...entities(), { subject, scope: createSignal(subject.view), returnScroll: scrollPosition() }]);
  }
  let handledRequest = 0;
  createEffect(() => {
    const requested = props.openRequest;
    if (!requested || requested.id <= handledRequest) return;
    handledRequest = requested.id; openEntity(requested.path); props.onRequestHandled?.(requested.id);
  });
  function backEntity() {
    const previous = entity(); if (!previous) return;
    navigation++; catalog.reset(); restorePosition = previous.returnScroll;
    updateEntities(entities().slice(0, -1));
    if (!entity()) restoreScroll();
  }
  createEffect(on(() => props.closeDetailToken, () => {
    if (!entities().length) return;
    const root = entities()[0];
    navigation++; catalog.reset(); restorePosition = root.returnScroll;
    updateEntities([]);
    restoreScroll();
  }, { defer: true }));
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
    if (account !== generation) { navigation++; updateEntities([]); setExpanded(undefined); setDismissed(new Set<string>()); setDismissedArtists(new Set<string>()); }
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
  function emitSearchPlayed(item: CatalogItem) {
    if (query().trim().length < 2) return;
    const artist = itemArtist(item);
    if (!artist || !item.title) return;
    const youtubeId = item.external_ids?.youtube_id ? String(item.external_ids.youtube_id) : undefined;
    void api.emitDiscoveryEvent?.('music_search_played', {
      media_type: 'music_track',
      track_id: item.track_id || undefined,
      title: item.title,
      artist,
      album: item.album,
      youtube_id: youtubeId,
      source: 'search',
    })?.catch(() => {});
  }
  function menu(item: CatalogItem, event?: MenuEvent) {
    const resolved = trackFor(item);
    const generation = props.generation;
    const search = searchEpoch, route = navigation;
    const saved = isSaved(item);
    const run = (purpose: 'play' | 'save' | 'remove' | 'acquire' | 'radio') => {
      if (generation === props.generation && search === searchEpoch && route === navigation && !disposed) {
        if (purpose === 'play') emitSearchPlayed(item);
        void act(item, purpose);
      }
    };
    const current = () => generation === props.generation && !disposed && !props.disconnected;
    const feedback = nativeFeedbackActions(catalogFeedback(item), current, {
      onDismissed: () => setDismissed(prev => { const next = new Set(prev); next.add(item.id); return next; }),
      onUndone: () => setDismissed(prev => {
        if (!prev.has(item.id)) return prev;
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      }),
      onArtistDismissed: (artist) => {
        const key = foldArtist(artist);
        if (!key) return;
        setDismissedArtists(prev => { const next = new Set(prev); next.add(key); return next; });
      },
      onArtistUndone: (artist) => {
        const key = foldArtist(artist);
        if (!key) return;
        setDismissedArtists(prev => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      },
    });
    if (resolved && props.onResolvedMenu) {
      if (resolved.source === 'preview') props.onResolvedMenu(resolved, event, [
        { label: t('common.play'), disabled: props.disconnected || pending() === item.id, onSelect: () => run('play') },
        ...(!saved || !resolved.item_id ? [{
          label: t(saved ? 'collection.unsave' : 'collection.save'), selected: saved,
          disabled: props.disconnected || pending() === item.id, onSelect: () => run(saved ? 'remove' : 'save'),
        }] : []),
        ...feedback,
      ]);
      else props.onResolvedMenu(resolved, event, feedback);
      return;
    }
    const radioActions: MenuAction[] = props.onStartRadio && item.title && itemArtist(item)
      ? [{ label: t('trackActions.startRadio'), disabled: props.disconnected || pending() === item.id, onSelect: () => run('radio') }]
      : [];
    openContextMenu({ title: item.title, actions: [
      { label: t('common.play'), disabled: props.disconnected || pending() === item.id, onSelect: () => run('play') },
      ...(props.queueActions && item.title && itemArtist(item) ? props.queueActions(pendingCatalogTrack(item)) : []),
      ...radioActions,
      ...(props.onPlayOnDevice && item.title && itemArtist(item) ? [{ label: t('trackActions.playOnDevice'), disabled: props.disconnected,
        onSelect: () => { if (current()) props.onPlayOnDevice!(savedToTrack(savedFromCatalogItem(item), new Map())!); } }] : []),
      { label: t(saved ? 'collection.unsave' : 'collection.save'), selected: saved, disabled: props.disconnected || pending() === item.id, onSelect: () => run(saved ? 'remove' : 'save') },
      ...(props.onAcquire && (!trackFor(item) || trackFor(item)?.source === 'preview') ? [{ label: t('collectionControl.download'), disabled: props.disconnected || pending() === item.id, onSelect: () => run('acquire') }] : []),
      ...nativeMusicLinkActions(catalogItemMusic(item), path => { if (current()) openEntity(path); }, props.disconnected),
      ...feedback,
    ] }, event);
  }
  function entityMenu(item: CatalogItem, event?: MenuEvent) {
    const entry = catalogEntityBookmark(item); if (entry) props.onEntityMenu?.(entry, event);
  }
  const entityStatus = (item: CatalogItem) => [entitySaved(item) ? t('savedEntities.saved') : '', catalogEntityHeld(item, holdings()) ? t('savedEntities.inLibrary') : ''].filter(Boolean).join(' · ');
  const songSubtitle = (item: CatalogItem, owned?: Track) => {
    const fallback = itemArtist(item);
    const music = catalogItemMusic(item, owned);
    if (music.linkable === false || (props.disconnected && music.view !== 'library')) return fallback;
    const names = performerNames(music);
    if (!names.length) return fallback;
    return <For each={names}>{(name, index) => <><Show when={index() > 0}>{', '}</Show><NativeArtistLink path={artistDestination(music, name)} name={name} onOpen={openEntity} /></>}</For>;
  };
  const songRow = (item: CatalogItem) => {
    const track = () => trackFor(item);
    return <MusicListRowView playback title={item.title} subtitle={itemArtist(item)} subtitleContent={songSubtitle(item, track() ?? undefined)} seed={item.id}
      cover={track()?.source !== 'preview' && track() ? coverUrl(track()!.id, 'thumb') : item.cover}
      active={Boolean(track() && (props.isActive ? props.isActive(track()!) : props.activeId === track()!.id))} busy={pending() === item.id}
      disabled={props.disconnected} onActivate={() => { emitSearchPlayed(item); void act(item, 'play'); }} onMenu={event => menu(item, event)} />;
  };
  const cold = () => isColdDiscoveryFeed(feed.feed(), visibleSections(), visibleTrackShelves());
  return <section class={styles.library} data-testid={props.detailOnly ? undefined : 'android-catalog-search'}>
    <Show when={!props.detailOnly}><div style={{ display: entity() ? 'none' : undefined }}>
    <PageToolbar contained field={<SearchField value={query()} placeholder={t('search.placeholder')} onInput={setQuery} />}
      actions={!query().trim() && !expanded() && !props.disconnected && discoveryHasVisible(visibleSections(), visibleTrackShelves()) ? (
        <IconButton
          class={styles.refreshBtn}
          label={t('searchHome.refresh')}
          disabled={feed.refreshing() || feed.loading()}
          aria-busy={feed.refreshing() ? 'true' : undefined}
          onClick={refreshFeed}
        >
          <RefreshIcon class={feed.refreshing() ? styles.spinning : undefined} />
        </IconButton>
      ) : undefined} />
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
    <Show when={loading()}><SkeletonRows count={6} variant="media" /></Show>
    <Show when={partial() || catalog.partial()}><p role="status">{t('musicExplorer.partial')}</p></Show>
    <Show when={!loading() && query().trim() && !props.disconnected}>
      <For each={rows()} fallback={<EmptyState>{t('search.catalogNoResults')}</EmptyState>}>{item => item.type === 'artist' || item.type === 'album'
        ? <MusicListRowView title={item.title} subtitle={itemArtist(item)} cover={item.cover} seed={item.id} round={item.type === 'artist'} disabled={props.disconnected}
          onActivate={() => { const path = catalogEntityDestination(item); if (path) openEntity(path); }} onMenu={event => entityMenu(item, event)} />
        : songRow(item)}</For>
    </Show>
    <Show when={!query().trim() && !props.disconnected}><SearchDiscoveryView sections={visibleSections()} trackShelves={visibleTrackShelves()} expanded={expanded()}
      loading={feed.loading()} error={feed.error()} preparing={!!feed.feed().revalidating} cold={cold()}
      onBack={backSection} onRetry={refreshFeed}
      renderMore={(section, link) => <button type="button" class={link.class} aria-label={link.label} onClick={() => openSection(section)}>{link.children}</button>}
      renderEntity={(item, link) => { const tap = createResponsiveTap({ onTap: () => { const path = catalogEntityDestination(item); if (path) openEntity(path); }, onLongPress: () => entityMenu(item) });
        return <button type="button" class={link.class} aria-label={link.label} {...tap} onContextMenu={event => { event.preventDefault(); entityMenu(item, event); }}>{link.children}</button>; }}
      renderStatus={item => <CatalogCollectionStatusView label={entityStatus(item)} bookmarked={entitySaved(item)} />} renderSong={songRow} /></Show>
    </div></Show>
    <Show when={entity()} keyed>{entry => <NativeEntityProfile subject={entry.subject} view={entry.scope[0]()} onViewChange={entry.scope[1]} generation={props.generation} tracks={props.tracks}
      disconnected={props.disconnected} catalog={catalog} isActive={props.isActive} onBack={backEntity} onOpen={openEntity}
      onEntityMenu={props.onEntityMenu} onTrackMenu={menu} onChanged={props.onChanged} savedEntities={props.savedEntities}
      canStartRadio={!!props.onStartRadio} canStartDj={!!props.onStartDj}
      offlineMenuActions={props.offlineMenuActions} onReady={restoreScroll} />}</Show>
    <Show when={entity() && catalog.error()}><p role="alert">{catalog.error()}</p></Show>
    <Show when={entity() && catalog.partial()}><p role="status">{t('musicExplorer.partial')}</p></Show>
  </section>;
}
