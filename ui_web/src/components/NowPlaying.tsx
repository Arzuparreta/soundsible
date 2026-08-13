import { createEffect, createMemo, createSignal, Show } from 'solid-js';
import { actions, state } from '../stores';
import { coverUrl } from '../lib/media';
import {
  DEFAULT_NOW_PLAYING_LAYOUT,
  layoutFromPreset,
  NOW_PLAYING_LAYOUT_KEY,
  parseNowPlayingLayout,
  type NowPlayingLayoutPresetId,
  type NowPlayingPanelId,
} from '../lib/nowPlayingLayout';
import type { PlaybackQueueEntry } from '../lib/playbackQueue';
import { t } from '../lib/i18n';
import { NowPlayingBrowser } from './NowPlayingBrowser';
import { PlayerLayoutControl } from './PlayerLayoutControl';
import { PlayerStage } from './PlayerStage';
import {
  PlayerTrackList,
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

  const currentQueueEntry = createMemo(() => state.playback.queue[state.playback.index]);
  const manualQueue = createMemo(() =>
    state.playback.queue.slice(state.playback.index + 1).filter((entry) => entry.queueLane === 'manual'),
  );
  const contextQueue = createMemo(() =>
    state.playback.queue.slice(state.playback.index + 1).filter((entry) => entry.queueLane === 'context'),
  );
  const generatedQueue = createMemo(() =>
    state.playback.queue.slice(state.playback.index + 1).filter((entry) => entry.queueLane === 'generated'),
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
    const queueIndex = () => state.playback.queue.findIndex((item) => item.queueId === entry.queueId);
    return {
      id: entry.queueId,
      title: entry.title,
      artist: entry.artist,
      cover: entry.cover ?? coverUrl(entry.id),
      position: ordinal,
      current,
      paused: current && !state.playback.isPlaying,
      onActivate: current ? undefined : () => actions.playQueueEntry(entry.queueId),
      trailing: current ? undefined : removeButton(entry),
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

  const queueSections = createMemo<PlayerTrackListSection[]>(() => {
    const sections: PlayerTrackListSection[] = [];
    const current = currentQueueEntry();
    if (current) {
      sections.push({
        id: 'current',
        label: t('nowPlaying.nowPlayingSection'),
        entries: [queueRow(current, undefined, true)],
      });
    }
    sections.push({
      id: 'manual',
      label: t('nowPlaying.manualQueue'),
      count: manualQueue().length,
      entries: manualQueue().map((entry, index) => queueRow(entry, index + 1)),
    });
    sections.push({
      id: 'context',
      label: contextQueue()[0]?.queueContext?.label || t('nowPlaying.contextQueue'),
      count: contextQueue().length,
      entries: contextQueue().map((entry, index) => queueRow(entry, index + 1)),
    });
    sections.push({
      id: 'generated',
      label: state.playback.radioMode ? t('nowPlaying.radioQueue') : t('nowPlaying.autoplayQueue'),
      count: generatedQueue().length,
      entries: generatedQueue().map((entry, index) => queueRow(entry, index + 1)),
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
                count={state.playback.queue.length}
                sections={queueSections()}
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
