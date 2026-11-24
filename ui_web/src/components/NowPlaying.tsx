import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { navigateMusic, playerTrackMusic } from '../lib/musicNavigation';
import { buildTrackMenu } from './trackActions';
import { menuIcons } from './icons';
import { savedFromTrack } from '../lib/saved';
import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { createActivityMemo } from '../lib/activityMemo';
import { playerCompact } from '../lib/playerDock';
import { pageVisible } from '../lib/pageVisibility';
import { player } from '../stores/player';
import { trackCoverUrl } from '../lib/media';
import {
  DEFAULT_NOW_PLAYING_LAYOUT,
  NOW_PLAYING_PANELS,
  NOW_PLAYING_LAYOUT_KEY,
  parseNowPlayingLayout,
  type NowPlayingPanelId,
} from '../lib/nowPlayingLayout';
import { contextContinuation, futureEntries, sameQueueSection, upcomingQueueEntries, type PlaybackContextKind, type PlaybackQueueEntry } from '../lib/playbackQueue';
import { contextDestination } from '../lib/playbackContext';
import { dropIndex, type DropSlot } from '../lib/dragReorder';
import { isPodcastTrack } from '../lib/track';
import { trackCount } from '../lib/format';
import { t } from '../lib/i18n';
import { PlayerStage } from './PlayerStage';
import { PlayerMiniHeader } from './PlayerMiniHeader';
import {
  PlayerTrackList,
  type PlayerTrackListCard,
  type PlayerTrackListEntry,
  type PlayerTrackListSection,
} from './PlayerTrackList';
import { PlayerWorkspace } from './PlayerWorkspace';
import { LiveRoomPanel } from './LiveRoomPanel';
import { hostSession } from '../lib/community';
import styles from './NowPlaying.module.css';

export type NowPlayingMobilePanel = NowPlayingPanelId;

/** Collections whose card unfolds its upcoming songs in the queue, a page at
 * a time. The library — the listener's whole collection, a tap away in the
 * navigation — opens its page instead; a single song or episode has nothing
 * further to show. */
const EXPANDING_CONTEXTS: ReadonlySet<PlaybackContextKind> = new Set(['album', 'artist', 'playlist', 'favourites', 'search']);

