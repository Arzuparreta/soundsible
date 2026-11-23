import { ArtistLinks } from './MusicLinks';
import { playerTrackMusic } from '../lib/musicNavigation';
import { savedFromTrack } from '../lib/saved';
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { createActivityMemo } from '../lib/activityMemo';
import { playerCompact } from '../lib/playerDock';
import { pageVisible } from '../lib/pageVisibility';
import { player } from '../stores/player';
import {
  AUTO_MODE_LAYOUT_KEY,
  AUTO_MODE_PANELS,
  cloneAutoModeLayout,
  DEFAULT_AUTO_MODE_LAYOUT,
  parseAutoModeLayout,
  type AutoModeDesktopLayout,
  type AutoModePanelId,
} from '../lib/autoModeLayout';
import { readAutoTrackTransfer, writeAutoTrackTransfer } from '../lib/autoMusicTransfer';
import { dropBeforeId, isNoopMove } from '../lib/dragReorder';
import { editableFrom, routeRows } from '../lib/djRoute';
import { trackCoverUrl } from '../lib/media';
import type { Track } from '../types/music';
import { t } from '../lib/i18n';
import { beginDjErrand, endDjErrand, type DjErrandKind } from '../lib/djErrand';
import { desktopShell } from '../lib/shellLayout';
import { setNowPlayingOpen } from '../stores';
import { PlayerStage } from './PlayerStage';
import { PlayerMiniHeader } from './PlayerMiniHeader';
import { PlayerTrackList, type PlayerTrackListEntry } from './PlayerTrackList';
import { PlayerWorkspace } from './PlayerWorkspace';
import { AutoReferences } from './AutoReferences';
import { openMetadataEditor } from './MetadataEditor';
import { openPlaylistPicker } from './PlaylistPicker';
import { buildTrackMenu } from './trackActions';
import { SourceIcon, menuIcons } from './icons';
import styles from './AutoMode.module.css';

