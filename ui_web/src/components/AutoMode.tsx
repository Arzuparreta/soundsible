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
import { readAutoTrackTransfer, writeAutoTrackTransfer } from '../lib/autoMusicTransfer';
import { isNoopMove } from '../lib/dragReorder';
import { queueIdentity } from '../lib/queueDiscovery';
import { coverUrl } from '../lib/media';
import type { Track } from '../types/music';
import { t } from '../lib/i18n';
import { NowPlayingBrowser } from './NowPlayingBrowser';
import { PlayerLayoutControl } from './PlayerLayoutControl';
import { PlayerStage } from './PlayerStage';
import { PlayerTrackList, type PlayerTrackListEntry } from './PlayerTrackList';
import { PlayerWorkspace } from './PlayerWorkspace';
import styles from './AutoMode.module.css';

const AUTO_MINIMUMS = { browser: 280, stage: 390, route: 280 };

type CarriedTrack = {
  track: Track;
  queueId?: string;
};

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
  // Aiming at a seam is the only mode left. Picking sources used to be one too,
  // and it was a mode with no visible state: its whole payload was deferred
  // until you happened to navigate into a collection, so pressing the button
  // that armed it looked like pressing nothing.
  const [destination, setDestination] = createSignal<{ kind: 'neutral' | 'route'; beforeQueueId?: string }>({ kind: 'neutral' });
  const [carriedTrack, setCarriedTrack] = createSignal<CarriedTrack | null>(null);

  const openDestination = (kind: 'route', beforeQueueId?: string) => {
    setDestination({ kind, beforeQueueId });
    props.onPanelChange('browser');
  };
  const finishDestination = (panel: AutoModePanelId) => {
    setDestination({ kind: 'neutral' });
    props.onPanelChange(panel);
  };
  const placeInRoute = (track: Track, beforeQueueId?: string) => {
    void actions.placeAutoTrack(track, beforeQueueId);
    setCarriedTrack(null);
  };
  const placeCarriedInRoute = (beforeQueueId?: string) => {
    const carried = carriedTrack();
    if (!carried) return;
    if (carried.queueId) actions.moveAutoRoute(carried.queueId, beforeQueueId);
    else void actions.placeAutoTrack(carried.track, beforeQueueId);
    setCarriedTrack(null);
  };
  const addToSources = (track: Track) => {
    actions.useAutoTrackAsSource(track);
    setCarriedTrack(null);
  };

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
    const plan = state.autoMode.plan[track.queueId];
    const committed = index === 0 && state.autoMode.transition.status !== 'idle';
    const userPlaced = track.autoRoute?.kind === 'user';
    const bridge = track.autoRoute?.kind === 'bridge';
    const source = state.autoMode.sources.find((item) => item.tracks.some((candidate) => (
      queueIdentity(candidate) === queueIdentity(track)
    )));
    // Tapping a seam is the touch path: drops are handled by the list itself,
    // which can aim at the nearest seam instead of asking for a hit on this.
    const gap = (
      <button
        class={styles.routeGap}
        type="button"
        data-placement-active={carriedTrack() ? '' : undefined}
        aria-label={t('autoMode.route.insertBefore', { title: track.title })}
        onClick={() => carriedTrack() ? placeCarriedInRoute(track.queueId) : openDestination('route', track.queueId)}
      ><span>＋</span></button>
    );
    return {
      id: track.queueId,
      title: track.title,
      artist: track.artist,
      cover: track.cover ?? coverUrl(track.id),
      position: index + 1,
      locked: committed,
      draggable: !committed,
      annotation: source ? t('autoMode.source.title') : plan?.sourceSetLabel,
      badge: committed
        ? t('autoMode.dj.cued')
        : userPlaced
          ? track.autoRoute?.placement === 'fixed' ? t('autoMode.route.fixed') : t('autoMode.route.placed')
          : bridge ? t('autoMode.route.bridge') : undefined,
      before: gap,
      onDragStart: (event) => writeAutoTrackTransfer(event, { track, queueId: track.queueId }),
      onCarry: () => setCarriedTrack({ track, queueId: track.queueId }),
      // Two things worth doing to a queued song, both one press away. Removing
      // carries the stronger reading — "and don't bring it back" — on its toast.
      trailing: committed ? undefined : (
        <>
          <button
            class={styles.routeAction}
            type="button"
            aria-label={t('autoMode.route.useAsSource')}
            title={t('autoMode.route.useAsSource')}
            onClick={() => actions.useAutoTrackAsSource(track)}
          ><SourceIcon /></button>
          <button
            class={styles.routeAction}
            type="button"
            aria-label={t('autoMode.route.remove')}
            title={t('autoMode.route.remove')}
            onClick={() => actions.removeAutoRouteOccurrence(track.queueId)}
          ><RemoveIcon /></button>
        </>
      ),
    };
  }));

  const Browser = (dragHandle: JSX.Element) => (
    <section class={styles.sourcePanel}>
      <header class={styles.sourceHeader}>
        {dragHandle}
        <span><small>{t('autoMode.label')}</small><strong>{t('autoMode.source.title')}</strong></span>
      </header>
      <div
        class={styles.sourceTray}
        data-target={carriedTrack() ? '' : undefined}
        onClick={() => carriedTrack() && addToSources(carriedTrack()!.track)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const transfer = readAutoTrackTransfer(event);
          if (transfer) addToSources(transfer.track);
        }}
      >
        <Show when={state.autoMode.sources.length} fallback={
          <p class={styles.sourceEmpty}>{t('autoMode.source.empty')}</p>
        }>
          <For each={state.autoMode.sources}>{(source) => (
            <div
              class={styles.sourceChip}
              data-route-target={destination().kind === 'route' && source.tracks.length === 1 ? '' : undefined}
              draggable={source.tracks.length === 1}
              onDragStart={(event) => source.tracks[0] && writeAutoTrackTransfer(event, { track: source.tracks[0] })}
              onClick={() => {
                if (destination().kind !== 'route' || source.tracks.length !== 1) return;
                placeInRoute(source.tracks[0], destination().beforeQueueId);
                finishDestination('route');
              }}
            >
              <span><strong>{source.label}</strong><small>{source.tracks.length}</small></span>
              <button type="button" aria-label={t('autoMode.source.remove', { title: source.label })} onClick={(event) => { event.stopPropagation(); actions.removeAutoSource(source.id); }}>×</button>
            </div>
          )}</For>
        </Show>
      </div>
      <div class={styles.sourceBrowser}>
        <NowPlayingBrowser
          purpose={destination().kind === 'route' ? 'auto-route' : 'auto-neutral'}
          routeBeforeQueueId={destination().beforeQueueId}
          onPlaced={() => finishDestination('route')}
          onCarryTrack={(track) => setCarriedTrack({ track })}
          onClose={() => finishDestination('stage')}
        />
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
      onTrackDragStart={(event, track) => writeAutoTrackTransfer(event, { track })}
      onCarryTrack={(track) => setCarriedTrack({ track })}
    />
  );
  const Route = (dragHandle: JSX.Element) => (
    <PlayerTrackList
      title={t('autoMode.dj.route')}
      count={routeEntries().length}
      empty={state.autoMode.sources.length ? t('autoMode.mobile.routeEmpty') : t('autoMode.source.routeEmpty')}
      dragHandle={dragHandle}
      placing={Boolean(carriedTrack())}
      headAction={[
        {
          label: state.autoMode.repairing ? t('autoMode.route.fixing') : t('autoMode.route.fix'),
          title: t('autoMode.route.fixHint'),
          disabled: state.autoMode.repairing
            || state.autoMode.pendingDirection
            || routeEntries().filter((entry) => !entry.locked).length < 2,
          onClick: () => void actions.repairAutoRoute(),
        },
        {
          label: t('autoMode.route.add'),
          onClick: () => carriedTrack() ? placeCarriedInRoute() : openDestination('route'),
        },
      ]}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const transfer = readAutoTrackTransfer(event);
        if (transfer) placeInRoute(transfer.track);
      }}
      onDropAtSlot={(slot, event) => {
        const transfer = readAutoTrackTransfer(event);
        if (!transfer) return;
        if (!transfer.queueId) {
          placeInRoute(transfer.track, slot.beforeId);
          return;
        }
        // Dropping a row back where it already sits would still re-stamp it as
        // fixed and throw away the transition it was planned with — a plain
        // fade earned by changing nothing.
        if (isNoopMove(upcoming().map((entry) => entry.queueId), transfer.queueId, slot)) return;
        actions.moveAutoRoute(transfer.queueId, slot.beforeId);
      }}
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
      <Show when={carriedTrack()}>
        {(track) => (
          <div class={styles.carry} role="status">
            <span><strong>{track().track.title}</strong><small>{track().track.artist}</small></span>
            <button type="button" aria-label={t('common.cancel')} onClick={() => setCarriedTrack(null)}>×</button>
          </div>
        )}
      </Show>
    </div>
  );
}

const routeIcon = (path: JSX.Element) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{path}</svg>
);
/** Take the session in this song's direction. */
const SourceIcon = () => routeIcon(<><circle cx="12" cy="12" r="1.6" /><path d="M12 4a8 8 0 0 1 8 8M12 20a8 8 0 0 1-8-8" /></>);
const RemoveIcon = () => routeIcon(<path d="m7 7 10 10M17 7 7 17" />);

export { titleFit } from '../lib/titleFit';
