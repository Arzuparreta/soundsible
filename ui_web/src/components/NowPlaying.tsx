import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { state, actions, isSavedTrack } from '../stores';
import { coverUrl } from '../lib/media';
import { openTrackMenu } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { artistPath } from '../lib/artistRoute';
import { isPodcastTrack } from '../lib/track';
import { savedFromTrack } from '../lib/saved';
import { FavouriteButton } from './FavouriteButton';
import { CollectionButton } from './CollectionButton';
import { t as tr } from '../lib/i18n';
import { NowPlayingBrowser, browserOpen, closeBrowser } from './NowPlayingBrowser';
import { RadioBadge, onStopRadio } from './RadioBadge';
import { Spinner } from './Spinner';
import { LyricsPanel } from './LyricsPanel';
import { openActionMenu } from './ActionMenu';
import { buildTrackMenu } from './trackActions';
import {
  DEFAULT_NOW_PLAYING_LAYOUT,
  movePanel,
  NOW_PLAYING_LAYOUT_KEY,
  parseNowPlayingLayout,
  reorderPanel,
  resizeAdjacentPanels,
  type NowPlayingPanelId,
} from '../lib/nowPlayingLayout';
import styles from './NowPlaying.module.css';
import { clockTime } from '../lib/format';
import type { PlaybackQueueEntry } from '../lib/playbackQueue';
import {
  initialMobileVisualState,
  toggleMobileLyrics,
} from '../lib/nowPlayingMobileVisual';

export type NowPlayingMobilePanel = 'browser' | 'stage' | 'queue';

