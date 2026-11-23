import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import { Control } from '../design/Control';
import { ArtworkSurface } from '../design/Artwork';
import { SearchField } from './SearchField';
import SongRow from './SongRow';
import { MusicListRow } from './MusicListRow';
import { SkeletonRows } from './Skeleton';
import { CloseIcon, QueueAddIcon } from './icons';
import { menuIcons } from './icons';
import { openEntryMenu } from './entryActions';
import { openTrackMenu } from './trackActions';
import { playlistCollection } from './playlistActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { savedEntityAction } from './savedEntityActions';
import { catalogEntityCollection, openCollectionMenu, useCollectionInSession, type MusicCollection } from './collectionCommands';
import type { MenuAction } from './ActionMenu';
import {
  intentLabel,
  pickSong,
  queueLabel,
  queueSong,
  type IntentContext,
  type SearchPanelIntent,
} from './playerSearchActions';
import { createCatalogSearch, MIN_SEARCH_LENGTH } from '../lib/catalogSearch';
import { ENTITY_LIMIT, panelResults, SONG_PREVIEW, type PanelSong } from '../lib/playerSearchResults';
import { parseYouTubeInput } from '../lib/youtube';
import { itemArtist, itemBusy, itemToTrack } from '../lib/catalogItem';
import { catalogDestination, catalogMusic, libraryTrackMusic, navigateMusic } from '../lib/musicNavigation';
import { catalogSavedEntity } from '../lib/catalogCollection';
import { playlistDestination } from '../lib/playbackContext';
import { coverUrl, trackCoverUrl } from '../lib/media';
import { savedFromCatalogItem } from '../lib/saved';
import { mobileListLayout } from '../lib/listLayout';
import { pageVisible } from '../lib/pageVisibility';
import { createResponsiveTap } from '../lib/responsiveTap';
import { writeAutoTrackTransfer } from '../lib/autoMusicTransfer';
import type { MenuEvent } from '../lib/menuEvent';
import { isPlayingItem, isPlayingTrack, state } from '../stores';
import { player } from '../stores/player';
import { t } from '../lib/i18n';
import type { CatalogItem, RecommendationContext, Track } from '../types/music';
import styles from './PlayerSearchPanel.module.css';

export type { SearchPanelIntent } from './playerSearchActions';

const SEARCH_DEBOUNCE_MS = 230;
/** A row's own control, in each of the row recipes the panel lists. */
const ACTIVATE = '[data-panel-activate], [data-row-main], [role="button"][tabindex="0"]';

// Shared by both players' panels and kept across opening and closing them:
// a search the listener typed is still there when they come back to it.
const [query, setQuery] = createSignal('');
/** Empty the shared search. */
export const clearPlayerSearch = () => setQuery('');

/**
 * The player's one search bar: find something and act on it, without leaving
 * the player.
 *
 * It is not a second library — browsing belongs to Soundsible's own pages.
 * Whatever the search finds, a song or a collection, offers its actions right
 * here, in either mode: play it, queue it (in DJ, route it), start a DJ session
 * from it, mix it into the session or change the session to it. Its page is
 * one of those actions, not the only one.
 */