// As in Now Playing: the two minimums and their seam fit a 1024px window.
const AUTO_MINIMUMS = { stage: 330, route: 280 };

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
  surfaceOpen: boolean;
  panelsReady?: boolean;
}) {
  // The route mounts a frame after the stage, so opening DJ paints the song first.
  const [routeMounted, setRouteMounted] = createSignal(props.panelsReady ?? true);
  createEffect(() => {
    if (!props.panelsReady || routeMounted()) return;
    if (typeof requestAnimationFrame !== 'function') { setRouteMounted(true); return; }
    const frame = requestAnimationFrame(() => setRouteMounted(true));
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const [layout, setLayout] = createSignal(readLayout());
  const [carriedTrack, setCarriedTrack] = createSignal<CarriedTrack | null>(null);
  /**
   * Ask the listener for music: the next song or collection they play anywhere
   * in the app answers the errand (lib/djErrand). On a phone the sheet steps
   * aside so the app can be used, and comes back when the errand ends; on a
   * desktop the player is docked beside the app while it lasts.
   */
  const openErrand = (kind: DjErrandKind, beforeQueueId?: string) => {
    const sheet = !desktopShell();
    beginDjErrand({ kind, beforeQueueId }, (done) => {
      if (!player().autoMode.active) return;
      if (sheet) setNowPlayingOpen(true);
      if (done) props.onPanelChange('route');
    });
    if (sheet) setNowPlayingOpen(false);
  };
  // Leaving DJ leaves nothing to answer.
  onCleanup(() => endDjErrand(false));
  const placeInRoute = (track: Track, beforeQueueId?: string) => {
    void player().actions.placeAutoTrack(track, beforeQueueId);
    setCarriedTrack(null);
  };
  const placeCarriedInRoute = (beforeQueueId?: string) => {
    const carried = carriedTrack();
    if (!carried) return;
    if (carried.queueId) player().actions.moveAutoRoute(carried.queueId, beforeQueueId);
    else void player().actions.placeAutoTrack(carried.track, beforeQueueId);
    setCarriedTrack(null);
  };
  const addToSources = (track: Track) => {
    player().actions.useAutoTrackAsSource(track);
    setCarriedTrack(null);
  };

  const setLayoutPersisted = (next: AutoModeDesktopLayout) => {
    setLayout(next);
    try { localStorage.setItem(AUTO_MODE_LAYOUT_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  const panelActive = (panel: AutoModePanelId) => props.surfaceOpen && (props.panelsReady ?? true) && pageVisible()
    && (!playerCompact() || props.panel === panel);
  const routeActive = () => panelActive('route');
  const upcoming = createActivityMemo(
    routeActive,
    () => player().playback.queue.slice(Math.max(0, player().playback.index + 1)),
    [],
    () => [player().playback.queue, player().playback.index],
  );
  const firstEditable = createActivityMemo(routeActive, () => {
    const index = player().playback.index;
    const floor = player().autoMode.transition.status === 'idle' ? index : index + 1;
    return editableFrom(routeRows(player().playback.queue), index, floor);
  }, 0, () => [player().playback.queue, player().playback.index, player().autoMode.transition.status]);
  const staleSeams = createActivityMemo(
    routeActive,
    () => new Set(player().autoMode.staleSeams),
    new Set<string>(),
    () => [player().autoMode.staleSeams],
  );
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
  const routeEntries = createActivityMemo<PlayerTrackListEntry[]>(routeActive, () => upcoming().map((track, index) => {
    const committed = index === 0 && player().autoMode.transition.status !== 'idle';
    // Tapping a seam is the touch path: drops are handled by the list itself,
    // which can aim at the nearest seam instead of asking for a hit on this.
    const gap = (
      <button
        class={styles.routeGap}
        type="button"
        data-placement-active={carriedTrack() ? '' : undefined}
        aria-label={t('autoMode.route.insertBefore', { title: track.title })}
        onClick={() => carriedTrack() ? placeCarriedInRoute(track.queueId) : openErrand('route', track.queueId)}
      ><span>＋</span></button>
    );
    // A cued handoff is already loaded and mixing: taking it out of the route is
    // the one thing that no longer applies to it. The rest still does, and the
    // menu is reached the same way on every row — through its ⋯ button, by holding it, or by
    // right-clicking it with a pointer.
    //
    // Keeping a song the DJ found — saving it, downloading it, a playlist — is
    // the track menu's, and none of it touches the route: a finished download
    // never replaces the occurrence, so even the cued handoff can be kept.
    const menu = () => [
      { icon: menuIcons.source(), label: t('musicExplorer.reference'), onSelect: () => player().actions.useAutoTrackAsSource(track) },
      { icon: menuIcons.changeSession(), label: t('musicExplorer.startDjFromSong'), onSelect: () => void player().actions.startDjFromTrack(track) },
      ...buildTrackMenu(track, { music: playerTrackMusic(track), inRoute: true, onAddToPlaylist: openPlaylistPicker, onEditMetadata: openMetadataEditor }),
      ...(player().playback.index + index + 1 < firstEditable() ? [] : [{
        icon: menuIcons.remove(), label: t('autoMode.route.remove'), danger: true,
        onSelect: () => player().actions.removeAutoRouteOccurrence(track.queueId),
      }]),
    ];
    return {
      id: track.queueId,
      title: track.title,
      artist: track.artist,
      music: playerTrackMusic(track),
      cover: trackCoverUrl(track, 'thumb'),
      position: index + 1,
      // A committed handoff is loaded and cued: whatever the route did around
      // it, the blend it will actually play is the planned one. The row says so
      // with its own material rather than with a badge — no route row carries
      // one now, because on a 280px panel a label naming the session it came
      // from, the same session as the row above it, was taking the width of the
      // artist's name.
      locked: committed,
      // With the mixing off every join is a plain cut, planned or not: a
      // seam with no transition of its own is nothing to point out.
      stale: !committed && player().playback.djMixing && staleSeams().has(track.queueId),
      draggable: !committed,
      before: gap,
      onDragStart: (event) => writeAutoTrackTransfer(event, { track, queueId: track.queueId }),
      entry: savedFromTrack(track),
      onCarry: committed ? undefined : () => setCarriedTrack({ track, queueId: track.queueId }),
      menu,
    };
  }), [], () => [upcoming(), player().autoMode.transition.status, player().playback.djMixing, staleSeams()]);

  const mixPending = createMemo(() => routeEntries().some((entry) => entry.stale));
  const routeWaiting = createMemo(() => (
    routeEntries().length === 0
    && (player().autoMode.phase === 'planning' || player().autoMode.phase === 'warming' || player().autoMode.phase === 'degraded')
  ));

  const routeEmpty = () => (
    <Show
      when={routeWaiting()}
      fallback={player().autoMode.phase === 'exhausted'
        ? <div role="status"><p>{t('autoMode.route.exhausted')}</p><button type="button" onClick={() => player().actions.retryAutoRoute()}>{t('common.retry')}</button></div>
        : player().autoMode.sources.length ? t('autoMode.mobile.routeEmpty') : t('autoMode.source.routeEmpty')}
    >
      <div
        class={styles.routeLoading}
        data-route-loading={player().autoMode.phase}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span class={styles.routeLoadingMark} aria-hidden="true"><i /><i /><i /></span>
        <strong>
          {player().autoMode.phase === 'warming'
            ? t('autoMode.route.warming', { title: player().playback.currentTrack?.title ?? player().autoMode.sources[0]?.label ?? '' })
            : player().autoMode.phase === 'degraded'
            ? t('autoMode.route.retrying')
            : (() => {
                const current = player().playback.currentTrack;
                return current
                  ? t('autoMode.route.preparingFrom', { title: current.title })
                  : t('autoMode.route.preparing');
              })()}
        </strong>
        <span>
          {player().autoMode.phase === 'warming'
            ? t('autoMode.route.warmingHint')
            : player().autoMode.phase === 'degraded'
            ? t('autoMode.route.retryingHint')
            : player().playback.isPlaying
              ? t('autoMode.route.preparingWhilePlaying')
              : t('autoMode.route.preparingHint')}
        </span>
      </div>
    </Show>
  );

  /** The stage before the first song: the DJ choosing it, failing to and
   * trying again, or — with nothing at all to open from — asking for music. */
  const stageEmpty = () => (
    <div class={styles.stageOpening}>
      <Show
        when={player().autoMode.phase === 'planning' || player().autoMode.phase === 'warming' || player().autoMode.phase === 'degraded'}
        fallback={<>
          <p>{(() => {
            const activity = player().autoMode.activity;
            return activity?.status === 'error' ? t(activity.key) : t('nowPlaying.nothingPlaying');
          })()}</p>
          <button type="button" onClick={() => openErrand('reference')}>{t('musicExplorer.referenceEmpty')}</button>
        </>}
      >
        <div
          class={styles.routeLoading}
          data-route-loading={player().autoMode.phase}
          data-stage-opening=""
          role="status"
          aria-live="polite"
          aria-busy={player().autoMode.phase !== 'degraded'}
        >
          <span class={styles.routeLoadingMark} aria-hidden="true"><i /><i /><i /></span>
          <strong>{player().autoMode.phase === 'degraded' ? t('autoMode.agent.openingFailed') : t('autoMode.booth.opening')}</strong>
          <span>
            {player().autoMode.phase === 'degraded'
              ? t('autoMode.route.retryingHint')
              : player().autoMode.sources.length
                ? t('autoMode.source.added', { title: player().autoMode.sources[0].label })
                : t('autoMode.booth.openingHint')}
          </span>
        </div>
        <Show when={player().autoMode.phase === 'degraded'}>
          <button type="button" onClick={() => player().actions.retryAutoRoute()}>{t('common.retry')}</button>
        </Show>
      </Show>
    </div>
  );

  const Stage = () => (
    <PlayerStage
      mode="auto"
      surfaceOpen={props.surfaceOpen}
      onTrackDragStart={(event, track) => writeAutoTrackTransfer(event, { track })}
      onCarryTrack={(track) => setCarriedTrack({ track })}
      empty={stageEmpty()}
    />
  );
  const Route = () => (
    <section class={styles.routePanel}>
      <Show when={playerCompact()}>
        <PlayerMiniHeader mode="auto" onBack={() => props.onPanelChange('stage')} />
      </Show>
      <div class={styles.routeList}><PlayerTrackList
      title={t('autoMode.dj.route')}
      count={routeEntries().length}
      empty={routeEmpty()}
      placing={Boolean(carriedTrack())}
      headAction={[
        // Fix mix rebuilds transitions and the bridges that carry them. With
        // the mixing off there are none to hear, so there is nothing to fix.
        // Intentionally keeps the same understated header action weight as Add;
        // the tooltip explains when stale seams are waiting.
        ...(player().playback.djMixing ? [{
          label: player().autoMode.repairing ? t('autoMode.route.fixing') : t('autoMode.route.fix'),
          title: mixPending() ? t('autoMode.route.mixPending') : t('autoMode.route.fixHint'),
          disabled: player().autoMode.repairing
            || player().autoMode.pendingDirection
            || routeEntries().filter((entry) => !entry.locked).length < 2,
          onClick: () => void player().actions.repairAutoRoute(),
        }] : []),
        {
          label: t('autoMode.route.add'),
          onClick: () => carriedTrack() ? placeCarriedInRoute() : openErrand('route'),
        },
      ]}
      onDrop={(event) => {
        const transfer = readAutoTrackTransfer(event);
        if (!transfer) return;
        // The header means "at the end". A row that is already in the route
        // moves there rather than being copied into a second occurrence of
        // itself, which is what dropping short of a seam used to earn.
        if (transfer.queueId) player().actions.moveAutoRoute(transfer.queueId);
        else placeInRoute(transfer.track);
      }}
      onReorder={(queueId, slot) => {
        // Dropping a row back where it already sits would still re-stamp it as
        // fixed and throw away the transition it was planned with — a plain
        // fade earned by changing nothing.
        if (isNoopMove(routeBlock(queueId), slot)) return;
        player().actions.moveAutoRoute(queueId, dropBeforeId(upcoming().map((entry) => entry.queueId), slot));
      }}
      onDropAtSlot={(slot, event) => {
        const transfer = readAutoTrackTransfer(event);
        if (transfer) placeInRoute(transfer.track, dropBeforeId(upcoming().map((entry) => entry.queueId), slot));
      }}
      sections={[{ id: 'route', entries: routeEntries() }]}
    /></div><AutoReferences carried={carriedTrack()?.track} onUse={addToSources} onAdd={() => openErrand('reference')} onChange={() => openErrand('change')} /></section>
  );

  return (
    <div class={styles.root} data-playing={player().playback.isPlaying ? 'true' : 'false'}>
      <PlayerWorkspace
        panels={AUTO_MODE_PANELS}
        activePanel={props.panel}
        onActivePanelChange={props.onPanelChange}
        surfaceOpen={props.surfaceOpen}
        layout={layout()}
        onLayoutChange={setLayoutPersisted}
        minimums={AUTO_MINIMUMS}
        defaults={DEFAULT_AUTO_MODE_LAYOUT.ratios}
        panelLabel={(panel) => t(`autoMode.panel.${panel}`)}
        ariaLabel={t('autoMode.workspace.aria')}
        dataScope="auto"
        renderPanel={(panel) => panel === 'stage'
          ? Stage()
          : <Show when={routeMounted()}>{Route()}</Show>}
      />
      <Show when={carriedTrack()}>
        {(track) => (
          <div class={styles.carry} role="status">
            <span><strong>{track().track.title}</strong><small><ArtistLinks music={playerTrackMusic(track().track)} /></small></span>
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

export { titleFit } from '../lib/titleFit';
