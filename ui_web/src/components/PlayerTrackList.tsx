import { ArtistLinks } from './MusicLinks';
import type { MusicMetadata } from '../lib/musicNavigation';
import { mobileListLayout } from '../lib/listLayout';
import { MusicListRow } from './MusicListRow';
import { VirtualRows } from './VirtualRows';
import { openContextMenu } from '../lib/contextMenu';
import { coverStyle } from '../lib/cover';
import { t } from '../lib/i18n';
import type { MenuAction } from './ActionMenu';
import { menuIcons } from './icons';
import type { SavedEntry } from '../types/music';
import { createEffect, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { createResponsiveTap, responsiveTapConstants } from '../lib/responsiveTap';
import { claimHoldGesture, clearTextSelection } from '../lib/holdGesture';
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
  music?: MusicMetadata;
  cover?: string;
  position?: string | number;
  current?: boolean;
  paused?: boolean;
  locked?: boolean;
  /** The join above this row has no transition planned for it any more. */
  stale?: boolean;
  annotation?: string;
  badge?: string;
  onActivate?: () => void;
  trailing?: JSX.Element;
  entry?: SavedEntry;
  menu?: () => MenuAction[];
  onMove?: (direction: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  draggable?: boolean;
  onDragStart?: (event: DragEvent) => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  before?: JSX.Element;
  onCarry?: () => void;
}

/**
 * Something the list continues into that is not a song of its own — the
 * collection the music was played from, or Autoplay.
 *
 * Drawn in the rows' language (artwork, a name, what it is, a menu) so it reads
 * as part of the same list, but it is never numbered, reordered or played as a
 * row: activating it opens what it stands for.
 */
export interface PlayerTrackListCard {
  id: string;
  title: string;
  /** What the card is, and its state, in words. */
  detail: string;
  seed: string;
  cover?: string;
  /** Drawn over the seeded gradient when there is no artwork. */
  glyph?: JSX.Element;
  /** Present but switched off: drawn quieter, and every control on it still
   * works exactly as it does when it is on. */
  dimmed?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  menu?: () => MenuAction[];
  remove?: { label: string; onSelect: () => void };
  toggle?: { label: string; checked: boolean; onChange: () => void };
}

export interface PlayerTrackListSection {
  id: string;
  label?: string;
  /** What the label means, for the hover of anyone the label alone leaves
   * guessing. */
  hint?: string;
  count?: number;
  entries: PlayerTrackListEntry[];
  /** Drawn instead of rows. A section of cards keeps its full height: it is
   * the lanes of songs above it that give way and scroll. */
  cards?: PlayerTrackListCard[];
}

const sectionHasContent = (section: PlayerTrackListSection) =>
  section.entries.length > 0 || Boolean(section.cards?.length);

/** Above this many rows a lane is given a floor to shrink to, so several long
 * lanes at once cannot squeeze each other down to a sliver. */
const LANE_FLOOR_ROWS = 3;

export interface PlayerTrackListHeadAction {
  label: string;
  title?: string;
  disabled?: boolean;
  /** There is work waiting on this action. Draws attention to it without
   * pretending it is the only thing the header does. */
  pending?: boolean;
  onClick: () => void;
}

export function PlayerTrackList(props: {
  title: string;
  count: number;
  sections: PlayerTrackListSection[];
  /** Finite queues can contain the whole library; DJ seams retain their natural layout. */
  virtualize?: boolean;
  /** Plain copy for ordinary empty queues, or a richer status when emptiness
   * itself is a live state such as the DJ building its first route. */
  empty: JSX.Element;
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
  // Sections rebuild their entry objects when the queue moves. Editing belongs
  // to the occurrence, not to a row instance that disappears after one nudge.
  const [editingId, setEditingId] = createSignal<string | null>(null);
  let rowsEl: HTMLDivElement | undefined;
  createEffect(() => {
    if (editingId() && !props.sections.some((section) => section.entries.some((entry) =>
      entry.id === editingId() && !entry.current && !entry.locked))) setEditingId(null);
  });
  const focusRowControl = (id: string, command?: string) => queueMicrotask(() => {
    const row = [...(rowsEl?.querySelectorAll<HTMLElement>('[data-drag-row]') ?? [])]
      .find((row) => row.dataset.dragRow === id);
    const preferred = command ? row?.querySelector<HTMLButtonElement>(`[data-edit-command="${command}"]:not(:disabled)`) : null;
    // Tried in this order, one selector at a time: a selector list would answer
    // in document order instead, and the row's own button comes before its edit
    // controls. Last of them is the row itself — the panels draw no ⋯ any more,
    // and the song being moved is a better place to be left than nothing.
    const fallback = ['[data-edit-command]:not(:disabled)', '[data-row-menu]', '[data-row-main]']
      .reduce<HTMLButtonElement | null>(
        (found, selector) => found ?? row?.querySelector<HTMLButtonElement>(selector) ?? null,
        null,
      );
    (preferred ?? fallback)?.focus();
  });
  let depth = 0;
  let scrollFrame: number | undefined;
  let scrollSpeed = 0;
  // Each lane scrolls itself now, so the element to nudge is whichever one the
  // drag is over — the outer box usually has nothing left to scroll.
  let scrollEl: HTMLElement | undefined;

  const stopEdgeScroll = () => {
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    scrollFrame = undefined;
    scrollSpeed = 0;
    scrollEl = undefined;
  };
  const runEdgeScroll = () => {
    scrollFrame = undefined;
    if (!scrollEl || !scrollSpeed) return;
    scrollEl.scrollTop += scrollSpeed;
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
    const lane = (event.target as Element | null)?.closest<HTMLElement>('[data-section-rows]');
    const target = lane ?? rowsEl;
    const bounds = target.getBoundingClientRect();
    scrollEl = target;
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
                  data-pending={action.pending ? '' : undefined}
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
        <Show when={props.sections.some(sectionHasContent)} fallback={<div class={styles.empty}>{props.empty}</div>}>
          <For each={props.sections}>
            {(section) => (
              <Show when={sectionHasContent(section)}>
                <section
                  class={styles.section}
                  data-head={section.label ? '' : undefined}
                  data-long={section.entries.length > LANE_FLOOR_ROWS ? '' : undefined}
                  data-cards={section.cards?.length ? '' : undefined}
                  data-section={section.id}
                >
                  <Show when={section.label}>
                    <div class={styles.sectionHead} title={section.hint}>
                      <span>{section.label}</span>
                      <Show when={section.count !== undefined}>
                        <span class={styles.sectionCount}>{section.count}</span>
                      </Show>
                    </div>
                  </Show>
                  <Show when={section.cards?.length} fallback={
                  <PlayerLane virtualize={props.virtualize} entries={section.entries} editingId={editingId()}
                    tail={<Show when={slot() && slot()!.index === section.entries.length}><div class={styles.seamTail} aria-hidden="true" /></Show>}>
                    {(entry, index) => <>
                      {entry().before}
                      <PlayerTrackListRow entry={entry()} seam={slot()?.index === index()}
                        editing={editingId() === entry().id}
                        onEditingChange={(editing) => { const id = entry().id; setEditingId(editing ? id : null); focusRowControl(id); }}
                        onMove={(direction) => { const row = entry(); row.onMove?.(direction); focusRowControl(row.id, direction < 0 ? 'up' : 'down'); }} />
                    </>}
                  </PlayerLane>}>
                    <div class={styles.sectionCards} data-section-cards>
                      <For each={section.cards}>{(card) => <PlayerTrackListCardRow card={card} />}</For>
                    </div>
                  </Show>
                </section>
              </Show>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

function PlayerLane(props: {
  virtualize?: boolean;
  entries: PlayerTrackListEntry[];
  editingId: string | null;
  tail: JSX.Element;
  children: (entry: () => PlayerTrackListEntry, index: () => number) => JSX.Element;
}) {
  const [scroller, setScroller] = createSignal<HTMLDivElement | null>(null);
  return <div ref={setScroller} class={styles.sectionRows} data-section-rows>
    <Show when={props.virtualize} fallback={<For each={props.entries}>{(entry, index) => props.children(() => entry, index)}</For>}>
      <VirtualRows items={props.entries} scrollElement={scroller}
        rowHeight={{ cssVar: '--row-h', fallback: 56 }} measureRows
        keepMountedIndex={props.entries.findIndex((entry) => entry.id === props.editingId)}>
        {(entry, index) => <Show when={entry()}>{(current) => props.children(current, () => index)}</Show>}
      </VirtualRows>
    </Show>
    {props.tail}
  </div>;
}

function PlayerTrackListCardRow(props: { card: PlayerTrackListCard }) {
  const tap = createResponsiveTap({
    disabled: () => !props.card.onOpen,
    onTap: () => props.card.onOpen?.(),
  });
  const openMenu = (event?: MouseEvent) => {
    const actions = props.card.menu?.() ?? [];
    if (actions.length) openContextMenu({ title: props.card.title, subtitle: props.card.detail, actions }, event);
  };
  const menuTap = createResponsiveTap({ onTap: (event) => { event.stopPropagation(); openMenu(); } });
  return (
    <div
      class={styles.card}
      data-queue-card={props.card.id}
      data-dimmed={props.card.dimmed ? '' : undefined}
      data-mobile={mobileListLayout() ? '' : undefined}
      onContextMenu={(event) => {
        if (!props.card.menu) return;
        event.preventDefault();
        openMenu(event);
      }}
    >
      <div class={styles.cardMain}>
        <Show when={props.card.onOpen}>
          <button
            class={styles.playButton}
            type="button"
            aria-label={props.card.openLabel ?? props.card.title}
            data-card-open
            data-pressable
            onKeyDown={(event) => {
              if (props.card.menu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
                event.preventDefault();
                openMenu();
              }
            }}
            {...tap}
          />
        </Show>
        <span class={styles.cardCover} style={coverStyle(props.card.seed, props.card.cover)} aria-hidden="true">
          <Show when={!props.card.cover && props.card.glyph}>{props.card.glyph}</Show>
        </span>
        <span class={styles.cardMeta}>
          <span class={styles.title}>{props.card.title}</span>
          <span class={styles.cardDetail} data-card-detail>{props.card.detail}</span>
        </span>
      </div>
      <span class={styles.cardControls}>
        <Show when={props.card.toggle}>
          {(toggle) => (
            <button
              type="button"
              class={styles.switch}
              role="switch"
              aria-checked={toggle().checked}
              aria-label={toggle().label}
              data-pressable
              onClick={() => toggle().onChange()}
            >
              <span class={styles.knob} />
            </button>
          )}
        </Show>
        <Show when={props.card.menu && mobileListLayout()}>
          <button class={styles.cardMenu} type="button" data-row-menu data-pressable aria-haspopup="dialog"
            aria-label={`${t('songRow.ariaMore')}: ${props.card.title}`} {...menuTap}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
            </svg>
          </button>
        </Show>
        <Show when={!mobileListLayout() && props.card.remove}>
          {(remove) => (
            <button class={styles.cardRemove} type="button" aria-label={remove().label} onClick={() => remove().onSelect()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          )}
        </Show>
      </span>
    </div>
  );
}

function PlayerTrackListRow(props: {
  entry: PlayerTrackListEntry;
  seam?: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const disabled = () => Boolean(props.entry.current || props.entry.locked || !props.entry.onActivate);
  const tap = createResponsiveTap({
    disabled,
    onTap: () => props.entry.onActivate?.(),
  });
  const openMenu = () => {
    const actions = [...(props.entry.menu?.() ?? [])];
    if (!props.entry.locked && !props.entry.current && (props.entry.onMove || props.entry.onCarry)) actions.unshift({
      icon: menuIcons.move(), label: t('musicList.move'), onSelect: () => props.entry.onMove ? props.onEditingChange(true) : props.entry.onCarry?.(),
    });
    if (actions.length) openContextMenu({ title: props.entry.title, subtitle: props.entry.artist, actions });
  };
  let carryTimer: number | undefined;
  let carryStart: { x: number; y: number } | null = null;
  let releaseHold: (() => void) | undefined;
  const cancelCarry = () => {
    if (carryTimer !== undefined) window.clearTimeout(carryTimer);
    carryTimer = undefined;
    carryStart = null;
    releaseHold?.();
    releaseHold = undefined;
  };
  onCleanup(cancelCarry);
  return (
    <div
      class={styles.row}
      data-drag-row={props.entry.id}
      // The cued handoff is already loaded: nothing may be inserted in front of
      // it, so the list never draws that seam.
      data-drag-fixed={props.entry.locked ? '' : undefined}
      data-seam={props.seam ? '' : undefined}
      data-current={props.entry.current ? '' : undefined}
      data-locked={props.entry.locked ? '' : undefined}
      data-stale={props.entry.stale ? '' : undefined}
      draggable={props.entry.draggable}
      onDragStart={props.entry.onDragStart}
      onDragOver={props.entry.onDragOver}
      onDrop={props.entry.onDrop}
      // The panel draws no ⋯, so this is the pointer's way in. The mobile row
      // carries its own (MusicListRow wires hold, right-click and the menu key
      // against the same `onMenu`), which is why this only answers on desktop.
      onContextMenu={(event) => {
        if (mobileListLayout()) return;
        event.preventDefault();
        openMenu();
      }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest("a") || mobileListLayout() || !props.entry.onCarry) return;
        cancelCarry();
        carryStart = { x: event.clientX, y: event.clientY };
        // Touch only: a mouse hold has no selection gesture to head off, and
        // claiming one would cancel a drag-select that starts inside the row.
        if (event.pointerType !== 'mouse') releaseHold = claimHoldGesture();
        carryTimer = window.setTimeout(() => {
          clearTextSelection();
          props.entry.onCarry?.();
        }, 460);
      }}
      // A held finger is never perfectly still. Cancelling on any movement at
      // all made the long press a gesture only a mouse could land.
      onPointerMove={(event) => {
        if (!carryStart) return;
        const slop = responsiveTapConstants.TAP_SLOP;
        if (Math.abs(event.clientX - carryStart.x) > slop || Math.abs(event.clientY - carryStart.y) > slop) {
          cancelCarry();
        }
      }}
      onPointerUp={cancelCarry}
      onPointerCancel={cancelCarry}
    >
      <Show when={!mobileListLayout()} fallback={<MusicListRow playback menuOnHold title={props.entry.title} subtitle={props.entry.artist} music={props.entry.music}
        seed={props.entry.id} cover={props.entry.cover} index={props.entry.current ? undefined : props.entry.position}
        active={props.entry.current} disabled={disabled() || props.editing} entry={props.entry.entry}
        annotation={props.entry.current && props.entry.paused ? t('musicList.paused') : props.entry.badge ?? props.entry.annotation}
        onActivate={props.entry.onActivate}
        onMenu={props.entry.menu || props.entry.onMove || props.entry.onCarry ? openMenu : undefined}
        editing={props.editing} editControls={<>
          <button type="button" data-edit-command="up" aria-label={t('musicList.moveUp')} disabled={!props.entry.canMoveUp} onClick={() => props.onMove(-1)}>↑</button>
          <button type="button" data-edit-command="down" aria-label={t('musicList.moveDown')} disabled={!props.entry.canMoveDown} onClick={() => props.onMove(1)}>↓</button>
          <button type="button" data-edit-command="done" aria-label={t('musicList.done')} onClick={() => props.onEditingChange(false)}>✓</button>
        </>} />}>
      <div class={styles.main}>
        <button class={styles.playButton} type="button" disabled={disabled()} aria-label={`${props.entry.title} — ${props.entry.artist}`} data-pressable {...tap} />
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
          <ArtistLinks class={styles.artist} music={props.entry.music ?? { artist: props.entry.artist, view: "library" }} />
          <Show when={props.entry.annotation}>
            <small class={styles.annotation}>{props.entry.annotation}</small>
          </Show>
          <Show when={props.entry.badge}>
            <small class={styles.badge}>{props.entry.badge}</small>
          </Show>
        </span>
      </div>
      <Show when={props.entry.trailing}>
        <span class={styles.trailing}>{props.entry.trailing}</span>
      </Show>
      </Show>
    </div>
  );
}