export function NowPlaying(props: {
  mobilePanel: NowPlayingMobilePanel;
  onMobilePanelChange: (panel: NowPlayingMobilePanel) => void;
  surfaceOpen: boolean;
  panelsReady?: boolean;
  onCloseSurface?: () => void;
}) {
  const [desktopLayout, setDesktopLayout] = createSignal(
    parseNowPlayingLayout(localStorage.getItem(NOW_PLAYING_LAYOUT_KEY)),
  );
  // A host's live room chat shares the queue's panel.
  const [queueView, setQueueView] = createSignal<'queue' | 'chat'>('queue');
  const [queueMounted, setQueueMounted] = createSignal(props.panelsReady ?? true);
  // The queue mounts a frame after the stage, so opening the player paints the
  // song first.
  createEffect(() => {
    if (!props.panelsReady || queueMounted()) return;
    if (typeof requestAnimationFrame !== 'function') { setQueueMounted(true); return; }
    const frame = requestAnimationFrame(() => setQueueMounted(true));
    onCleanup(() => cancelAnimationFrame(frame));
  });
  let desktopQueueEl: HTMLDivElement | undefined;

  const panelActive = (panel: NowPlayingPanelId) => props.surfaceOpen && (props.panelsReady ?? true) && pageVisible()
    && (!playerCompact() || props.mobilePanel === panel);
  const queueActive = () => panelActive('queue');
  // Presentation projections sleep with their panel; transport scheduling stays
  // in the stores and continues even while the whole workspace is hidden.
  const queuePositions = createActivityMemo(
    queueActive,
    () => new Map(player().playback.queue.map((entry, index) => [entry.queueId, index])),
    new Map<string, number>(),
    () => [player().playback.queue],
  );
  const currentQueueEntry = createActivityMemo(
    queueActive,
    () => player().playback.queue[player().playback.index],
    undefined,
    () => [player().playback.queue, player().playback.index],
  );
  const upcomingList = createActivityMemo(
    queueActive,
    () => upcomingQueueEntries(player().playback.queue, player().playback.index, {
      auto: false,
      radioMode: player().playback.radioMode,
    }),
    [],
    () => [player().playback.radioMode, player().playback.queue, player().playback.index],
  );
  const manualQueue = () => upcomingList().filter((entry) => entry.queueLane === 'manual');
  // The radio's picks are still songs to look through. Autoplay's are not: it
  // is a continuation, drawn as its card, however many it has prepared.
  const radioQueue = () => upcomingList().filter((entry) => entry.queueLane === 'generated');
  const continuation = createActivityMemo(
    queueActive,
    () => player().playback.radioMode
      ? null
      : contextContinuation(player().playback.queue, player().playback.index, player().playback.repeat === 'all'),
    null,
    () => [player().playback.radioMode, player().playback.queue, player().playback.index, player().playback.repeat],
  );
  // The two minimums and the seam between them fit a 1024px window.
  const panelMinimum: Record<NowPlayingPanelId, number> = { stage: 330, queue: 280 };

  createEffect(() => {
    try {
      localStorage.setItem(NOW_PLAYING_LAYOUT_KEY, JSON.stringify(desktopLayout()));
    } catch {
      /* storage disabled/full */
    }
  });

  // Each lane keeps its own scroll offset; rewind them offscreen after the
  // exit finishes so opening the surface never flushes layout synchronously.
  createEffect(() => {
    if (props.surfaceOpen || !desktopQueueEl) return;
    const timer = window.setTimeout(() => {
      if (!desktopQueueEl || props.surfaceOpen) return;
      desktopQueueEl.scrollTop = 0;
      for (const lane of desktopQueueEl.querySelectorAll<HTMLElement>('[data-section-rows]')) {
        lane.scrollTop = 0;
      }
    }, 320);
    onCleanup(() => window.clearTimeout(timer));
  });

  const removeButton = (entry: PlaybackQueueEntry) => (
    <button
      type="button"
      aria-label={t('nowPlaying.removeFromQueue')}
      onClick={() => player().actions.removeQueueEntry(entry.queueId)}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );

  const queueRow = (
    entry: PlaybackQueueEntry,
    ordinal?: number,
    current = false,
  ): PlayerTrackListEntry => {
    const queueIndex = () => queuePositions().get(entry.queueId) ?? -1;
    return {
      id: entry.queueId,
      title: entry.title,
      artist: entry.artist,
      get music() { return playerTrackMusic(entry); },
      get cover() { return trackCoverUrl(entry, 'thumb'); },
      position: ordinal,
      current,
      // Transport state belongs to the current row, not the whole queue memo.
      get paused() { return current && !player().playback.isPlaying; },
      onActivate: current ? undefined : () => player().actions.playQueueEntry(entry.queueId),
      get trailing() { return current ? undefined : removeButton(entry); },
      get entry() { return savedFromTrack(entry); },
      menu: () => [
        ...buildTrackMenu(entry, {
          music: playerTrackMusic(entry),
          onAddToPlaylist: openPlaylistPicker,
          onEditMetadata: openMetadataEditor,
          onPlayOnDevice: openPlayOnDevice,
        }),
        ...(!current ? [{ icon: menuIcons.remove(), label: t('nowPlaying.removeFromQueue'), danger: true,
          onSelect: () => player().actions.removeQueueEntry(entry.queueId) }] : []),
      ],
      // Songs move within their lane; collection headers stay in place.
      get canMoveUp() {
        const above = player().playback.queue[queueIndex() - 1];
        return !current && queueIndex() > player().playback.index + 1 && !!above && sameQueueSection(entry, above);
      },
      get canMoveDown() {
        const below = player().playback.queue[queueIndex() + 1];
        return !current && queueIndex() > player().playback.index && !!below && sameQueueSection(entry, below);
      },
      onMove: current ? undefined : (direction) => {
        const from = queueIndex(); const to = from + direction;
        if (from > player().playback.index && to > player().playback.index && to < player().playback.queue.length) player().actions.moveInQueue(from, to);
      },
      draggable: !current,
    };
  };

  /** A song dragged within its lane, or within an expanded collection, to the
   * seam the list shows. The list keeps the drag inside the lane it started
   * in; `moveInQueue` still refuses anything that would cross into another. */
  const reorderQueue = (queueId: string, slot: DropSlot) => {
    const ids = player().playback.queue.map((entry) => entry.queueId);
    const from = ids.indexOf(queueId);
    const to = dropIndex(ids, queueId, slot);
    if (from > player().playback.index && to > player().playback.index) player().actions.moveInQueue(from, to);
  };

  /** The collection the music continues into, as one card. Opening it reveals
   * its upcoming songs — or, for the library, the listener's whole collection
   * and a tap away, goes to its page instead. Removing
   * it stops the continuation and leaves the rest alone.
   * What only changes its wording — shuffle, repeat — is read by the card
   * itself, so flipping it does not rebuild the lanes around it. */
  const contextCard = (): PlayerTrackListCard | null => {
    const next = continuation();
    if (!next) return null;
    const { context, remaining } = next;
    const title = context.label || t('nowPlaying.contextUntitled');
    const destination = contextDestination(context, next.next);
    const open = destination ? () => navigateMusic(destination) : undefined;
    const kind = t(`nowPlaying.contextKind.${context.kind}`);
    const remove = player().remote ? undefined : { label: t('nowPlaying.contextRemove', { name: title }), onSelect: () => player().actions.removeContext() };
    const artworkFromSongs = context.kind === 'album' || context.kind === 'playlist' || context.kind === 'artist';
    const expands = EXPANDING_CONTEXTS.has(context.kind);
    return {
      id: 'context',
      songs: expands ? {
        count: remaining,
        rows: (limit) => futureEntries(player().playback.queue, player().playback.index, 'context')
          .slice(0, limit).map((entry, index) => queueRow(entry, index + 1)),
      } : undefined,
      onOpen: expands ? undefined : open,
      openLabel: !expands && open ? t('nowPlaying.contextOpen', { name: title }) : undefined,
      title,
      get detail() {
        return [
          kind,
          remaining > 0 ? trackCount(remaining) : '',
          player().playback.shuffle ? t('nowPlaying.contextShuffled') : '',
          player().playback.repeat === 'all' ? t('nowPlaying.contextRepeats') : '',
        ].filter(Boolean).join(' · ');
      },
      seed: context.id,
      cover: context.cover || (artworkFromSongs ? trackCoverUrl(next.next, 'thumb') : undefined),
      glyph: <ContextGlyph kind={context.kind} />,
      menu: () => [
        ...(open ? [{ icon: menuIcons.open(), label: t('nowPlaying.contextOpen', { name: title }), onSelect: open }] : []),
        ...(remove ? [{ icon: menuIcons.remove(), label: t('nowPlaying.removeFromQueue'), danger: true, onSelect: remove.onSelect }] : []),
      ],
      remove,
    };
  };

  /** Autoplay, always there for music: the setting itself, where the queue
   * ends. Switched off it stays, quieter, so switching it back on is one tap.
   * Its state is read by the card, not by the lanes: a refill starting and
   * finishing would otherwise rebuild every row above it. */
  const autoplayCard = (): PlayerTrackListCard | null => {
    const current = player().playback.currentTrack;
    // This device's setting; the controlled device does not publish its own.
    if (player().remote || player().playback.radioMode || !current || isPodcastTrack(current)) return null;
    const label = t('nowPlaying.autoplayQueue');
    const enabled = () => player().playback.autoplayEnabled;
    return {
      id: 'autoplay',
      title: label,
      get detail() {
        if (!enabled()) return t('nowPlaying.autoplayOff');
        return player().playback.autoplayLoading ? t('nowPlaying.autoplayPreparing') : t('nowPlaying.autoplayOn');
      },
      seed: 'autoplay',
      glyph: <AutoplayGlyph />,
      get dimmed() { return !enabled(); },
      get toggle() {
        return { label, checked: enabled(), onChange: () => void player().actions.setAutoplayEnabled(!enabled()) };
      },
    };
  };

  // Compact layouts show the sounding song in the sticky mini-player above the
  // queue instead of repeating a static "Now playing" row inside the list.
  const showCurrentRow = () => !playerCompact();
  const initialEntry = player().playback.queue[player().playback.index];
  const initialSections: PlayerTrackListSection[] = initialEntry && showCurrentRow()
    ? [{ id: 'current', label: t('nowPlaying.nowPlayingSection'), entries: [queueRow(initialEntry, undefined, true)] }]
    : [];
  const queueSections = createActivityMemo<PlayerTrackListSection[]>(queueActive, () => {
    const sections: PlayerTrackListSection[] = [];
    const current = currentQueueEntry();
    if (current && showCurrentRow()) {
      sections.push({
        id: 'current',
        label: t('nowPlaying.nowPlayingSection'),
        hint: t('nowPlaying.laneHintCurrent'),
        entries: [queueRow(current, undefined, true)],
      });
    }
    sections.push({
      id: 'manual',
      label: t('nowPlaying.manualQueue'),
      hint: t('nowPlaying.laneHintManual'),
      count: manualQueue().length,
      entries: manualQueue().map((entry, index) => queueRow(entry, index + 1)),
    });
    sections.push({
      id: 'generated',
      label: t('nowPlaying.radioQueue'),
      hint: t('nowPlaying.laneHintRadio'),
      count: radioQueue().length,
      entries: radioQueue().map((entry, index) => queueRow(entry, index + 1)),
    });
    const cards = [contextCard(), autoplayCard()].filter((card): card is PlayerTrackListCard => card !== null);
    sections.push({
      id: 'continuation',
      label: t('nowPlaying.continuationSection'),
      hint: t('nowPlaying.laneHintContinuation'),
      entries: [],
      cards,
    });
    return sections;
  }, initialSections, () => [
    showCurrentRow(),
    currentQueueEntry(),
    upcomingList(),
    continuation(),
    player().playback.radioMode,
    player().playback.currentTrack,
  ]);

  return (
    <Show
      when={player().playback.currentTrack}
      fallback={<section class={styles.emptyWorkspace}><div class={styles.empty}>{t('nowPlaying.nothingPlaying')}</div></section>}
    >
      <PlayerWorkspace<NowPlayingPanelId>
        panels={NOW_PLAYING_PANELS}
        activePanel={props.mobilePanel}
        onActivePanelChange={props.onMobilePanelChange}
        surfaceOpen={props.surfaceOpen}
        layout={desktopLayout()}
        onLayoutChange={setDesktopLayout}
        minimums={panelMinimum}
        defaults={DEFAULT_NOW_PLAYING_LAYOUT.ratios}
        panelLabel={(panel) => t(`nowPlaying.panel.${panel}`)}
        ariaLabel={t('nowPlaying.playing')}
        dataScope="now-playing"
        renderPanel={(panel) => {
          if (panel === 'stage') {
            return (
              <PlayerStage
                mode="now-playing"
                surfaceOpen={props.surfaceOpen}
                onCloseSurface={props.onCloseSurface}
              />
            );
          }
          return (
            <Show when={queueMounted()}>
              <div class={styles.queuePanel}>
                <Show when={playerCompact()}>
                  <PlayerMiniHeader mode="now-playing" onBack={() => props.onMobilePanelChange('stage')} />
                </Show>
                <div class={styles.queueBody}>
                  <Show when={hostSession() && queueView() === 'chat'} fallback={
                    <PlayerTrackList
                      title={t('nowPlaying.queue')}
                      count={upcomingList().length}
                      sections={queueSections()}
                      virtualize
                      empty={t('nowPlaying.queueEmpty')}
                      onReorder={reorderQueue}
                      headAction={[
                        ...(hostSession() ? [{ label: t('live.chat'), onClick: () => setQueueView('chat') }] : []),
                        {
                          label: t('nowPlaying.clearManualQueue'),
                          disabled: manualQueue().length === 0,
                          onClick: () => player().actions.clearManualQueue(),
                        },
                      ]}
                      setScrollerRef={(element) => { desktopQueueEl = element; }}
                    />
                  }>
                    <section class={styles.liveChat}>
                      <header>
                        <button type="button" onClick={() => setQueueView('queue')}>
                          {t('nowPlaying.queue')}
                        </button>
                        <strong>{t('live.chat')}</strong>
                      </header>
                      <LiveRoomPanel compact />
                    </section>
                  </Show>
                </div>
              </div>
            </Show>
          );
        }}
      />
    </Show>
  );
}

function ContextGlyph(props: { kind: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {props.kind === 'favourites'
        ? <path d="M12 20s-7-4.35-9.5-8.5C1 8.6 2.3 5 5.5 5 7.6 5 9 6.5 12 9c3-2.5 4.4-4 6.5-4 3.2 0 4.5 3.6 3 6.5C19 15.65 12 20 12 20z" />
        : <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>}
    </svg>
  );
}

/** Autoplay's mark: music that carries on by itself. */
function AutoplayGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18.2 8.4A7 7 0 1 0 19 12" />
      <path d="M19 4v4.5h-4.5" />
      <path d="M10 9.5v5l4-2.5z" fill="currentColor" />
    </svg>
  );
}