export function PlayerSearchPanel(props: {
  active?: boolean;
  /** An errand the DJ opened the panel for. Without one, rows play. */
  intent?: SearchPanelIntent;
  /** The route seam a `route` errand inserts before. */
  beforeQueueId?: string;
  dragHandle?: JSX.Element;
  onClose: () => void;
  /** The errand is done. */
  onDone?: () => void;
  onCancelIntent?: () => void;
}) {
  const active = () => props.active !== false && pageVisible();
  const search = createCatalogSearch({ youtubeFallback: true });
  const [expanded, setExpanded] = createSignal(false);
  let inputEl: HTMLInputElement | undefined;
  let bodyEl: HTMLDivElement | undefined;

  const intentContext = (): IntentContext => {
    const intent = props.intent;
    const before = props.beforeQueueId;
    return {
      intent,
      beforeQueueId: before,
      onDone: props.onDone,
      isCurrent: () => props.intent === intent && props.beforeQueueId === before,
    };
  };

  const term = () => query().trim();
  const searching = () => term().length > 0;

  createEffect(on([query, active], ([value, live]) => {
    setExpanded(false);
    if (!live) { search.cancel(); return; }
    const text = value.trim();
    if (!text) { search.reset(); return; }
    if (text.length >= MIN_SEARCH_LENGTH) search.markPending(parseYouTubeInput(text) ? 'youtube' : 'music');
    const timer = window.setTimeout(() => search.search(text), SEARCH_DEBOUNCE_MS);
    onCleanup(() => window.clearTimeout(timer));
  }));
  onCleanup(() => search.cancel());

  // An errand starts at the field: the listener opened the panel to find one.
  createEffect(on(() => props.intent, (intent) => {
    if (intent && active()) requestAnimationFrame(() => inputEl?.focus({ preventScroll: true }));
  }));

  const results = createMemo(() => panelResults({
    query: term(),
    items: search.items(),
    sections: search.sections(),
    youtube: search.youtubeResults(),
    direct: search.direct(),
    playlistNames: Object.keys(state.playlists),
  }));
  const pending = () => search.loading() || search.youtubeLoading();
  // A seam of the route takes one song; every other errand can take a
  // collection whole.
  const entitiesShown = () => props.intent !== 'route';
  const hasResults = () => {
    const found = results();
    return Boolean(found.lead || found.songs.length || found.entities.length || found.playlists.length);
  };

  /** Enter in the field presses the first row, whatever it is. */
  const activateFirst = () => bodyEl?.querySelector('[data-panel-option]')
    ?.querySelector<HTMLElement>(ACTIVATE)?.click();

  /** Up and down move between rows, and from the field into the list. */
  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const options = [...(bodyEl?.querySelectorAll<HTMLElement>('[data-panel-option]') ?? [])];
    const target = (option: HTMLElement | undefined) => option?.querySelector<HTMLElement>(ACTIVATE);
    const at = options.findIndex((option) => option.contains(document.activeElement));
    if (event.key === 'ArrowUp' && at <= 0) {
      if (at === 0) { event.preventDefault(); inputEl?.focus(); }
      return;
    }
    const next = target(options[event.key === 'ArrowDown' ? at + 1 : at - 1]);
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <aside class={styles.panel} aria-label={t('playerSearch.aria')} data-player-search data-intent={props.intent}>
      <header class={styles.topbar}>
        {props.dragHandle}
        <SearchField
          class={styles.search}
          inputRef={(element) => (inputEl = element)}
          value={query()}
          placeholder={t('playerSearch.placeholder')}
          clearLabel={t('searchPanel.clear')}
          onInput={setQuery}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query()) { event.preventDefault(); setQuery(''); }
            else if (event.key === 'Enter') { event.preventDefault(); activateFirst(); }
            else moveFocus(event);
          }}
        />
        <Control class={styles.close} aria-label={t('searchPanel.closePanel')} onClick={props.onClose}>
          <CloseIcon size={18} />
        </Control>
      </header>
      <Show when={props.intent}>{(intent) => (
        <div class={styles.intent} role="status">
          <span>{t(intent() === 'route' ? 'musicExplorer.placing' : intent() === 'reference' ? 'musicExplorer.referencePicking' : 'musicExplorer.change')}</span>
          <Control onClick={() => props.onCancelIntent?.()}>{t('musicExplorer.cancelPlacement')}</Control>
        </div>
      )}</Show>
      <div class={styles.body} ref={bodyEl} data-browser-body on:keydown={moveFocus}>
        <Show when={searching()}>
          <Show when={search.partial()}><p class={styles.notice} role="status">{t('musicExplorer.partial')}</p></Show>
          <Show when={hasResults()} fallback={
            <Show when={!pending()} fallback={<SkeletonRows count={SONG_PREVIEW} compact />}>
              <Show when={term().length >= MIN_SEARCH_LENGTH}>
                <div class={styles.empty} role="status">
                  <Show when={search.youtubeError()} fallback={<p>{t('searchPanel.noResults')}</p>}>
                    <p>{t('searchPanel.searchError')}</p>
                    <Control onClick={() => search.search(term())}>{t('common.retry')}</Control>
                  </Show>
                </div>
              </Show>
            </Show>
          }>
            <div class={styles.results} aria-busy={pending() || undefined}>
              <Show when={entitiesShown() && results().lead}>{(lead) => <div data-panel-option><EntityRow item={lead()} intent={intentContext()} /></div>}</Show>
              <For each={expanded() ? results().songs : results().songs.slice(0, SONG_PREVIEW)}>{(song) => (
                <div data-panel-option><PanelSongRow song={song} intent={intentContext()} fromSearch /></div>
              )}</For>
              <Show when={!expanded() && results().songs.length > SONG_PREVIEW}>
                <Control class={styles.more} onClick={() => setExpanded(true)}>{t('playerSearch.moreSongs')}</Control>
              </Show>
              <Show when={entitiesShown() && (results().entities.length || results().playlists.length)}>
                <div class={styles.group}>
                  <For each={results().entities}>{(item) => <div data-panel-option><EntityRow item={item} intent={intentContext()} /></div>}</For>
                  <For each={results().playlists.slice(0, ENTITY_LIMIT)}>{(name) => <div data-panel-option><PlaylistRow name={name} intent={intentContext()} /></div>}</For>
                </div>
              </Show>
              <Show when={!props.intent && !search.direct()}>
                <Control class={styles.more} onClick={() => navigateMusic(`/search?q=${encodeURIComponent(term())}`)}>
                  {t('playerSearch.allResults')}
                </Control>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </aside>
  );
}

