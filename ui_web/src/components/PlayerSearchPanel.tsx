import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import { Control } from '../design/Control';
import { ArtworkSurface } from '../design/Artwork';
import { SearchField } from './SearchField';
import SongRow from './SongRow';
import { MusicListRow } from './MusicListRow';
import { MusicLink } from './MusicLinks';
import { SkeletonRows } from './Skeleton';
import { CloseIcon, HeartIcon, QueueAddIcon, ShuffleIcon, RefreshIcon } from './icons';
import { openEntryMenu } from './entryActions';
import { openTrackMenu } from './trackActions';
import { openPlaylistMenu, playlistTracks } from './playlistActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import {
  intentLabel,
  pickSong,
  playCollection,
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
import { favouritesContext, libraryContext, playlistContext, playlistDestination } from '../lib/playbackContext';
import { pickPlaylistCoverTrack } from '../lib/playlists';
import { collectionIndex } from '../lib/collectionIdentity';
import { coverUrl, trackCoverUrl } from '../lib/media';
import { savedFromCatalogItem } from '../lib/saved';
import { isPodcastTrack } from '../lib/track';
import { mobileListLayout } from '../lib/listLayout';
import { pageVisible } from '../lib/pageVisibility';
import { createResponsiveTap } from '../lib/responsiveTap';
import { writeAutoTrackTransfer } from '../lib/autoMusicTransfer';
import type { MenuEvent } from '../lib/menuEvent';
import {
  discoveryExploreItems,
  discoveryLoading,
  discoveryRefreshing,
  dismissDiscoveryArtist,
  dismissDiscoveryItem,
  refreshDiscoveryFeed,
  restoreDiscoveryArtist,
  restoreDiscoveryItem,
  retainDiscoveryFeed,
} from '../lib/discoveryFeedStore';
import { favouriteTracks, isPlayingItem, isPlayingTrack, musicLibrary, state } from '../stores';
import { player } from '../stores/player';
import { t } from '../lib/i18n';
import type { CatalogItem, RecommendationContext, Track } from '../types/music';
import styles from './PlayerSearchPanel.module.css';

export type { SearchPanelIntent } from './playerSearchActions';

/** Suggestions the idle panel offers before pointing at Discover. */
const SUGGESTIONS = 5;
/** Playlist shortcuts before "All playlists". */
const PLAYLIST_TILES = 6;
const SEARCH_DEBOUNCE_MS = 230;

// Shared by both players' panels and kept across opening and closing them:
// a search the listener typed is still there when they come back to it.
const [query, setQuery] = createSignal('');
/** Empty the shared search. */
export const clearPlayerSearch = () => setQuery('');

/**
 * The player's one search bar, and the shortcuts under it.
 *
 * It is not a second library. Lists, pages and the full search live in
 * Soundsible's own views; the panel answers "what next" without leaving the
 * player: find a song and play or queue it, start a collection, take a
 * suggestion. Anything bigger — an artist, an album, every result — goes to
 * its real page.
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
  const hasResults = () => {
    const found = results();
    return Boolean(found.lead || found.songs.length || found.entities.length || found.playlists.length);
  };

  /** The first thing the list offers, which Enter in the field takes. */
  const activateFirst = () => {
    const found = results();
    const lead = !props.intent && found.lead ? catalogDestination(found.lead) : undefined;
    if (lead) navigateMusic(lead);
    else if (found.songs[0]) void pickSong(found.songs[0], intentContext(), true);
    else if (!props.intent && found.playlists[0]) navigateMusic(playlistDestination(found.playlists[0]));
  };

  /** Up and down move between rows, and from the field into the list. */
  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const options = [...(bodyEl?.querySelectorAll<HTMLElement>('[data-panel-option]') ?? [])];
    const target = (option: HTMLElement | undefined) =>
      option?.querySelector<HTMLElement>('[data-row-main], [role="button"][tabindex="0"], a[href], button');
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
        <Show when={searching()} fallback={<Shortcuts active={active()} intent={intentContext()} />}>
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
              <Show when={!props.intent && results().lead}>{(lead) => <div data-panel-option><EntityRow item={lead()} /></div>}</Show>
              <For each={expanded() ? results().songs : results().songs.slice(0, SONG_PREVIEW)}>{(song) => (
                <div data-panel-option><PanelSongRow song={song} intent={intentContext()} fromSearch /></div>
              )}</For>
              <Show when={!expanded() && results().songs.length > SONG_PREVIEW}>
                <Control class={styles.more} onClick={() => setExpanded(true)}>{t('playerSearch.moreSongs')}</Control>
              </Show>
              <Show when={!props.intent && (results().entities.length || results().playlists.length)}>
                <div class={styles.group}>
                  <For each={results().entities}>{(item) => <div data-panel-option><EntityRow item={item} /></div>}</For>
                  <For each={results().playlists.slice(0, ENTITY_LIMIT)}>{(name) => <div data-panel-option><PlaylistRow name={name} /></div>}</For>
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

