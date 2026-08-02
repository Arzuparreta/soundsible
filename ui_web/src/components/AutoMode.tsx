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
import { queueIdentity } from '../lib/queueDiscovery';
import { coverUrl } from '../lib/media';
import type { Track } from '../types/music';
import { t } from '../lib/i18n';
import { NowPlayingBrowser } from './NowPlayingBrowser';
import { openActionMenu } from './ActionMenu';
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
  const [destination, setDestination] = createSignal<{ kind: 'neutral' | 'source' | 'route'; beforeQueueId?: string }>({ kind: 'neutral' });
  const [carriedTrack, setCarriedTrack] = createSignal<Track | null>(null);

  const openDestination = (kind: 'source' | 'route', beforeQueueId?: string) => {
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
    const gap = (
      <button
        class={styles.routeGap}
        type="button"
        aria-label={t('autoMode.route.insertBefore', { title: track.title })}
        onClick={() => carriedTrack() ? placeInRoute(carriedTrack()!, track.queueId) : openDestination('route', track.queueId)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const transfer = readAutoTrackTransfer(event);
          if (!transfer) return;
          if (transfer.queueId) actions.moveAutoRoute(transfer.queueId, track.queueId);
          else placeInRoute(transfer.track, track.queueId);
        }}
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
      onCarry: () => setCarriedTrack(track),
      onDragOver: (event) => event.preventDefault(),
      onDrop: (event) => {
        event.preventDefault();
        const transfer = readAutoTrackTransfer(event);
        if (!transfer) return;
        if (transfer.queueId) actions.moveAutoRoute(transfer.queueId, track.queueId);
        else placeInRoute(transfer.track, track.queueId);
      },
      trailing: committed ? undefined : (
        <button
          class={styles.routeMenu}
          type="button"
          aria-label={t('autoMode.route.actions', { title: track.title })}
          onClick={() => openActionMenu({
            title: track.title,
            subtitle: track.artist,
            actions: [
              { label: t('autoMode.route.useAsSource'), onSelect: () => actions.useAutoTrackAsSource(track) },
              { label: t('autoMode.route.remove'), onSelect: () => actions.removeAutoRouteOccurrence(track.queueId) },
              { label: t('autoMode.route.avoidSession'), danger: true, onSelect: () => actions.avoidAutoTrackForSession(track.queueId) },
            ],
          })}
        >···</button>
      ),
    };
  }));

  const Browser = (dragHandle: JSX.Element) => (
    <section class={styles.sourcePanel}>
      <header class={styles.sourceHeader}>
        {dragHandle}
        <span><small>{t('autoMode.label')}</small><strong>{t('autoMode.source.title')}</strong></span>
        <button class={styles.sourceAdd} type="button" aria-label={t('autoMode.source.title')} aria-pressed={destination().kind === 'source'} onClick={() => openDestination('source')}>＋</button>
      </header>
      <div
        class={styles.sourceTray}
        data-target={destination().kind === 'source' || carriedTrack() ? '' : undefined}
        onClick={() => carriedTrack() && addToSources(carriedTrack()!)}
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
          purpose={destination().kind === 'source' ? 'auto-source' : destination().kind === 'route' ? 'auto-route' : 'auto-neutral'}
          routeBeforeQueueId={destination().beforeQueueId}
          onPlaced={() => finishDestination('route')}
          onSourceAdded={() => finishDestination('browser')}
          onCarryTrack={setCarriedTrack}
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
      onCarryTrack={setCarriedTrack}
    />
  );
  const Route = (dragHandle: JSX.Element) => (
    <PlayerTrackList
      title={t('autoMode.dj.route')}
      count={routeEntries().length}
      empty={state.autoMode.sources.length ? t('autoMode.mobile.routeEmpty') : t('autoMode.source.routeEmpty')}
      dragHandle={dragHandle}
      headAction={{ label: t('autoMode.route.add'), onClick: () => carriedTrack() ? placeInRoute(carriedTrack()!) : openDestination('route') }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const transfer = readAutoTrackTransfer(event);
        if (transfer) placeInRoute(transfer.track);
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
            <span><strong>{track().title}</strong><small>{track().artist}</small></span>
            <button type="button" aria-label={t('common.cancel')} onClick={() => setCarriedTrack(null)}>×</button>
          </div>
        )}
      </Show>
    </div>
  );
}

export { titleFit } from '../lib/titleFit';
