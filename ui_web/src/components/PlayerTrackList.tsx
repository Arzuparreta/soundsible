import { createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { createResponsiveTap } from '../lib/responsiveTap';
import {
  buildDropSlots,
  containerPointer,
  edgeScrollDelta,
  nearestSlot,
  readDragRows,
  type DropSlot,
} from '../lib/dragReorder';
import { vibrate } from '../lib/haptics';
import styles from './PlayerTrackList.module.css';

export interface PlayerTrackListEntry {
  id: string;
  title: string;
  artist: string;
  cover?: string;
  position?: string | number;
  current?: boolean;
  paused?: boolean;
  locked?: boolean;
  annotation?: string;
  badge?: string;
  onActivate?: () => void;
  trailing?: JSX.Element;
  draggable?: boolean;
  onDragStart?: (event: DragEvent) => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  before?: JSX.Element;
  onCarry?: () => void;
}

export interface PlayerTrackListSection {
  id: string;
  label?: string;
  count?: number;
  entries: PlayerTrackListEntry[];
  footer?: JSX.Element;
}

export interface PlayerTrackListHeadAction {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}

export function PlayerTrackList(props: {
  title: string;
  count: number;
  sections: PlayerTrackListSection[];
  empty: string;
  dragHandle?: JSX.Element;
  headAction?: PlayerTrackListHeadAction | PlayerTrackListHeadAction[];
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  /** Given the seam a drag is nearest to, place what is being carried. Wiring
   * this is what turns the list itself into the drop target, instead of the
   * per-row gaps that were the only aim-able thing before. */
  onDropAtSlot?: (slot: DropSlot, event: DragEvent) => void;
  /** True while a track is being carried by long-press, the touch equivalent
   * of a drag: the same seam indicator should be showing. */
  placing?: boolean;
  setScrollerRef?: (element: HTMLDivElement) => void;
}) {
  const headActions = () => {
    const action = props.headAction;
    return action ? (Array.isArray(action) ? action : [action]) : [];
  };
  const [slot, setSlot] = createSignal<DropSlot | null>(null);
  const [dragging, setDragging] = createSignal(false);
  let rowsEl: HTMLDivElement | undefined;
  let depth = 0;
  let scrollFrame: number | undefined;
  let scrollSpeed = 0;

  const stopEdgeScroll = () => {
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    scrollFrame = undefined;
    scrollSpeed = 0;
  };
  const runEdgeScroll = () => {
    scrollFrame = undefined;
    if (!rowsEl || !scrollSpeed) return;
    rowsEl.scrollTop += scrollSpeed;
    scrollFrame = requestAnimationFrame(runEdgeScroll);
  };
  const endDrag = () => {
    depth = 0;
    setDragging(false);
    setSlot(null);
    stopEdgeScroll();
  };
  onCleanup(stopEdgeScroll);

  const trackPointer = (event: DragEvent) => {
    if (!rowsEl || !props.onDropAtSlot) return;
    const rows = readDragRows(rowsEl);
    if (!rows.length) return;
    const next = nearestSlot(buildDropSlots(rows), containerPointer(rowsEl, event.clientY));
    if (next && next.index !== slot()?.index) {
      setSlot(next);
      vibrate(6);
    }
    const bounds = rowsEl.getBoundingClientRect();
    scrollSpeed = edgeScrollDelta(event.clientY, { top: bounds.top, bottom: bounds.bottom });
    if (scrollSpeed && scrollFrame === undefined) scrollFrame = requestAnimationFrame(runEdgeScroll);
    if (!scrollSpeed) stopEdgeScroll();
  };

  return (
    <div class={styles.panel} data-dragging={dragging() || props.placing ? '' : undefined}>
      <header class={styles.head} onDragOver={props.onDragOver} onDrop={props.onDrop}>
        <span class={styles.heading}>
          {props.dragHandle}
          <h2>{props.title}</h2>
          <span class={styles.count}>{props.count}</span>
        </span>
        <Show when={headActions().length}>
          <span class={styles.headActions}>
            <For each={headActions()}>
              {(action) => (
                <button
                  class={styles.headAction}
                  type="button"
                  title={action.title}
                  disabled={action.disabled}
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              )}
            </For>
          </span>
        </Show>
      </header>
      <div
        class={styles.rows}
        ref={(element) => { rowsEl = element; props.setScrollerRef?.(element); }}
        onDragEnter={(event) => {
          if (!props.onDropAtSlot) return;
          event.preventDefault();
          depth += 1;
          setDragging(true);
        }}
        // `dragleave` fires for every child the pointer crosses, so only a
        // matched count of them means the drag has actually left the list.
        onDragLeave={() => {
          if (!props.onDropAtSlot) return;
          depth = Math.max(0, depth - 1);
          if (depth === 0) endDrag();
        }}
        onDragOver={(event) => {
          if (!props.onDropAtSlot) return;
          event.preventDefault();
          trackPointer(event);
        }}
        onDrop={(event) => {
          if (!props.onDropAtSlot) return;
          event.preventDefault();
          const target = slot();
          endDrag();
          if (target) props.onDropAtSlot(target, event);
        }}
      >
        <Show when={props.sections.some((section) => section.entries.length > 0)} fallback={<p class={styles.empty}>{props.empty}</p>}>
          <For each={props.sections}>
            {(section) => (
              <Show when={section.entries.length > 0}>
                <section class={styles.section}>
                  <Show when={section.label}>
                    <div class={styles.sectionHead}>
                      <span>{section.label}</span>
                      <Show when={section.count !== undefined}>
                        <span class={styles.sectionCount}>{section.count}</span>
                      </Show>
                    </div>
                  </Show>
                  <For each={section.entries}>
                    {(entry, index) => (
                      <>
                        {entry.before}
                        <PlayerTrackListRow entry={entry} seam={slot()?.index === index()} />
                      </>
                    )}
                  </For>
                  <Show when={slot() && slot()!.index === section.entries.length}>
                    <div class={styles.seamTail} aria-hidden="true" />
                  </Show>
                  {section.footer}
                </section>
              </Show>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

function PlayerTrackListRow(props: { entry: PlayerTrackListEntry; seam?: boolean }) {
  const disabled = () => Boolean(props.entry.current || props.entry.locked || !props.entry.onActivate);
  const tap = createResponsiveTap({
    disabled,
    onTap: () => props.entry.onActivate?.(),
  });
  let carryTimer: number | undefined;
  const cancelCarry = () => {
    if (carryTimer !== undefined) window.clearTimeout(carryTimer);
    carryTimer = undefined;
  };
  return (
    <div
      class={styles.row}
      data-drag-row={props.entry.id}
      data-seam={props.seam ? '' : undefined}
      data-current={props.entry.current ? '' : undefined}
      data-locked={props.entry.locked ? '' : undefined}
      draggable={props.entry.draggable}
      onDragStart={props.entry.onDragStart}
      onDragOver={props.entry.onDragOver}
      onDrop={props.entry.onDrop}
      onPointerDown={() => {
        if (!props.entry.onCarry) return;
        cancelCarry();
        carryTimer = window.setTimeout(() => props.entry.onCarry?.(), 460);
      }}
      onPointerMove={cancelCarry}
      onPointerUp={cancelCarry}
      onPointerCancel={cancelCarry}
    >
      <button class={styles.main} type="button" disabled={disabled()} data-pressable {...tap}>
        <span class={styles.position}>
          <Show when={!props.entry.current} fallback={
            <span class={styles.eq} data-paused={props.entry.paused ? '' : undefined} aria-hidden="true"><i /><i /><i /></span>
          }>
            {props.entry.position ?? ''}
          </Show>
        </span>
        <span
          class={styles.cover}
          style={{ 'background-image': props.entry.cover ? `url("${props.entry.cover}")` : undefined }}
          aria-hidden="true"
        />
        <span class={styles.meta}>
          <span class={styles.title}>{props.entry.title}</span>
          <span class={styles.artist}>{props.entry.artist}</span>
          <Show when={props.entry.annotation}>
            <small class={styles.annotation}>{props.entry.annotation}</small>
          </Show>
          <Show when={props.entry.badge}>
            <small class={styles.badge}>{props.entry.badge}</small>
          </Show>
        </span>
      </button>
      <Show when={props.entry.trailing}>
        <span class={styles.trailing}>{props.entry.trailing}</span>
      </Show>
    </div>
  );
}

export function PlayerTrackListMore(props: { label: string; onClick: () => void }) {
  return <button class={styles.more} type="button" onClick={props.onClick}>{props.label}</button>;
}
