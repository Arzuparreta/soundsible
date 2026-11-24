import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import { openActionMenu } from './ActionMenu';
import { SeamReset } from './SeamReset';
import { playerCompact } from '../lib/playerDock';
import { prefersReducedMotion } from '../lib/prefersReducedMotion';
import { t } from '../lib/i18n';
import { dropTarget } from '../lib/dragReorder';
import {
  movePanel,
  reorderPanel,
  resizeAdjacentPanels,
  type PlayerPanelLayout,
} from '../lib/playerLayout';
import styles from './PlayerWorkspace.module.css';

const CAROUSEL_SETTLE_MS = 80;
const SPLITTER_WIDTH = 24;

function classes(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function PlayerWorkspace<PanelId extends string>(props: {
  panels: readonly PanelId[];
  activePanel: PanelId;
  onActivePanelChange: (panel: PanelId) => void;
  surfaceOpen: boolean;
  layout: PlayerPanelLayout<PanelId>;
  onLayoutChange: (layout: PlayerPanelLayout<PanelId>) => void;
  minimums: Record<PanelId, number>;
  defaults: Record<PanelId, number>;
  panelLabel: (panel: PanelId) => string;
  ariaLabel: string;
  dataScope: 'now-playing' | 'auto' | 'live';
  renderPanel: (panel: PanelId) => JSX.Element;
  soloPanel?: PanelId | null;
  class?: string;
  mainClass?: string;
  tileClass?: string;
  splitterClass?: string;
  panelGripClass?: string;
  rootRef?: (element: HTMLElement) => void;
}) {
  let workspaceEl: HTMLDivElement | undefined;
  let rootEl: HTMLElement | undefined;
  let carouselFrame = 0;
  let carouselSettleTimer: number | undefined;
  let carouselAligned = false;
  let carouselOpening = false;
  let carouselHeld = false;
  let carouselTarget: PanelId | null = null;
  let panelFromScroll = false;
  let previousSurfaceOpen = props.surfaceOpen;
  let draggedPanel: PanelId | null = null;
  // The player's own width, measured by the surface (lib/playerDock).
  const mobileLayout = playerCompact;
  const [layoutBusy, setLayoutBusy] = createSignal(false);
  const customLayout = () => !props.layout.fitArtwork || props.layout.order.some((panel, index) => panel !== props.panels[index]);
  const renderedPanels = createMemo<PanelId[]>(() => {
    if (mobileLayout()) return [...props.panels];
    return props.soloPanel ? [props.soloPanel] : [...props.layout.order];
  });
  const gridColumns = createMemo(() =>
    renderedPanels().flatMap((panel, index) => {
      // Fractional flex factors below 1 can leave unused grid space as soon as
      // one panel reaches its minimum. Integer weights preserve the same
      // proportions while keeping the workspace filled across browser zoom and
      // native interface-scale reflows.
      const ratioWeight = props.layout.ratios[panel] * 1000;
      const neighbor = renderedPanels().find((id) => id !== panel);
      const fit = props.layout.fitArtwork && panel === 'stage' && neighbor !== undefined;
      return [
        props.soloPanel
          ? 'minmax(0, 1fr)'
          : fit
            ? `clamp(${props.minimums[panel]}px, var(--stage-fit-width), 100% - ${props.minimums[neighbor] + SPLITTER_WIDTH}px)`
            : `minmax(${props.minimums[panel]}px, ${ratioWeight}fr)`,
        ...(index < renderedPanels().length - 1 ? [`${SPLITTER_WIDTH}px`] : []),
      ];
    }).join(' '),
  );

  const tileOffset = (tile: HTMLElement) => {
    if (!workspaceEl) return 0;
    return tile.getBoundingClientRect().left
      - workspaceEl.getBoundingClientRect().left
      + workspaceEl.scrollLeft;
  };

  const jumpToTile = (tile: HTMLElement) => {
    if (!workspaceEl) return;
    const previousBehavior = workspaceEl.style.scrollBehavior;
    workspaceEl.style.scrollBehavior = 'auto';
    workspaceEl.scrollLeft = tileOffset(tile);
    workspaceEl.style.scrollBehavior = previousBehavior;
  };

  const carouselPosition = () => {
    if (!workspaceEl) return null;
    const tiles = [...workspaceEl.querySelectorAll<HTMLElement>('[data-player-tile]')];
    if (tiles.length < 2) return null;
    const first = tileOffset(tiles[0]);
    const stride = tileOffset(tiles[1]) - first;
    if (stride <= 0) return null;
    const index = Math.max(0, Math.min(tiles.length - 1, (workspaceEl.scrollLeft - first) / stride));
    return {
      index,
      panel: tiles[Math.round(index)].dataset.playerTile as PanelId,
    };
  };

  const beginCarouselGesture = () => {
    // Auto is lazy-mounted when the user flips the mode pill. Its initial
    // alignment schedules a confirming frame after the synchronous jump; if a
    // finger lands before that frame, the old callback must not pull the
    // carousel back to Stage underneath the gesture.
    cancelAnimationFrame(carouselFrame);
    carouselFrame = 0;
    carouselOpening = false;
    carouselTarget = null;
    window.clearTimeout(carouselSettleTimer);
    carouselSettleTimer = undefined;
  };

  const holdCarousel = () => {
    carouselHeld = true;
    beginCarouselGesture();
  };

  const settleCarousel = () => {
    if (!props.surfaceOpen || !mobileLayout() || !workspaceEl) return;
    window.clearTimeout(carouselSettleTimer);
    carouselSettleTimer = undefined;
    if (carouselHeld) {
      carouselSettleTimer = window.setTimeout(settleCarousel, CAROUSEL_SETTLE_MS);
      return;
    }
    const settled = carouselPosition();
    if (!settled) return;
    if (carouselTarget !== null) {
      const target = workspaceEl.querySelector<HTMLElement>(`[data-player-tile="${carouselTarget}"]`);
      // A previous scroll can settle before the new alignment frame has run.
      // Keep the explicit destination until it arrives or a real gesture takes over.
      if (target && Math.abs(tileOffset(target) - workspaceEl.scrollLeft) > 2) return;
      carouselTarget = null;
    }
    if (settled.panel !== props.activePanel) {
      panelFromScroll = true;
      props.onActivePanelChange(settled.panel);
      panelFromScroll = false;
    }
  };

  const releaseCarousel = () => {
    carouselHeld = false;
    if (carouselSettleTimer === undefined) {
      carouselSettleTimer = window.setTimeout(settleCarousel, CAROUSEL_SETTLE_MS);
    }
  };

  const onCarouselScroll = () => {
    if (!props.surfaceOpen || !mobileLayout()) return;
    window.clearTimeout(carouselSettleTimer);
    carouselSettleTimer = window.setTimeout(settleCarousel, CAROUSEL_SETTLE_MS);
  };

  createEffect(() => {
    const surfaceOpen = props.surfaceOpen;
    const opening = surfaceOpen && !previousSurfaceOpen;
    previousSurfaceOpen = surfaceOpen;
    const panel = surfaceOpen ? props.activePanel : props.panels.find((id) => id === 'stage') ?? props.panels[0];
    if (!mobileLayout() || !workspaceEl) return;
    if (panelFromScroll) {
      // A user's settled scroll supersedes a pending initial alignment. Under
      // WebKit load that frame can otherwise run late and return to the stage.
      cancelAnimationFrame(carouselFrame);
      carouselOpening = false;
      carouselTarget = null;
      panelFromScroll = false;
      carouselAligned = surfaceOpen;
      return;
    }
    const tile = workspaceEl.querySelector<HTMLElement>(`[data-player-tile="${panel}"]`);
    if (!tile) return;
    window.clearTimeout(carouselSettleTimer);
    carouselSettleTimer = undefined;
    carouselTarget = panel;
    const focusedTile = document.activeElement instanceof Element
      ? document.activeElement.closest<HTMLElement>('[data-player-tile]')
      : null;
    if (focusedTile && focusedTile !== tile) {
      queueMicrotask(() => tile.focus({ preventScroll: true }));
    }
    cancelAnimationFrame(carouselFrame);
    if (!surfaceOpen) carouselOpening = false;
    else if (opening) carouselOpening = true;
    const alignImmediately = !surfaceOpen || opening || carouselOpening || !carouselAligned || prefersReducedMotion();
    carouselAligned = surfaceOpen;
    if (Math.abs(tileOffset(tile) - workspaceEl.scrollLeft) <= 2) {
      carouselTarget = null;
      if (opening) {
        // Reopening can immediately target a non-stage panel in the same turn
        // (e.g. returning from a DJ errand to the route); keep opening active
        // until the frame settles so that jump does not smooth-scroll sideways.
        carouselFrame = requestAnimationFrame(() => {
          carouselFrame = 0;
          carouselOpening = false;
        });
      }
      return;
    }
    if (alignImmediately) jumpToTile(tile);
    carouselFrame = requestAnimationFrame(() => {
      carouselFrame = 0;
      carouselOpening = false;
      if (!workspaceEl) return;
      if (alignImmediately) jumpToTile(tile);
      else workspaceEl.scrollTo({ left: tileOffset(tile), behavior: 'smooth' });
    });
  });

  onMount(() => {
    const releaseOutside = () => {
      if (carouselHeld) releaseCarousel();
    };
    window.addEventListener('pointerup', releaseOutside);
    window.addEventListener('pointercancel', releaseOutside);
    workspaceEl?.addEventListener('scrollend', settleCarousel);
    onCleanup(() => {
      window.removeEventListener('pointerup', releaseOutside);
      window.removeEventListener('pointercancel', releaseOutside);
      workspaceEl?.removeEventListener('scrollend', settleCarousel);
      cancelAnimationFrame(carouselFrame);
      window.clearTimeout(carouselSettleTimer);
    });
  });

  const captureRects = () => new Map(
    [...(rootEl?.querySelectorAll<HTMLElement>('[data-player-tile]') ?? [])]
      .map((element) => [element, element.getBoundingClientRect()] as const),
  );

  const animateLayout = (before: Map<Element, DOMRect>) => {
    if (prefersReducedMotion()) return;
    requestAnimationFrame(() => {
      for (const element of rootEl?.querySelectorAll<HTMLElement>('[data-player-tile]') ?? []) {
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

  const updateLayout = (next: PlayerPanelLayout<PanelId>) => {
    const before = captureRects();
    props.onLayoutChange(next);
    animateLayout(before);
  };

  const resetLayout = () => {
    updateLayout({ version: 1, order: [...props.panels], fitArtwork: true, ratios: { ...props.defaults } });
    queueMicrotask(() => workspaceEl?.querySelector<HTMLElement>('[role="separator"]')?.focus({ preventScroll: true }));
  };

  const changePanelOrder = (panel: PanelId, target: number) =>
    updateLayout({
      ...props.layout,
      order: reorderPanel(props.layout.order, panel, target),
    });

  const PanelGrip = (gripProps: { panel: PanelId }) => (
    <button
      class={classes(styles.panelGrip, props.panelGripClass)}
      type="button"
      draggable="true"
      aria-label={t('nowPlaying.movePanel', { panel: props.panelLabel(gripProps.panel) })}
      title={t('nowPlaying.movePanel', { panel: props.panelLabel(gripProps.panel) })}
      onDragStart={(event) => {
        draggedPanel = gripProps.panel;
        event.dataTransfer?.setData('text/plain', gripProps.panel);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => { draggedPanel = null; }}
      onClick={() => {
        const index = props.layout.order.indexOf(gripProps.panel);
        openActionMenu({
          title: t('nowPlaying.layoutPanel'),
          actions: [
            {
              label: t('nowPlaying.movePanelLeft'),
              disabled: index <= 0,
              onSelect: () => updateLayout({
                ...props.layout,
                order: movePanel(props.layout.order, gripProps.panel, -1),
              }),
            },
            {
              label: t('nowPlaying.movePanelRight'),
              disabled: index >= props.panels.length - 1,
              onSelect: () => updateLayout({
                ...props.layout,
                order: movePanel(props.layout.order, gripProps.panel, 1),
              }),
            },
          ],
        });
      }}
    >
      <i /><i /><i /><i /><i /><i />
    </button>
  );

  const Splitter = (splitterProps: { left: PanelId; right: PanelId }) => {
    let startX = 0;
    let startRatios = props.layout.ratios;
    let width = 1;
    let activePointer: number | null = null;
    const displayedRatios = (splitter: HTMLElement) => {
      width = Math.max(1, (workspaceEl?.clientWidth ?? 0) - SPLITTER_WIDTH);
      if (!props.layout.fitArtwork) return props.layout.ratios;
      const left = splitter.parentElement?.previousElementSibling?.getBoundingClientRect().width;
      if (left === undefined) return props.layout.ratios;
      return { ...props.layout.ratios, [splitterProps.left]: left / width, [splitterProps.right]: 1 - left / width };
    };
    const resized = (delta: number, ratios = startRatios) => resizeAdjacentPanels(
      props.panels,
      ratios,
      props.defaults,
      splitterProps.left,
      splitterProps.right,
      delta,
      {
        [splitterProps.left]: props.minimums[splitterProps.left] / width,
        [splitterProps.right]: props.minimums[splitterProps.right] / width,
      } as Partial<Record<PanelId, number>>,
    );
    return (
      <div class={styles.seam} data-custom-split={customLayout() ? '' : undefined}>
        <div
          class={classes(styles.splitter, props.splitterClass)}
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label={t('nowPlaying.resizePanels')}
          onDblClick={resetLayout}
          onPointerDown={(event) => {
            if (layoutBusy()) return;
            activePointer = event.pointerId;
            startX = event.clientX;
            startRatios = displayedRatios(event.currentTarget);
            event.currentTarget.setPointerCapture(event.pointerId);
            setLayoutBusy(true);
          }}
          onPointerMove={(event) => {
            if (activePointer !== event.pointerId) return;
            props.onLayoutChange({ ...props.layout, fitArtwork: false, ratios: resized((event.clientX - startX) / width) });
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
            const ratios = displayedRatios(event.currentTarget);
            const direction = event.key === 'ArrowLeft' ? -0.02 : 0.02;
            props.onLayoutChange({ ...props.layout, fitArtwork: false, ratios: resized(direction, ratios) });
          }}
        />
        <Show when={!mobileLayout() && customLayout()}>
          <SeamReset class={styles.resetSplit} label={t('nowPlaying.resetPanels')} onReset={resetLayout} />
        </Show>
      </div>
    );
  };

  return (
    <section
      ref={(element) => {
        rootEl = element;
        props.rootRef?.(element);
      }}
      class={classes(styles.workspace, props.class)}
      aria-label={props.ariaLabel}
      data-player-workspace={props.dataScope}
    >
      <div
        class={classes(styles.main, props.mainClass)}
        ref={workspaceEl}
        style={{ 'grid-template-columns': gridColumns() }}
        data-layout-busy={layoutBusy() ? '' : undefined}
        data-player-carousel={props.dataScope}
        data-now-playing-carousel={props.dataScope === 'now-playing' ? '' : undefined}
        data-auto-carousel={props.dataScope === 'auto' ? '' : undefined}
        onScroll={onCarouselScroll}
        onPointerDown={holdCarousel}
        onTouchStart={holdCarousel}
        on:wheel={{ handleEvent: beginCarouselGesture, passive: true }}
        onPointerUp={releaseCarousel}
        onPointerCancel={releaseCarousel}
        onTouchEnd={releaseCarousel}
        onTouchCancel={releaseCarousel}
      >
        <For each={renderedPanels()}>
          {(panel, index) => (
            <>
              <Show when={index() > 0 && !props.soloPanel}>
                <Splitter left={renderedPanels()[index() - 1]} right={panel} />
              </Show>
              <section
                ref={(element) => {
                  if (panel !== props.activePanel) return;
                  queueMicrotask(() => {
                    if (!mobileLayout() || carouselAligned || !workspaceEl) return;
                    jumpToTile(element);
                    carouselAligned = props.surfaceOpen;
                  });
                }}
                class={classes(styles.tile, props.tileClass)}
                tabIndex={-1}
                data-player-tile={panel}
                data-now-playing-tile={props.dataScope === 'now-playing' ? panel : undefined}
                data-auto-tile={props.dataScope === 'auto' ? panel : undefined}
                aria-hidden={mobileLayout() && props.activePanel !== panel ? 'true' : undefined}
                inert={mobileLayout() && props.activePanel !== panel ? true : undefined}
                {...dropTarget(() => Boolean(draggedPanel && draggedPanel !== panel), () => {
                  const dragged = draggedPanel!;
                  draggedPanel = null;
                  changePanelOrder(dragged, renderedPanels().indexOf(panel));
                })}
              >
                <PanelGrip panel={panel} />
                {props.renderPanel(panel)}
              </section>
            </>
          )}
        </For>
      </div>
    </section>
  );
}
