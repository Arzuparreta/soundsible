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
import { autoTrackDragging, readAutoTrackTransfer, writeAutoTrackTransfer } from '../lib/autoMusicTransfer';
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
import { SourceIcon } from './icons';
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
  const [trayOver, setTrayOver] = createSignal(false);
  let trayDepth = 0;
  // Something is in the air and the tray can take it. Saying so the instant a
  // drag begins is the whole difference between a gesture and a secret.
  const trayArmed = createMemo(() => Boolean(autoTrackDragging() || carriedTrack()));

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
  const staleSeams = createMemo(() => new Set(state.autoMode.staleSeams));
  /** The rows that travel together. A bridge exists only to reach the song it
   * leads into, so aiming at either of them describes the same block. */
  const routeBlock = (queueId: string): string[] => {
    const entry = upcoming().find((row) => row.queueId === queueId);
    const ownerId = entry?.autoRoute?.kind === 'bridge' && entry.autoRoute.ownerQueueId
      ? entry.autoRoute.ownerQueueId
      : queueId;
    const block = upcoming()
      .filter((row) => row.queueId === ownerId
        || (row.autoRoute?.kind === 'bridge' && row.autoRoute.ownerQueueId === ownerId))
      .map((row) => row.queueId);
    return block.length ? block : [queueId];
  };
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
      // A committed handoff is loaded and cued: whatever the route did around
      // it, the blend it will actually play is the planned one.
      stale: !committed && staleSeams().has(track.queueId),
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

  const mixPending = createMemo(() => routeEntries().some((entry) => entry.stale));

  const Browser = (dragHandle: JSX.Element) => (
    <section class={styles.sourcePanel}>
      <header class={styles.sourceHeader}>
        {dragHandle}
        <span><small>{t('autoMode.label')}</small><strong>{t('autoMode.source.title')}</strong></span>
      </header>
      <div
        class={styles.sourceTray}
        data-target={trayArmed() ? '' : undefined}
        data-over={trayOver() ? '' : undefined}
        onClick={() => carriedTrack() && addToSources(carriedTrack()!.track)}
        // `dragleave` fires for every child the pointer crosses, so only a
        // matched count of them means the drag has actually left the tray.
        onDragEnter={() => { trayDepth += 1; setTrayOver(true); }}
        onDragLeave={() => {
          trayDepth = Math.max(0, trayDepth - 1);
          if (!trayDepth) setTrayOver(false);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          // A source is a copy: the song keeps its place in the route.
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          event.preventDefault();
          trayDepth = 0;
          setTrayOver(false);
          const transfer = readAutoTrackTransfer(event);
          if (transfer) addToSources(transfer.track);
        }}
      >
        <Show when={state.autoMode.sources.length} fallback={
          <p class={styles.sourceEmpty}>{trayArmed() ? t('autoMode.source.add') : t('autoMode.source.empty')}</p>
        }>
          <Show when={trayArmed()}>
            <p class={styles.sourceHint}>{t('autoMode.source.add')}</p>
          </Show>
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
          // Reordering opens joins the DJ never chose. The button says so
          // rather than waiting for a plain fade to announce it on arrival.
          title: mixPending() ? t('autoMode.route.mixPending') : t('autoMode.route.fixHint'),
          pending: mixPending(),
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
        if (!transfer) return;
        // The header means "at the end". A row that is already in the route
        // moves there rather than being copied into a second occurrence of
        // itself, which is what dropping short of a seam used to earn.
        if (transfer.queueId) actions.moveAutoRoute(transfer.queueId);
        else placeInRoute(transfer.track);
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
        if (isNoopMove(upcoming().map((entry) => entry.queueId), routeBlock(transfer.queueId), slot)) return;
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
            {/* On a phone the panels are a carousel with the inactive ones
              * inert, so a song can never be dragged from the route to the
              * tray. Carrying it here is that gesture, and this is where it
              * lands without making anyone swipe panels to find the target. */}
            <button
              class={styles.carrySource}
              type="button"
              aria-label={t('autoMode.route.useAsSource')}
              title={t('autoMode.route.useAsSource')}
              onClick={() => addToSources(track().track)}
            ><SourceIcon /></button>
            <button type="button" aria-label={t('common.cancel')} onClick={() => setCarriedTrack(null)}>×</button>
          </div>
        )}
      </Show>
    </div>
  );
}

const RemoveIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m7 7 10 10M17 7 7 17" />
  </svg>
);

export { titleFit } from '../lib/titleFit';
