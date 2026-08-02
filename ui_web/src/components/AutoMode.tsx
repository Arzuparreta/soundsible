import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { actions, state } from '../stores';
import {
  AUTO_MODE_LAYOUT_KEY,
  AUTO_MODE_PANELS,
  autoModeLayoutFromPreset,
  cloneAutoModeLayout,
  DEFAULT_AUTO_MODE_LAYOUT,
  parseAutoModeLayout,
  type AutoModeDesktopLayout,
  type AutoModeLayoutPresetId,
  type AutoModePanelId,
} from '../lib/autoModeLayout';
import { queueIdentity } from '../lib/queueDiscovery';
import { coverUrl } from '../lib/media';
import { t } from '../lib/i18n';
import { NowPlayingBrowser } from './NowPlayingBrowser';
import { PlayerLayoutControl } from './PlayerLayoutControl';
import { PlayerStage } from './PlayerStage';
import { PlayerTrackList, type PlayerTrackListEntry } from './PlayerTrackList';
import { PlayerWorkspace } from './PlayerWorkspace';
import styles from './AutoMode.module.css';

const AUTO_MINIMUMS = { browser: 280, stage: 390, route: 280 };

function readLayout(): AutoModeDesktopLayout {
  try {
    return parseAutoModeLayout(localStorage.getItem(AUTO_MODE_LAYOUT_KEY));
  } catch {
    return cloneAutoModeLayout();
  }
}