/** A song row: press plays it (or does the errand), its button queues it. */
function PanelSongRow(props: { song: PanelSong; intent: IntentContext; fromSearch?: boolean }) {
  const [working, setWorking] = createSignal(false);
  const item = () => ('item' in props.song ? props.song.item : null);
  const track = createMemo<Track>(() => {
    if ('track' in props.song) return props.song.track;
    const row = props.song.item;
    return itemToTrack(row) ?? {
      id: row.id, title: row.title, artist: itemArtist(row), album: row.album,
      duration: row.duration, cover: row.cover, source: 'preview',
    };
  });
  const cover = () => {
    const row = item();
    if (!row) return trackCoverUrl(track(), 'thumb');
    return row.cover || (row.track_id ? coverUrl(row.track_id, 'thumb') : undefined);
  };
  const active = () => {
    const row = item();
    return row ? isPlayingItem(row) : isPlayingTrack(track());
  };
  const run = async (action: () => Promise<void>) => {
    if (working()) return;
    setWorking(true);
    try { await action(); } finally { setWorking(false); }
  };
  const pick = () => void run(() => pickSong(props.song, props.intent, props.fromSearch));
  const errand = () => props.intent.intent;
  const openMenu = (event?: MenuEvent) => {
    const row = item();
    if (!row) {
      openTrackMenu(track(), { music: libraryTrackMusic(track()), onAddToPlaylist: openPlaylistPicker,
        onEditMetadata: openMetadataEditor, onPlayOnDevice: openPlayOnDevice, shell: true }, event);
      return;
    }
    openEntryMenu(savedFromCatalogItem(row), {
      item: row,
      music: catalogMusic(row),
      track: itemToTrack(row) ?? undefined,
      recommendation: row.raw?.recommendation as RecommendationContext | undefined,
      shell: true,
    }, event);
  };
  // A song the DJ can plan with can be dragged onto a seam of the route.
  const draggable = () => player().autoMode.active && !errand() && (!item() || Boolean(itemToTrack(item()!)));
  return (
    <SongRow
      track={track()}
      music={item() ? catalogMusic(item()!) : libraryTrackMusic(track())}
      cover={cover()}
      active={active()}
      compact
      busy={working() || Boolean(item() && itemBusy(item()!))}
      // During an errand a press does the errand, and the row says so.
      actionLabel={errand() ? `${intentLabel(errand()!)}: ${track().title}` : undefined}
      onPlay={pick}
      // An errand is the press itself, and the banner above names it.
      primaryAction={errand() ? undefined
        : { label: queueLabel(), icon: <QueueAddIcon size={20} />, onSelect: () => void run(() => queueSong(props.song)) }}
      hideMenu={Boolean(errand())}
      // A phone row is title, the quick button and the cover; the menu is a hold.
      mobileMenuButton={false}
      onMenu={errand() ? undefined : (_track, event) => openMenu(event)}
      onDragStart={draggable() ? (event) => writeAutoTrackTransfer(event, { track: track() }) : undefined}
    />
  );
}