export function NowPlaying(props: {
  mobilePanel: NowPlayingMobilePanel;
  onMobilePanelChange: (panel: NowPlayingMobilePanel) => void;
  surfaceOpen: boolean;
  onCloseSurface?: () => void;
}) {
  const navigate = useNavigate();
  const t = createMemo(() => state.playback.currentTrack);
  const isPodcast = createMemo(() => {
    const c = t();
    return !!c && isPodcastTrack(c);
  });
  const loading = createMemo(() => state.playback.isLoading);
  const loadFailed = createMemo(() => state.playback.loadError);
  const [mobileVisual, setMobileVisual] = createSignal(initialMobileVisualState);
  let dragFrom: number | null = null;
  let bodyEl: HTMLDivElement | undefined;
  let desktopQueueEl: HTMLDivElement | undefined;
  let rootEl: HTMLElement | undefined;
  let workspaceEl: HTMLDivElement | undefined;
  const [mobileLayout, setMobileLayout] = createSignal(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches,
  );
  const [desktopLayout, setDesktopLayout] = createSignal(
    parseNowPlayingLayout(localStorage.getItem(NOW_PLAYING_LAYOUT_KEY), localStorage.getItem('np:panelSide')),
  );
  const [desktopLyrics, setDesktopLyrics] = createSignal(
    localStorage.getItem('np:desktopLyrics') === 'open' || localStorage.getItem('np:panelTab') === 'lyrics',
  );
  const [layoutBusy, setLayoutBusy] = createSignal(false);
  const desktopLyricsActive = createMemo(() => desktopLyrics() && !isPodcast());
  const visiblePanels = createMemo(() =>
    desktopLayout().order.filter((panel) => panel !== 'browser' || browserOpen()),
  );
  const renderedPanels = createMemo<NowPlayingPanelId[]>(() =>
    mobileLayout() ? ['browser', 'stage', 'queue'] : visiblePanels(),
  );
  const panelMinimum: Record<NowPlayingPanelId, number> = { browser: 240, stage: 360, queue: 220 };
  const gridColumns = createMemo(() =>
    renderedPanels().flatMap((panel, index) => [
      `minmax(${panelMinimum[panel]}px, ${desktopLayout().ratios[panel]}fr)`,
      ...(index < renderedPanels().length - 1 ? ['14px'] : []),
    ]).join(' '),
  );

  createEffect(() => {
    try {
      localStorage.setItem(NOW_PLAYING_LAYOUT_KEY, JSON.stringify(desktopLayout()));
    } catch {
      /* storage disabled/full */
    }
  });
  // Always (re)open on the player panel with every scroll surface reset.
  createEffect(() => {
    if (!props.surfaceOpen) {
      setMobileVisual(initialMobileVisualState);
      return;
    }
    if (bodyEl) bodyEl.scrollTop = 0;
    if (desktopQueueEl) desktopQueueEl.scrollTop = 0;
  });

  createEffect(() => {
    if (isPodcast() || state.autoMode.active) setMobileVisual(initialMobileVisualState);
  });

  let requestedMobilePanel: NowPlayingMobilePanel | null = null;
  let carouselFrame = 0;
  let previousSurfaceOpen = props.surfaceOpen;
  createEffect(() => {
    const surfaceOpen = props.surfaceOpen;
    const opening = surfaceOpen && !previousSurfaceOpen;
    previousSurfaceOpen = surfaceOpen;
    const panel = surfaceOpen ? props.mobilePanel : 'stage';
    if (!mobileLayout() || !workspaceEl) return;
    const tile = workspaceEl.querySelector<HTMLElement>(`[data-now-playing-tile="${panel}"]`);
    if (!tile) return;
    requestedMobilePanel = panel;
    if (!surfaceOpen) cancelAnimationFrame(carouselFrame);
    requestAnimationFrame(() => {
      workspaceEl?.scrollTo({
        left: tile.offsetLeft,
        behavior: !surfaceOpen || opening ? 'auto' : 'smooth',
      });
    });
  });

  const onCarouselScroll = () => {
    if (!props.surfaceOpen || !mobileLayout() || !workspaceEl) return;
    cancelAnimationFrame(carouselFrame);
    carouselFrame = requestAnimationFrame(() => {
      if (!workspaceEl) return;
      const panels = [...workspaceEl.querySelectorAll<HTMLElement>('[data-now-playing-tile]')];
      if (requestedMobilePanel) {
        const requested = panels.find((element) => element.dataset.nowPlayingTile === requestedMobilePanel);
        if (requested && Math.abs(requested.offsetLeft - workspaceEl.scrollLeft) <= 2) requestedMobilePanel = null;
        else return;
      }
      const nearest = panels.reduce<{ panel: NowPlayingMobilePanel; distance: number } | null>((best, element) => {
        const panel = element.dataset.nowPlayingTile as NowPlayingMobilePanel;
        const distance = Math.abs(element.offsetLeft - workspaceEl!.scrollLeft);
        return !best || distance < best.distance ? { panel, distance } : best;
      }, null);
      if (nearest && nearest.panel !== props.mobilePanel) props.onMobilePanelChange(nearest.panel);
    });
  };

  onMount(() => {
    const media = window.matchMedia('(max-width: 1023px)');
    const syncLayout = () => setMobileLayout(media.matches);
    media.addEventListener('change', syncLayout);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && desktopLyricsActive()) {
        event.preventDefault();
        toggleDesktopLyrics();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      media.removeEventListener('change', syncLayout);
      window.removeEventListener('keydown', onKeyDown);
      cancelAnimationFrame(carouselFrame);
    });
  });
  /** Library tracks link to their artist; preview/podcast sources do not. */
  const artistLinkable = createMemo(() => {
    const c = t();
    return !!c && c.source !== 'preview' && !!c.artist;
  });
  const goArtist = () => {
    const c = t();
    if (!c?.artist) return;
    props.onCloseSurface?.();
    navigate(artistPath(c.artist, { view: c.source === 'preview' ? 'discover' : 'library' }));
  };

  const artBg = (): JSX.CSSProperties => {
    const c = t();
    const url = c ? (c.cover ?? coverUrl(c.id)) : '';
    return url
      ? { background: `url("${url}") center / cover no-repeat, var(--bg-raised)` }
      : { background: 'var(--bg-raised)' };
  };

  const seekPct = () => {
    const d = state.playback.duration;
    return d > 0 ? Math.min(100, (state.playback.currentTime / d) * 100) : 0;
  };
  const volPct = () => Math.round((state.playback.muted ? 0 : state.playback.volume) * 100);
  const [contextExpanded, setContextExpanded] = createSignal(false);
  const [generatedExpanded, setGeneratedExpanded] = createSignal(false);
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
  const visibleContextQueue = createMemo(() => contextExpanded() ? contextQueue() : contextQueue().slice(0, 5));
  const visibleGeneratedQueue = createMemo(() => generatedExpanded() ? generatedQueue() : generatedQueue().slice(0, 3));

  const QueueRow = (props: { entry: PlaybackQueueEntry; current?: boolean; ordinal?: number }) => {
    const queueIndex = () => state.playback.queue.findIndex((entry) => entry.queueId === props.entry.queueId);
    return (
      <div
        classList={{ [styles.qRow]: true, [styles.qActive]: !!props.current }}
        draggable={!props.current}
        onDragStart={(e) => {
          dragFrom = queueIndex();
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!props.current) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          const to = queueIndex();
          if (dragFrom != null && dragFrom !== to) actions.moveInQueue(dragFrom, to);
          dragFrom = null;
        }}
      >
        <Show when={!props.current} fallback={<span class={styles.qHandle} aria-hidden="true" />}>
          <span class={styles.qHandle} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
              <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
              <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
            </svg>
          </span>
        </Show>
        <button
          class={styles.qPlay}
          type="button"
          disabled={props.current}
          onClick={() => actions.playQueueEntry(props.entry.queueId)}
        >
          <span class={styles.qIndex}>
            <Show when={props.current} fallback={<>{props.ordinal ?? ''}</>}>
              <span class={styles.eq} data-paused={state.playback.isPlaying ? undefined : ''} aria-hidden="true">
                <i /><i /><i />
              </span>
            </Show>
          </span>
          <span class={styles.qMeta}>
            <span class={styles.qTitle}>{props.entry.title}</span>
            <span class={styles.qArtist}>{props.entry.artist}</span>
          </span>
        </button>
        <Show when={!props.current}>
          <button
            class={styles.qRemove}
            type="button"
            aria-label={tr('nowPlaying.removeFromQueue')}
            onClick={() => actions.removeQueueEntry(props.entry.queueId)}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </Show>
      </div>
    );
  };

  const QueueSection = (props: {
    label: string;
    entries: PlaybackQueueEntry[];
    total: number;
    expanded?: boolean;
    toggle?: () => void;
  }) => (
    <Show when={props.total > 0}>
      <section class={styles.queueSection}>
        <div class={styles.queueSectionHead}>
          <span>{props.label}</span>
          <span class={styles.queueSectionCount}>{props.total}</span>
        </div>
        <For each={props.entries}>
          {(entry, index) => <QueueRow entry={entry} ordinal={index() + 1} />}
        </For>
        <Show when={props.toggle && props.total > props.entries.length || (props.toggle && props.expanded)}>
          <button class={styles.queueExpand} type="button" onClick={props.toggle}>
            {props.expanded ? tr('nowPlaying.showLess') : tr('nowPlaying.showAll', { count: props.total })}
          </button>
        </Show>
      </section>
    </Show>
  );

  const QueueList = (props: { className: string; setRef: (el: HTMLDivElement) => void; dragHandle?: JSX.Element }) => (
    <div class={`${styles.queue} ${props.className}`}>
      <div class={styles.queueHead}>
        <span class={styles.queueHeading}>
          {props.dragHandle}
          <h2 class={styles.queueTitle}>{tr('nowPlaying.queue')}</h2>
          <span class={styles.queueCount}>
            {1 + manualQueue().length + contextQueue().length + generatedQueue().length}
          </span>
        </span>
        <button
          class={styles.queueClear}
          type="button"
          disabled={manualQueue().length === 0}
          onClick={() => actions.clearManualQueue()}
        >
          {tr('nowPlaying.clearManualQueue')}
        </button>
      </div>
      <div class={styles.queueRows} ref={props.setRef}>
        <Show when={currentQueueEntry()}>
          {(entry) => (
            <section class={styles.queueSection}>
              <div class={styles.queueSectionHead}>{tr('nowPlaying.nowPlayingSection')}</div>
              <QueueRow entry={entry()} current />
            </section>
          )}
        </Show>
        <QueueSection
          label={tr('nowPlaying.manualQueue')}
          entries={manualQueue()}
          total={manualQueue().length}
        />
        <QueueSection
          label={contextQueue()[0]?.queueContext?.label || tr('nowPlaying.contextQueue')}
          entries={visibleContextQueue()}
          total={contextQueue().length}
          expanded={contextExpanded()}
          toggle={() => setContextExpanded((value) => !value)}
        />
        <QueueSection
          label={state.playback.radioMode
            ? tr('nowPlaying.radioQueue')
            : state.autoMode.active
              ? tr('nowPlaying.autoQueue')
              : tr('nowPlaying.autoplayQueue')}
          entries={visibleGeneratedQueue()}
          total={generatedQueue().length}
          expanded={generatedExpanded()}
          toggle={() => setGeneratedExpanded((value) => !value)}
        />
        <Show when={manualQueue().length + contextQueue().length + generatedQueue().length === 0}>
          <p class={styles.queueEmpty}>{tr('nowPlaying.queueEmpty')}</p>
        </Show>
      </div>
    </div>
  );

  const animateRects = (before: Map<Element, DOMRect>, selector: string) => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    requestAnimationFrame(() => {
      for (const element of rootEl?.querySelectorAll<HTMLElement>(selector) ?? []) {
        const first = before.get(element);
        const last = element.getBoundingClientRect();
        if (!first || !last.width || !last.height) continue;
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        const sx = first.width / last.width;
        const sy = first.height / last.height;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
        element.animate(
          [
            { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
            { transformOrigin: 'top left', transform: 'none' },
          ],
          { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
      }
    });
  };

  const captureRects = (selector: string) =>
    new Map(
      [...(rootEl?.querySelectorAll<HTMLElement>(selector) ?? [])]
        .map((element) => [element, element.getBoundingClientRect()] as const),
    );

  const updateLayout = (next: () => void) => {
    const before = captureRects('[data-now-playing-tile]');
    next();
    animateRects(before, '[data-now-playing-tile]');
  };

  const changePanelOrder = (panel: NowPlayingPanelId, target: number) =>
    updateLayout(() => setDesktopLayout((layout) => ({
      ...layout,
      order: reorderPanel(layout.order, panel, target),
    })));

  let draggedPanel: NowPlayingPanelId | null = null;
  const PanelGrip = (props: { panel: NowPlayingPanelId }) => (
    <button
      class={styles.panelGrip}
      type="button"
      draggable
      aria-label={tr('nowPlaying.movePanel', { panel: props.panel })}
      title={tr('nowPlaying.movePanel', { panel: props.panel })}
      onDragStart={(event) => {
        draggedPanel = props.panel;
        event.dataTransfer?.setData('text/plain', props.panel);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => { draggedPanel = null; }}
      onClick={() => {
        const index = desktopLayout().order.indexOf(props.panel);
        openActionMenu({
          title: tr('nowPlaying.layoutPanel'),
          actions: [
            {
              label: tr('nowPlaying.movePanelLeft'),
              disabled: index <= 0,
              onSelect: () => updateLayout(() => setDesktopLayout((layout) => ({
                ...layout,
                order: movePanel(layout.order, props.panel, -1),
              }))),
            },
            {
              label: tr('nowPlaying.movePanelRight'),
              disabled: index >= 2,
              onSelect: () => updateLayout(() => setDesktopLayout((layout) => ({
                ...layout,
                order: movePanel(layout.order, props.panel, 1),
              }))),
            },
            {
              label: tr('nowPlaying.resetLayout'),
              onSelect: () => updateLayout(() => setDesktopLayout({
                ...DEFAULT_NOW_PLAYING_LAYOUT,
                order: [...DEFAULT_NOW_PLAYING_LAYOUT.order],
                ratios: { ...DEFAULT_NOW_PLAYING_LAYOUT.ratios },
              })),
            },
          ],
        });
      }}
    >
      <i /><i /><i /><i /><i /><i />
    </button>
  );

  const Tile = (props: { panel: NowPlayingPanelId; children: JSX.Element }) => (
    <section
      class={styles.tile}
      data-now-playing-tile={props.panel}
      onDragOver={(event) => {
        if (draggedPanel && draggedPanel !== props.panel) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const panel = draggedPanel;
        draggedPanel = null;
        if (!panel || panel === props.panel) return;
        changePanelOrder(panel, renderedPanels().indexOf(props.panel));
      }}
    >
      {props.children}
    </section>
  );

  const Splitter = (props: { left: NowPlayingPanelId; right: NowPlayingPanelId }) => {
    let startX = 0;
    let startRatios = desktopLayout().ratios;
    let width = 1;
    let activePointer: number | null = null;
    return (
      <div
        class={styles.splitter}
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label={tr('nowPlaying.resizePanels')}
        onDblClick={() => updateLayout(() => setDesktopLayout((layout) => ({
          ...layout,
          ratios: { ...DEFAULT_NOW_PLAYING_LAYOUT.ratios },
        })))}
        onPointerDown={(event) => {
          if (layoutBusy()) return;
          activePointer = event.pointerId;
          startX = event.clientX;
          startRatios = { ...desktopLayout().ratios };
          width = workspaceEl?.clientWidth || 1;
          event.currentTarget.setPointerCapture(event.pointerId);
          setLayoutBusy(true);
        }}
        onPointerMove={(event) => {
          if (activePointer !== event.pointerId) return;
          const minimums = {
            [props.left]: panelMinimum[props.left] / width,
            [props.right]: panelMinimum[props.right] / width,
          };
          setDesktopLayout((layout) => ({
            ...layout,
            ratios: resizeAdjacentPanels(startRatios, props.left, props.right, (event.clientX - startX) / width, minimums),
          }));
        }}
        onPointerUp={(event) => {
          if (activePointer !== event.pointerId) return;
          activePointer = null;
          setLayoutBusy(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const direction = event.key === 'ArrowLeft' ? -0.02 : 0.02;
          const containerWidth = workspaceEl?.clientWidth || 1;
          setDesktopLayout((layout) => ({
            ...layout,
            ratios: resizeAdjacentPanels(layout.ratios, props.left, props.right, direction, {
              [props.left]: panelMinimum[props.left] / containerWidth,
              [props.right]: panelMinimum[props.right] / containerWidth,
            }),
          }));
        }}
      />
    );
  };

  const toggleDesktopLyrics = () => {
    if (layoutBusy() || isPodcast()) return;
    const before = captureRects('[data-lyrics-morph]');
    const next = !desktopLyrics();
    setLayoutBusy(true);
    setDesktopLyrics(next);
    localStorage.setItem('np:desktopLyrics', next ? 'open' : 'closed');
    animateRects(before, '[data-lyrics-morph]');
    window.setTimeout(() => setLayoutBusy(false), 440);
  };

  const openLyricsOverflow = () => {
    const track = t();
    if (!track) return;
    openActionMenu({
      title: track.title,
      subtitle: track.artist,
      actions: [
        {
          label: `${state.playback.shuffle ? '✓  ' : ''}${tr('nowPlaying.shuffle')}`,
          onSelect: () => actions.toggleShuffle(),
        },
        {
          label: `${state.playback.repeat !== 'off' ? '✓  ' : ''}${tr('nowPlaying.repeat')}`,
          onSelect: () => actions.cycleRepeat(),
        },
        {
          label: state.playback.radioMode ? tr('nowPlaying.stopRadioTitle') : tr('trackActions.startRadio'),
          onSelect: () => state.playback.radioMode ? void onStopRadio() : void actions.startRadio(track),
        },
        ...buildTrackMenu(track, {
          onAddToPlaylist: openPlaylistPicker,
          onEditMetadata: openMetadataEditor,
          onPlayOnDevice: openPlayOnDevice,
        }).filter((action) => action.label !== tr('trackActions.startRadio')),
      ],
    });
  };

  return (
    <section ref={rootEl} class={styles.workspace} aria-label={tr('nowPlaying.playing')}>
      <Show when={t()} fallback={<div class={styles.empty}>{tr('nowPlaying.nothingPlaying')}</div>}>
        <div
          class={styles.main}
          ref={workspaceEl}
          style={{ 'grid-template-columns': gridColumns() }}
          data-layout-busy={layoutBusy() ? '' : undefined}
          onScroll={onCarouselScroll}
        >
        <For each={renderedPanels()}>
          {(panel, index) => (
            <>
              <Show when={index() > 0}>
                <Splitter left={renderedPanels()[index() - 1]} right={panel} />
              </Show>
              <Switch>
                <Match when={panel === 'stage'}>
                  <Tile panel="stage">
        <PanelGrip panel="stage" />
        <div
          class={styles.body}
          classList={{ [styles.desktopLyricsStage]: desktopLyricsActive() }}
          data-lyrics-stage={desktopLyricsActive() ? '' : undefined}
          ref={bodyEl}
        >
          <div class={styles.media}>
            <div
              class={styles.visualSlot}
              data-lyrics-morph=""
              data-lyrics-open={mobileVisual().content === 'lyrics' ? '' : undefined}
            >
              <div class={styles.art} style={artBg()} />
              <Show when={!isPodcast() && mobileVisual().content === 'lyrics'}>
                <div class={styles.mobileLyrics}>
                  <LyricsPanel />
                </div>
              </Show>
              <Show when={!isPodcast()}>
                <button
                  classList={{
                    [styles.mobileLyricsToggle]: true,
                    [styles.mobileLyricsToggleOn]: mobileVisual().content === 'lyrics',
                  }}
                  type="button"
                  aria-label={mobileVisual().content === 'lyrics' ? tr('nowPlaying.showCover') : tr('nowPlaying.showLyrics')}
                  aria-pressed={mobileVisual().content === 'lyrics'}
                  onClick={() => setMobileVisual(toggleMobileLyrics)}
                >
                  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <path d="M5 6h14M5 10h10M5 14h14M5 18h8" />
                  </svg>
                </button>
              </Show>
              <Show when={desktopLyricsActive()}>
                <div class={styles.desktopLyrics}>
                  <LyricsPanel variant="stage" />
                </div>
              </Show>
              <Show when={!isPodcast()}>
                <button
                  classList={{
                    [styles.desktopLyricsToggle]: true,
                    [styles.desktopLyricsToggleOn]: desktopLyricsActive(),
                  }}
                  type="button"
                  aria-label={desktopLyricsActive() ? tr('nowPlaying.showCover') : tr('nowPlaying.showLyrics')}
                  aria-pressed={desktopLyricsActive()}
                  disabled={layoutBusy()}
                  onClick={toggleDesktopLyrics}
                >
                  <Show
                    when={!desktopLyricsActive()}
                    fallback={
                      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <rect x="4" y="4" width="16" height="16" rx="2" />
                        <path d="m7 16 4-4 3 3 2-2 2 3" />
                      </svg>
                    }
                  >
                    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                      <path d="M5 6h14M5 10h10M5 14h14M5 18h8" />
                    </svg>
                  </Show>
                </button>
              </Show>
            </div>
            <div class={styles.info} data-lyrics-morph="">
              <div class={styles.titleRow}>
                <h1 class={styles.title}>{t()!.title}</h1>
                <Show when={t()!.audio_quality === 'lossless' && t()!.audio_identity_verified}>
                  <span class={styles.losslessBadge} title={t()!.audio_source || 'Lossless'}>
                    LOSSLESS
                  </span>
                </Show>
                <RadioBadge class={styles.radioBadge} loadingClass={styles.radioBadgeLoading} />
              </div>
              <Show when={artistLinkable()} fallback={<p class={styles.artist}>{t()!.artist}</p>}>
                <button class={styles.artistLink} type="button" onClick={goArtist}>
                  {t()!.artist}
                </button>
              </Show>
            </div>
          </div>

          <div class={styles.controlsPanel}>
            <div class={styles.seekWrap} data-lyrics-morph="">
            <input
              class={styles.seek}
              type="range"
              min={0}
              max={Math.max(1, Math.floor(state.playback.duration))}
              value={Math.floor(state.playback.currentTime)}
              step={1}
              style={{ '--fill': `${seekPct()}%` }}
              aria-label={tr('nowPlaying.seekLabel')}
              onInput={(e) => actions.seek(Number(e.currentTarget.value))}
            />
            <div class={styles.times}>
              <span>{clockTime(state.playback.currentTime)}</span>
              <span>{clockTime(state.playback.duration)}</span>
            </div>
            </div>

            <div class={styles.controls} data-lyrics-morph="">
            <button
              classList={{ [styles.toggle]: true, [styles.on]: state.playback.shuffle }}
              type="button"
              aria-label={tr('nowPlaying.shuffle')}
              aria-pressed={state.playback.shuffle}
              onClick={() => actions.toggleShuffle()}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" />
              </svg>
            </button>

            <button class={styles.ctrl} type="button" aria-label={tr('common.prev')} onClick={() => actions.prev()}>
              <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                <path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </button>

            <button
              class={styles.play}
              type="button"
              aria-label={loadFailed() ? tr('common.retry') : state.playback.isPlaying ? tr('common.pause') : tr('common.play')}
              aria-busy={loading()}
              onClick={() => actions.togglePlay()}
            >
              <Switch>
                <Match when={loadFailed()}>
                  <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
                  </svg>
                </Match>
                <Match when={loading()}>
                  <Spinner size={26} onAccent />
                </Match>
                <Match when={state.playback.isPlaying}>
                  <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
                    <path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" />
                  </svg>
                </Match>
                <Match when={true}>
                  <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
                    <path fill="currentColor" d="M8 5v14l11-7z" />
                  </svg>
                </Match>
              </Switch>
            </button>

            <button class={styles.ctrl} type="button" aria-label={tr('common.next')} onClick={() => actions.next()}>
              <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                <path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" />
              </svg>
            </button>

            <button
              classList={{ [styles.toggle]: true, [styles.on]: state.playback.repeat !== 'off' }}
              type="button"
              aria-label={tr('nowPlaying.repeat')}
              onClick={() => actions.cycleRepeat()}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3" />
              </svg>
              <Show when={state.playback.repeat === 'one'}>
                <span class={styles.repeatOne}>1</span>
              </Show>
            </button>
            </div>

            <div class={styles.actionsBar} data-lyrics-morph="">
            <Show when={state.playback.queue.length > 1}>
              <button
                classList={{
                  [styles.actBtn]: true,
                  [styles.mobileQueueToggle]: true,
                  [styles.actOn]: props.mobilePanel === 'queue',
                }}
                type="button"
                aria-label={tr('nowPlaying.queue')}
                aria-pressed={props.mobilePanel === 'queue'}
                onClick={() => props.onMobilePanelChange('queue')}
              >
                <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M11 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
                  <path d="M17 17V4h4M13 5H3M3 9h10M9 13H3" />
                </svg>
              </button>
            </Show>

            {/* Marking presupposes having: what is playing may be a stream you
              * have never claimed, and the ＋ next to it is how you claim it. */}
            <Show when={!isPodcast() && isSavedTrack(t()!)}>
              <FavouriteButton favourite={savedFromTrack(t()!)} class={styles.actBtn} tooltip />
            </Show>

            <Show when={!isPodcast()}>
              <span class={styles.collectionAction}>
                <CollectionButton
                  entry={savedFromTrack(t()!)}
                  class={styles.actBtn}
                  hideOwned
                  tooltip
                />
              </span>
            </Show>

            {/* Radio earns a permanent slot because it is the only action here
                that carries state — active, and loading while the mix resolves.
                A menu item cannot show either. Everything else that used to sit
                in this bar (playlist, edit, play-on-device, share) is one tap
                away in ⋯, where it was duplicated from anyway. */}
            <Show when={!isPodcast()}>
              <button
                classList={{
                  [styles.actBtn]: true,
                  [styles.radioAction]: true,
                  [styles.actOn]: state.playback.radioMode,
                  [styles.actPulse]: state.playback.radioLoading,
                }}
                type="button"
                aria-label={state.playback.radioMode ? tr('nowPlaying.stopRadioTitle') : tr('trackActions.startRadio')}
                title={state.playback.radioMode ? tr('nowPlaying.stopRadioTitle') : tr('trackActions.startRadio')}
                aria-pressed={state.playback.radioMode}
                onClick={() => (state.playback.radioMode ? void onStopRadio() : void actions.startRadio(t()!))}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M4 12a8 8 0 018-8M4 12a8 8 0 008 8M8 12a4 4 0 014-4" />
                  <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
                </svg>
              </button>
            </Show>

            <div class={styles.volume}>
              <button
                class={styles.actBtn}
                classList={{ [styles.actOn]: state.playback.muted }}
                type="button"
                aria-label={state.playback.muted ? tr('omnibar.unmute') : tr('omnibar.mute')}
                aria-pressed={state.playback.muted}
                title={state.playback.muted ? tr('omnibar.unmute') : tr('omnibar.mute')}
                onClick={() => actions.toggleMute()}
              >
                <Show
                  when={!state.playback.muted}
                  fallback={
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6" />
                    </svg>
                  }
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
                  </svg>
                </Show>
              </button>
              <input
                class={styles.volRange}
                type="range"
                min={0}
                max={100}
                value={volPct()}
                style={{ '--fill': `${volPct()}%` }}
                aria-label={tr('omnibar.volume')}
                onInput={(e) => actions.setVolume(Number(e.currentTarget.value) / 100)}
              />
            </div>

            <button
              class={styles.actBtn}
              type="button"
              aria-label={tr('common.more')}
              title={tr('common.more')}
              onClick={() => desktopLyricsActive()
                ? openLyricsOverflow()
                : openTrackMenu(t()!, {
                    navigate,
                    onAddToPlaylist: openPlaylistPicker,
                    onEditMetadata: openMetadataEditor,
                    onPlayOnDevice: openPlayOnDevice,
                  })}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="19" cy="12" r="2" />
              </svg>
            </button>
            </div>
          </div>
          <div class={styles.lyricsControlPill} aria-hidden="true" />
        </div>
                  </Tile>
                </Match>
                <Match when={panel === 'queue'}>
                  <Tile panel="queue">
                    <QueueList
                      className={styles.desktopQueue}
                      setRef={(el) => { desktopQueueEl = el; }}
                      dragHandle={<PanelGrip panel="queue" />}
                    />
                  </Tile>
                </Match>
                <Match when={panel === 'browser'}>
                  <Tile panel="browser">
                    <NowPlayingBrowser
                      onClose={() => {
                        if (mobileLayout()) props.onMobilePanelChange('stage');
                        else closeBrowser();
                      }}
                      dragHandle={<PanelGrip panel="browser" />}
                    />
                  </Tile>
                </Match>
              </Switch>
            </>
          )}
        </For>
        </div>
      </Show>
    </section>
  );
}