export function AutoMode(props: {
  panel: AutoModePanelId;
  onPanelChange: (panel: AutoModePanelId) => void;
  onCarouselProgress?: (index: number, live: boolean) => void;
  surfaceOpen: boolean;
}) {
  const [layout, setLayout] = createSignal(readLayout());
  let draggedQueueId = '';

  const setLayoutPersisted = (next: AutoModeDesktopLayout) => {
    setLayout(next);
    try { localStorage.setItem(AUTO_MODE_LAYOUT_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  const applyLayoutPreset = (preset: AutoModeLayoutPresetId) => setLayoutPersisted(autoModeLayoutFromPreset(preset));
  const resetDesktopLayout = () => {
    try { localStorage.removeItem(AUTO_MODE_LAYOUT_KEY); } catch { /* storage unavailable */ }
    setLayoutPersisted(autoModeLayoutFromPreset('balanced'));
  };

  const upcoming = createMemo(() => state.playback.queue.slice(Math.max(0, state.playback.index + 1)));
  const routeEntries = createMemo<PlayerTrackListEntry[]>(() => upcoming().map((track, index) => {
    const plan = state.autoMode.plan[queueIdentity(track)];
    const committed = index === 0 && state.autoMode.transition.status !== 'idle';
    const waypoint = state.autoMode.requests.some((request) => request.track
      && queueIdentity(request.track) === queueIdentity(track));
    return {
      id: track.queueId,
      title: track.title,
      artist: track.artist,
      cover: track.cover ?? coverUrl(track.id),
      position: index + 1,
      locked: committed,
      draggable: !committed,
      annotation: plan?.sourceSetLabel
        ? `${plan.sourceSetLabel} · ${plan.lineage && plan.lineage.length > 1 ? t('autoMode.source.from') : t('autoMode.source.inside')}`
        : undefined,
      badge: waypoint ? t('autoMode.route.pinned') : committed ? t('autoMode.dj.cued') : undefined,
      onActivate: committed ? undefined : () => actions.playNow(track),
      onDragStart: () => { draggedQueueId = track.queueId; },
      onDragOver: (event) => event.preventDefault(),
      onDrop: (event) => {
        event.preventDefault();
        if (draggedQueueId) actions.moveAutoRoute(draggedQueueId, track.queueId);
        draggedQueueId = '';
      },
      trailing: committed ? undefined : (
        <span class={styles.routeActions}>
          <button type="button" aria-label={t('autoMode.route.moreLike', { title: track.title })} onClick={() => actions.feedbackAutoTrack(track, 'more')}>＋</button>
          <button type="button" aria-label={t('autoMode.route.lessLike', { title: track.title })} onClick={() => actions.feedbackAutoTrack(track, 'less')}>−</button>
          <button type="button" aria-label={t('autoMode.route.remove', { title: track.title })} onClick={() => actions.removeQueueEntry(track.queueId)}>×</button>
        </span>
      ),
    };
  }));

  const Browser = (dragHandle: JSX.Element) => (
    <section class={styles.sourcePanel}>
      <header class={styles.sourceHeader}>
        {dragHandle}
        <span><small>{t('autoMode.label')}</small><strong>{t('autoMode.source.title')}</strong></span>
      </header>
      <div class={styles.sourceTray}>
        <Show when={state.autoMode.sources.length} fallback={
          <p class={styles.sourceEmpty}>{t('autoMode.source.empty')}</p>
        }>
          <For each={state.autoMode.sources}>{(source) => (
            <div class={styles.sourceChip}>
              <span><strong>{source.label}</strong><small>{source.tracks.length}</small></span>
              <button
                type="button"
                aria-label={t('autoMode.source.toggle', { title: source.label })}
                onClick={() => actions.setAutoSourceBoundary(source.id, source.boundary === 'inside' ? 'from' : 'inside')}
              >
                {source.boundary === 'inside' ? t('autoMode.source.inside') : t('autoMode.source.from')}
              </button>
              <button type="button" aria-label={t('autoMode.source.remove', { title: source.label })} onClick={() => actions.removeAutoSource(source.id)}>×</button>
            </div>
          )}</For>
        </Show>
      </div>
      <div class={styles.sourceBrowser}>
        <NowPlayingBrowser purpose="auto-source" onClose={() => props.onPanelChange('stage')} />
      </div>
    </section>
  );

  const Stage = (dragHandle: JSX.Element) => (
    <PlayerStage
      mode="auto"
      surfaceOpen={props.surfaceOpen}
      dragHandle={dragHandle}
      onOpenList={() => props.onPanelChange('route')}
      listActive={props.panel === 'route'}
      listLabel={t('autoMode.mobile.route')}
    />
  );
  const Route = (dragHandle: JSX.Element) => (
    <PlayerTrackList
      title={t('autoMode.dj.route')}
      count={routeEntries().length}
      empty={state.autoMode.sources.length ? t('autoMode.mobile.routeEmpty') : t('autoMode.source.routeEmpty')}
      dragHandle={dragHandle}
      sections={[{ id: 'route', entries: routeEntries() }]}
    />
  );

  return (
    <div class={styles.root} data-playing={state.playback.isPlaying ? 'true' : 'false'}>
      <PlayerWorkspace
        panels={AUTO_MODE_PANELS}
        activePanel={props.panel}
        onActivePanelChange={props.onPanelChange}
        onCarouselProgress={props.onCarouselProgress}
        surfaceOpen={props.surfaceOpen}
        layout={layout()}
        onLayoutChange={setLayoutPersisted}
        minimums={AUTO_MINIMUMS}
        defaults={DEFAULT_AUTO_MODE_LAYOUT.ratios}
        panelLabel={(panel) => t(`autoMode.panel.${panel}`)}
        ariaLabel={t('autoMode.workspace.aria')}
        dataScope="auto"
        layoutControl={<PlayerLayoutControl
          title={t('autoMode.workspace.layoutTitle')}
          ariaLabel={t('autoMode.workspace.changeLayout')}
          resetLabel={t('autoMode.workspace.resetLayout')}
          presets={[
            { id: 'balanced', label: t('autoMode.workspace.layoutBalanced') },
            { id: 'stage', label: t('autoMode.workspace.layoutStage') },
            { id: 'left', label: t('autoMode.source.title') },
            { id: 'right', label: t('autoMode.workspace.layoutRoute') },
          ]}
          onSelect={applyLayoutPreset}
          onReset={resetDesktopLayout}
        />}
        tileClass={styles.tile}
        renderPanel={(panel, dragHandle) => panel === 'browser' ? Browser(dragHandle) : panel === 'stage' ? Stage(dragHandle) : Route(dragHandle)}
      />
    </div>
  );
}

export { titleFit } from '../lib/titleFit';