/** The idle panel: collections a press away, and a few suggestions. */
function Shortcuts(props: { active: boolean; intent: IntentContext }) {
  createEffect(() => {
    if (!props.active) return;
    onCleanup(retainDiscoveryFeed());
  });
  const suggestions = createMemo(() => discoveryExploreItems().slice(0, SUGGESTIONS));
  const busy = () => discoveryLoading() || discoveryRefreshing();
  // A song for a seam of the route is the one errand a whole collection does
  // not answer.
  const showTiles = () => props.intent.intent !== 'route';
  const favourites = createMemo(() => favouriteTracks().filter((track) => !isPodcastTrack(track)));
  const library = createMemo(() => musicLibrary().filter((track) => !isPodcastTrack(track)));
  const playlists = createMemo(() => Object.keys(state.playlists));
  const byId = createMemo(() => collectionIndex(musicLibrary()));
  return (
    <>
      <Show when={showTiles() && (favourites().length || library().length || playlists().length)}>
        <section class={styles.section} aria-labelledby="player-search-play">
          <h2 id="player-search-play" class={styles.heading}>{t('playerSearch.play')}</h2>
          <div class={styles.tiles}>
            <Show when={favourites().length}>
              <CollectionTile title={t('nav.favourites')} glyph={<HeartIcon size={18} />}
                onPlay={() => playCollection(favourites(), t('nav.favourites'), favouritesContext(t('nav.favourites')), props.intent)} />
            </Show>
            <Show when={library().length}>
              <CollectionTile title={t('playerSearch.shuffleLibrary')} glyph={<ShuffleIcon size={18} />}
                onPlay={() => playCollection(library(), t('nav.library'), libraryContext(t('nav.library')), { ...props.intent, shuffle: true })} />
            </Show>
            <For each={playlists().slice(0, PLAYLIST_TILES)}>{(name) => {
              const cover = createMemo(() => {
                const track = pickPlaylistCoverTrack(name, state.playlists[name] ?? [], byId(), state.librarySettings);
                return track ? trackCoverUrl(track, 'thumb') : undefined;
              });
              return (
                <CollectionTile title={name} cover={cover()}
                  onMenu={props.intent.intent ? undefined : (event) => openPlaylistMenu(name, {}, event)}
                  onPlay={() => {
                    const tracks = playlistTracks(name);
                    playCollection(tracks, name, playlistContext(name, tracks, state.librarySettings), props.intent);
                  }} />
              );
            }}</For>
          </div>
          <Show when={playlists().length > PLAYLIST_TILES && !props.intent.intent}>
            <Control class={styles.more} onClick={() => navigateMusic('/playlists')}>{t('playerSearch.allPlaylists')}</Control>
          </Show>
        </section>
      </Show>
      <Show when={discoveryLoading() || suggestions().length}>
      <section class={styles.section} aria-labelledby="player-search-suggestions">
        <div class={styles.sectionHead}>
          <h2 id="player-search-suggestions" class={styles.heading}>{t('playerSearch.forYou')}</h2>
          <Control class={styles.iconButton} aria-label={t('discoverNodes.refresh')} disabled={busy()} onClick={() => refreshDiscoveryFeed()}>
            <RefreshIcon size={16} class={busy() ? styles.spinning : undefined} />
          </Control>
        </div>
        <Show when={!discoveryLoading() || suggestions().length} fallback={<SkeletonRows count={3} compact />}>
          <For each={suggestions()}>{(item) => (
            <div data-panel-option><PanelSongRow song={{ item }} intent={props.intent} discovery /></div>
          )}</For>
        </Show>
        <Show when={!props.intent.intent}>
          <Control class={styles.more} onClick={() => navigateMusic('/search')}>{t('playerSearch.moreDiscover')}</Control>
        </Show>
      </section>
      </Show>
    </>
  );
}

