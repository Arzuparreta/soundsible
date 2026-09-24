import { navigateMusic, trackMusic } from '../lib/musicNavigation';
import { buildTrackMenu } from './trackActions';
import { menuIcons } from './icons';
import { savedFromTrack } from '../lib/saved';
import { createEffect, createMemo, createSignal, Show } from 'solid-js';
import { actions, state } from '../stores';
import { trackCoverUrl } from '../lib/media';
import {
  DEFAULT_NOW_PLAYING_LAYOUT,
  layoutFromPreset,
  NOW_PLAYING_LAYOUT_KEY,
  parseNowPlayingLayout,
  type NowPlayingLayoutPresetId,
  type NowPlayingPanelId,
} from '../lib/nowPlayingLayout';
import { contextContinuation, sameQueueSection, type PlaybackQueueEntry } from '../lib/playbackQueue';
import { contextDestination } from '../lib/playbackContext';
import { isPodcastTrack } from '../lib/track';
import { trackCount } from '../lib/format';
import { t } from '../lib/i18n';
import { NowPlayingBrowser } from './NowPlayingBrowser';
import { PlayerLayoutControl } from './PlayerLayoutControl';
import { PlayerStage } from './PlayerStage';
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

export function NowPlaying(props: {
  mobilePanel: NowPlayingMobilePanel;
  onMobilePanelChange: (panel: NowPlayingMobilePanel) => void;
  onCarouselProgress?: (index: number, live: boolean) => void;
  surfaceOpen: boolean;
  onCloseSurface?: () => void;
}) {
  const [desktopLayout, setDesktopLayout] = createSignal(
    parseNowPlayingLayout(localStorage.getItem(NOW_PLAYING_LAYOUT_KEY), localStorage.getItem('np:panelSide')),
  );
  const [browserView, setBrowserView] = createSignal<'browser' | 'chat'>('browser');
  let desktopQueueEl: HTMLDivElement | undefined;
  let dragFrom: number | null = null;

  // One lookup per queue change, rather than two full scans for every row.
  const queuePositions = createMemo(() => new Map(state.playback.queue.map((entry, index) => [entry.queueId, index])));
  const currentQueueEntry = createMemo(() => state.playback.queue[state.playback.index]);
  const manualQueue = createMemo(() =>
    state.playback.queue.slice(state.playback.index + 1).filter((entry) => entry.queueLane === 'manual'),
  );
  // The radio's picks are still songs to look through. Autoplay's are not: it
  // is a continuation, drawn as its card, however many it has prepared.
  const radioQueue = createMemo(() =>
    state.playback.radioMode
      ? state.playback.queue.slice(state.playback.index + 1).filter((entry) => entry.queueLane === 'generated')
      : [],
  );
  const continuation = createMemo(() =>
    state.playback.radioMode
      ? null
      : contextContinuation(state.playback.queue, state.playback.index, state.playback.repeat === 'all'),
  );
  const panelMinimum: Record<NowPlayingPanelId, number> = { browser: 240, stage: 360, queue: 240 };

  createEffect(() => {
    try {
      localStorage.setItem(NOW_PLAYING_LAYOUT_KEY, JSON.stringify(desktopLayout()));
    } catch {
      /* storage disabled/full */
    }
  });

  // Each lane keeps its own scroll offset, so rewinding the outer box alone
  // would reopen the queue part-way down whichever lane was left scrolled.
  createEffect(() => {
    if (!props.surfaceOpen || !desktopQueueEl) return;
    desktopQueueEl.scrollTop = 0;
    for (const lane of desktopQueueEl.querySelectorAll<HTMLElement>('[data-section-rows]')) {
      lane.scrollTop = 0;
    }
  });

  const applyLayoutPreset = (preset: NowPlayingLayoutPresetId) =>
    setDesktopLayout(layoutFromPreset(preset));

  const resetDesktopLayout = () => {
    try {
      localStorage.removeItem(NOW_PLAYING_LAYOUT_KEY);
      localStorage.removeItem('np:panelSide');
    } catch {
      /* storage disabled */
    }
    setDesktopLayout(layoutFromPreset('balanced'));
  };

  const removeButton = (entry: PlaybackQueueEntry) => (
    <button
      type="button"
      aria-label={t('nowPlaying.removeFromQueue')}
      onClick={() => actions.removeQueueEntry(entry.queueId)}
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
      get music() { return trackMusic(entry); },
      get cover() { return trackCoverUrl(entry, 'thumb'); },
      position: ordinal,
      current,
      // Transport state belongs to the current row, not the whole queue memo.
      get paused() { return current && !state.playback.isPlaying; },
      onActivate: current ? undefined : () => actions.playQueueEntry(entry.queueId),
      get trailing() { return current ? undefined : removeButton(entry); },
      get entry() { return savedFromTrack(entry); },
      menu: () => [
        ...buildTrackMenu(entry),
        ...(!current ? [{ icon: menuIcons.remove(), label: t('nowPlaying.removeFromQueue'), danger: true,
          onSelect: () => actions.removeQueueEntry(entry.queueId) }] : []),
      ],
      // Requests move among themselves; the cards below them never move.
      get canMoveUp() {
        const above = state.playback.queue[queueIndex() - 1];
        return !current && queueIndex() > state.playback.index + 1 && !!above && sameQueueSection(entry, above);
      },
      get canMoveDown() {
        const below = state.playback.queue[queueIndex() + 1];
        return !current && queueIndex() > state.playback.index && !!below && sameQueueSection(entry, below);
      },
      onMove: current ? undefined : (direction) => {
        const from = queueIndex(); const to = from + direction;
        if (from > state.playback.index && to > state.playback.index && to < state.playback.queue.length) actions.moveInQueue(from, to);
      },
      draggable: !current,
      onDragStart: () => { dragFrom = queueIndex(); },
      onDragOver: (event) => {
        if (!current) event.preventDefault();
      },
      onDrop: (event) => {
        event.preventDefault();
        const to = queueIndex();
        if (dragFrom != null && dragFrom !== to) actions.moveInQueue(dragFrom, to);
        dragFrom = null;
      },
    };
  };

  /** The collection the music continues into, as one card. Opening it goes to
   * its page; removing it stops the continuation and leaves the rest alone.
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
    const remove = { label: t('nowPlaying.contextRemove', { name: title }), onSelect: () => actions.removeContext() };
    const artworkFromSongs = context.kind === 'album' || context.kind === 'playlist' || context.kind === 'artist';
    return {
      id: 'context',
      title,
      get detail() {
        return [
          kind,
          remaining > 0 ? trackCount(remaining) : '',
          state.playback.shuffle ? t('nowPlaying.contextShuffled') : '',
          state.playback.repeat === 'all' ? t('nowPlaying.contextRepeats') : '',
        ].filter(Boolean).join(' · ');
      },
      seed: context.id,
      cover: context.cover || (artworkFromSongs ? trackCoverUrl(next.next, 'thumb') : undefined),
      glyph: <ContextGlyph kind={context.kind} />,
      onOpen: open,
      openLabel: open ? t('nowPlaying.contextOpen', { name: title }) : undefined,
      menu: () => [
        ...(open ? [{ icon: menuIcons.open(), label: t('nowPlaying.contextOpen', { name: title }), onSelect: open }] : []),
        { icon: menuIcons.remove(), label: t('nowPlaying.removeFromQueue'), danger: true, onSelect: remove.onSelect },
      ],
      remove,
    };
  };

  /** Autoplay, always there for music: the setting itself, where the queue
   * ends. Switched off it stays, quieter, so switching it back on is one tap.
   * Its state is read by the card, not by the lanes: a refill starting and
   * finishing would otherwise rebuild every row above it. */
  const autoplayCard = (): PlayerTrackListCard | null => {
    const current = state.playback.currentTrack;
    if (state.playback.radioMode || !current || isPodcastTrack(current)) return null;
    const label = t('nowPlaying.autoplayQueue');
    const enabled = () => state.playback.autoplayEnabled;
    return {
      id: 'autoplay',
      title: label,
      get detail() {
        if (!enabled()) return t('nowPlaying.autoplayOff');
        return state.playback.autoplayLoading ? t('nowPlaying.autoplayPreparing') : t('nowPlaying.autoplayOn');
      },
      seed: 'autoplay',
      glyph: <AutoplayGlyph />,
      get dimmed() { return !enabled(); },
      get toggle() {
        return { label, checked: enabled(), onChange: () => void actions.setAutoplayEnabled(!enabled()) };
      },
    };
  };

  const queueSections = createMemo<PlayerTrackListSection[]>(() => {
    const sections: PlayerTrackListSection[] = [];
    const current = currentQueueEntry();
    if (current) {
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
  });

  return (
    <Show
      when={state.playback.currentTrack}
      fallback={<section class={styles.emptyWorkspace}><div class={styles.empty}>{t('nowPlaying.nothingPlaying')}</div></section>}
    >
      <PlayerWorkspace<NowPlayingPanelId>
        panels={['browser', 'stage', 'queue']}
        activePanel={props.mobilePanel}
        onActivePanelChange={props.onMobilePanelChange}
        onCarouselProgress={props.onCarouselProgress}
        surfaceOpen={props.surfaceOpen}
        layout={desktopLayout()}
        onLayoutChange={setDesktopLayout}
        minimums={panelMinimum}
        defaults={DEFAULT_NOW_PLAYING_LAYOUT.ratios}
        panelLabel={(panel) => t(`nowPlaying.panel.${panel}`)}
        ariaLabel={t('nowPlaying.playing')}
        dataScope="now-playing"
        layoutControl={
          <PlayerLayoutControl
            title={t('nowPlaying.layoutWorkspace')}
            ariaLabel={t('nowPlaying.changeLayout')}
            resetLabel={t('nowPlaying.resetLayout')}
            presets={[
              { id: 'balanced', label: t('nowPlaying.layoutBalanced') },
              { id: 'stage', label: t('nowPlaying.layoutPlayer') },
              { id: 'left', label: t('nowPlaying.layoutExplore') },
              { id: 'right', label: t('nowPlaying.layoutQueue') },
            ]}
            onSelect={applyLayoutPreset}
            onReset={resetDesktopLayout}
          />
        }
        renderPanel={(panel, dragHandle) => {
          if (panel === 'stage') {
            return (
              <PlayerStage
                mode="now-playing"
                surfaceOpen={props.surfaceOpen}
                dragHandle={dragHandle}
                onCloseSurface={props.onCloseSurface}
                onOpenList={() => props.onMobilePanelChange('queue')}
                listActive={props.mobilePanel === 'queue'}
                listLabel={t('nowPlaying.queue')}
              />
            );
          }
          if (panel === 'queue') {
            return (
              <PlayerTrackList
                title={t('nowPlaying.queue')}
                count={manualQueue().length + radioQueue().length}
                sections={queueSections()}
                virtualize
                empty={t('nowPlaying.queueEmpty')}
                dragHandle={dragHandle}
                headAction={{
                  label: t('nowPlaying.clearManualQueue'),
                  disabled: manualQueue().length === 0,
                  onClick: () => actions.clearManualQueue(),
                }}
                setScrollerRef={(element) => { desktopQueueEl = element; }}
              />
            );
          }
          if (hostSession() && browserView() === 'chat') {
            return (
              <section class={styles.liveBrowser}>
                <header>
                  {dragHandle}
                  <button type="button" onClick={() => setBrowserView('browser')}>
                    {t('nowPlaying.panel.browser')}
                  </button>
                  <strong>{t('live.chat')}</strong>
                </header>
                <LiveRoomPanel compact />
              </section>
            );
          }
          return (
            <div class={styles.browserWithLive}>
              <Show when={hostSession()}>
                <button class={styles.openLiveChat} type="button" onClick={() => setBrowserView('chat')}>
                  <span />
                  {t('live.chat')}
                </button>
              </Show>
              <NowPlayingBrowser
                active={props.surfaceOpen}
                onClose={() => props.onMobilePanelChange('stage')}
                dragHandle={dragHandle}
              />
            </div>
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