/** An artist or album: its actions, here. */
function EntityRow(props: { item: CatalogItem; intent: IntentContext }) {
  const subtitle = () => props.item.type === 'artist'
    ? t('searchPanel.chipArtist')
    : [t('searchPanel.chipAlbum'), itemArtist(props.item)].filter(Boolean).join(' · ');
  const cover = () => props.item.cover || (props.item.track_id ? coverUrl(props.item.track_id, 'thumb') : undefined);
  const extra = (): MenuAction[] => {
    const destination = catalogDestination(props.item);
    const saved = catalogSavedEntity(props.item);
    return [
      ...(destination ? [{
        icon: props.item.type === 'artist' ? menuIcons.artist() : menuIcons.album(),
        label: t(props.item.type === 'artist' ? 'artistActions.goToArtist' : 'albumActions.goToAlbum'),
        onSelect: () => navigateMusic(destination),
      }] : []),
      ...(saved ? [savedEntityAction(saved)] : []),
    ];
  };
  return (
    <Show when={catalogEntityCollection(props.item)}>{(collection) => (
      <CollectionRow collection={collection()} title={props.item.title} subtitle={subtitle()} cover={cover()}
        round={props.item.type === 'artist'} intent={props.intent} extra={extra} />
    )}</Show>
  );
}

function PlaylistRow(props: { name: string; intent: IntentContext }) {
  return (
    <CollectionRow collection={playlistCollection(props.name)} title={props.name} subtitle={t('playerSearch.playlist')}
      intent={props.intent} extra={() => [{
        icon: menuIcons.open(), label: t('nowPlaying.contextOpen', { name: props.name }),
        onSelect: () => navigateMusic(playlistDestination(props.name)),
      }]} />
  );
}

/** A collection in the results. Pressed, it opens its actions; during a DJ
 * errand that takes collections, pressing it does the errand. */
function CollectionRow(props: {
  collection: MusicCollection;
  title: string;
  subtitle: string;
  cover?: string;
  round?: boolean;
  intent: IntentContext;
  extra: () => MenuAction[];
}) {
  const errand = () => props.intent.intent === 'reference' || props.intent.intent === 'change' ? props.intent.intent : undefined;
  const openActions = (event?: MenuEvent) => openCollectionMenu(props.collection, props.extra(), event, props.subtitle);
  const activate = (event?: MenuEvent) => {
    const purpose = errand();
    if (!purpose) { openActions(event); return; }
    const ctx = props.intent;
    void useCollectionInSession(props.collection, purpose).then(() => { if (ctx.isCurrent?.() !== false) ctx.onDone?.(); });
  };
  const label = () => errand() ? `${intentLabel(errand()!)}: ${props.title}` : `${props.title} — ${props.subtitle}`;
  const tap = createResponsiveTap({ onTap: (event) => activate(event), onLongPress: errand() ? undefined : () => openActions() });
  return (
    <Show when={!mobileListLayout()} fallback={
      <MusicListRow title={props.title} subtitle={props.subtitle} seed={props.title} cover={props.cover} round={props.round}
        actionLabel={label()} onActivate={() => activate()} onMenu={errand() ? undefined : openActions} menuButton={false} />
    }>
      <div class={styles.navRow} onContextMenu={(event) => { if (!errand()) { event.preventDefault(); openActions(event); } }}>
        <Control class={styles.rowActivate} data-panel-activate data-pressable aria-label={label()}
          aria-haspopup={errand() ? undefined : 'dialog'} {...tap} />
        <ArtworkSurface class={styles.navCover} data-round={props.round ? '' : undefined} seed={props.title} src={props.cover} aria-hidden="true" />
        <span class={styles.navText}><strong>{props.title}</strong><small>{props.subtitle}</small></span>
      </div>
    </Show>
  );
}