/** A song row: press plays it (or does the errand), its button queues it. */
function PanelSongRow(props: { song: PanelSong; intent: IntentContext; fromSearch?: boolean; discovery?: boolean }) {
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
        onEditMetadata: openMetadataEditor, onPlayOnDevice: openPlayOnDevice }, event);
      return;
    }
    openEntryMenu(savedFromCatalogItem(row), {
      item: row,
      music: catalogMusic(row),
      track: itemToTrack(row) ?? undefined,
      recommendation: row.raw?.recommendation as RecommendationContext | undefined,
      ...(props.discovery ? {
        onNotInterested: () => dismissDiscoveryItem(row.id),
        onUndoNotInterested: () => restoreDiscoveryItem(row.id),
        onLessFromArtist: (artist: string) => dismissDiscoveryArtist(artist),
        onUndoLessFromArtist: (artist: string) => restoreDiscoveryArtist(artist),
      } : {}),
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

/** An artist or album: its page, never a copy of it inside the panel. */
function EntityRow(props: { item: CatalogItem }) {
  const subtitle = () => props.item.type === 'artist'
    ? t('searchPanel.chipArtist')
    : [t('searchPanel.chipAlbum'), itemArtist(props.item)].filter(Boolean).join(' · ');
  const cover = () => props.item.cover || (props.item.track_id ? coverUrl(props.item.track_id, 'thumb') : undefined);
  return (
    <Show when={catalogDestination(props.item)}>{(path) => (
      <NavigationRow path={path()} title={props.item.title} subtitle={subtitle()} cover={cover()} round={props.item.type === 'artist'} />
    )}</Show>
  );
}

function PlaylistRow(props: { name: string }) {
  return (
    <NavigationRow path={playlistDestination(props.name)} title={props.name} subtitle={t('playerSearch.playlist')}
      onMenu={(event) => openPlaylistMenu(props.name, {}, event)} />
  );
}

/** A row that is a link to a page: following it closes the player there. */
function NavigationRow(props: { path: string; title: string; subtitle: string; cover?: string; round?: boolean; onMenu?: (event?: MenuEvent) => void }) {
  return (
    <Show when={!mobileListLayout()} fallback={
      <MusicListRow title={props.title} titlePath={props.path} subtitle={props.subtitle} seed={props.title} cover={props.cover}
        round={props.round} onMenu={props.onMenu} />
    }>
      <div class={styles.navRow}>
        <MusicLink class={styles.rowActivate} path={props.path} label={`${props.title} — ${props.subtitle}`} onMenu={props.onMenu} />
        <ArtworkSurface class={styles.navCover} data-round={props.round ? '' : undefined} seed={props.title} src={props.cover} aria-hidden="true" />
        <span class={styles.navText}><strong>{props.title}</strong><small>{props.subtitle}</small></span>
      </div>
    </Show>
  );
}

/** A collection a press away: it plays, it never opens. */
function CollectionTile(props: { title: string; cover?: string; glyph?: JSX.Element; onPlay: () => void; onMenu?: (event?: MenuEvent) => void }) {
  const tap = createResponsiveTap({ onTap: props.onPlay, onLongPress: props.onMenu ? () => props.onMenu?.() : undefined });
  return (
    <Control class={styles.tile} aria-label={`${t('playlistDetail.play')}: ${props.title}`} data-pressable {...tap}
      onContextMenu={(event) => { if (props.onMenu) { event.preventDefault(); props.onMenu(event); } }}>
      <Show when={props.glyph} fallback={<ArtworkSurface class={styles.tileCover} seed={props.title} src={props.cover} aria-hidden="true" />}>
        <span class={styles.tileGlyph} aria-hidden="true">{props.glyph}</span>
      </Show>
      <span class={styles.tileTitle}>{props.title}</span>
    </Control>
  );
}
