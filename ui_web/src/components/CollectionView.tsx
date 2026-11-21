import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type Accessor, type JSX, type Setter } from 'solid-js';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import { ScrollActivityContext } from '../lib/artworkSlot';
import { createRowHeight, type RowHeight } from '../lib/rowHeight';
import { createScrollOrigin } from '../lib/scrollOrigin';
import styles from './CollectionView.module.css';

export interface Place { index: number; start: number; size: number; key?: string | number | bigint }
export interface Slot {
  place: Accessor<Place>;
  setPlace: Setter<Place>;
  active: Accessor<boolean>;
  setActive: Setter<boolean>;
  element?: HTMLElement;
}

const samePlace = (a: Place, b: Place) => a.index === b.index && a.start === b.start && a.size === b.size && a.key === b.key;
const placeKey = (place: Place) => place.key ?? place.index;
const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export const gridSlotClass = styles.gridSlot;
export const hiddenSlotClass = styles.slotHidden;
export const scrollingFastClass = styles.scrollingFast;
export { ScrollActivityContext } from '../lib/artworkSlot';

/** Passive scroll-activity and fling-velocity tracker. */
export function createScrollSettled(
  scroller: Accessor<HTMLElement | null>,
  delay = 180,
  fastDelay = 150,
): { scrolling: Accessor<boolean>; fast: Accessor<boolean> } {
  const [scrolling, setScrolling] = createSignal(false);
  const [fast, setFast] = createSignal(false);
  createEffect(() => {
    const el = scroller();
    if (!el) return;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    let fastTimer: ReturnType<typeof setTimeout> | undefined;
    let prevTop = el.scrollTop;
    let prevTime = performance.now();
    const onScroll = () => {
      setScrolling(true);
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => setScrolling(false), delay);
      const now = performance.now();
      const top = el.scrollTop;
      const dt = Math.max(1, now - prevTime);
      const velocity = Math.abs(top - prevTop) / dt;
      prevTop = top;
      prevTime = now;
      if (velocity > 1.5) {
        setFast(true);
        clearTimeout(fastTimer);
        fastTimer = setTimeout(() => setFast(false), fastDelay);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onCleanup(() => {
      el.removeEventListener('scroll', onScroll);
      clearTimeout(scrollTimer);
      clearTimeout(fastTimer);
      setScrolling(false);
      setFast(false);
    });
  });
  return { scrolling, fast };
}

/**
 * The slots that show `places`, reusing the slot of a place that left for a
 * place that arrived.
 *
 * Moving a node in the document makes the browser restyle and lay out its
 * whole subtree again, which costs as much as building it. While the
 * collection moves, slots keep their document position and unused slots stay
 * parked in the pool (hidden rather than removed) so transient range-size
 * dips never tear down or rebuild row subtrees. Once scrolling settles, slots
 * return to list order and excess parked slots are trimmed.
 */
export function createSlots(
  places: () => readonly Place[],
  scrolling: Accessor<boolean>,
  canvas: () => HTMLElement | undefined,
): Accessor<Slot[]> {
  let wasMoving = false;
  const slots = createMemo<Slot[]>((previous) => {
    const wanted = places();
    const moving = scrolling();
    if (
      previous.length === wanted.length
      && moving === wasMoving
      && previous.every((slot, idx) => untrack(slot.active) && samePlace(untrack(slot.place), wanted[idx]))
    ) {
      return previous;
    }
    wasMoving = moving;
    // Capture before Solid moves nodes into document order: by the time an
    // effect runs, moving the focused node may already have blurred it.
    const focused = document.activeElement;
    const focusedSlot = focused instanceof HTMLElement
      ? previous.find(slot => untrack(slot.active) && slot.element?.contains(focused)) : undefined;
    if (focusedSlot) {
      const key = placeKey(untrack(focusedSlot.place));
      queueMicrotask(() => {
        if (focused instanceof HTMLElement && focused.isConnected && document.activeElement === document.body
            && placeKey(untrack(focusedSlot.place)) === key && canvas()?.contains(focused)) focused.focus({ preventScroll: true });
      });
    }
    const held = new Map(previous.map((slot) => [placeKey(untrack(slot.place)), slot]));
    const keep = new Set(wanted.map(placeKey));
    const free = previous.filter((slot) => !keep.has(placeKey(untrack(slot.place))));
    const used = new Set<Slot>();
    const fresh: Slot[] = [];
    const ordered = wanted.map((item) => {
      const place = { index: item.index, start: item.start, size: item.size, key: item.key };
      let slot = held.get(placeKey(item));
      if (!slot && (slot = free.pop())) {
        // Focus belongs to the item that had it, not to whichever item is
        // shown next in the same slot.
        const focusedEl = document.activeElement;
        if (focusedEl instanceof HTMLElement && slot.element?.contains(focusedEl)) focusedEl.blur();
      }
      if (slot) {
        slot.setPlace(place);
        slot.setActive(true);
      } else {
        const [get, set] = createSignal<Place>(place, { equals: samePlace });
        const [active, setActive] = createSignal(true);
        slot = { place: get, setPlace: set, active, setActive };
        fresh.push(slot);
      }
      used.add(slot);
      return slot;
    });
    if (!moving) return ordered;
    for (const slot of previous) {
      if (!used.has(slot)) slot.setActive(false);
    }
    return fresh.length ? [...previous, ...fresh] : previous;
  }, []);

  return slots;
}

/**
 * The rows of a fixed-row collection: only the ones the scrollport can show,
 * and none of them built twice.
 */
export function CollectionRows<T>(props: {
  items: readonly T[];
  /** The scrolling ancestor; defaults to the route's primary scrollport. May
   * return null until the caller's ref is set. */
  scrollElement?: () => HTMLElement | null;
  /** Row height in pixels, or the CSS custom property to read it from. */
  rowHeight?: RowHeight;
  overscan?: number;
  /** Height of the content before the rows inside the scrollport. Measured
   * when omitted. */
  scrollMargin?: number;
  /** Stable occurrence identity for reorderable queues. */
  itemKey?: (item: T) => string;
  /** Queue edit controls can make a row taller than the density estimate. */
  measureRows?: boolean;
  keepMountedIndex?: number;
  class?: string;
  children: (item: Accessor<T>, index: Accessor<number>) => JSX.Element;
}) {
  const rowH = createRowHeight(() => props.rowHeight ?? { cssVar: '--row-h', fallback: 56 });
  let canvas: HTMLDivElement | undefined;
  const { scroller, origin } = createScrollOrigin(() => canvas, { scrollElement: props.scrollElement });
  const { scrolling, fast } = createScrollSettled(scroller);
  const margin = () => props.scrollMargin ?? origin();
  const keys = createMemo(() => props.itemKey ? props.items.map(props.itemKey) : undefined, undefined, {
    equals: (a, b) => a === b || !!a && !!b && a.length === b.length && a.every((key, index) => key === b[index]),
  });
  const itemKey = createMemo(() => {
    const current = keys();
    return (index: number) => current?.[index] ?? index;
  });
  let previousRange: number[] = [];
  const virtualizer = createVirtualizer({
    get count() { return props.items.length; },
    getScrollElement: () => scroller(),
    estimateSize: () => rowH(),
    get getItemKey() { return itemKey(); },
    get rangeExtractor() {
      const pinned = props.keepMountedIndex;
      const count = props.items.length;
      const tall = (scroller()?.clientHeight ?? 0) > 700;
      const step = tall ? 8 : 4;
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        let indexes: number[];
        if (count > 40) {
          const qStart = Math.floor(range.startIndex / step) * step;
          const qEnd = Math.ceil((range.endIndex + 1) / step) * step - 1;
          const start = Math.max(0, qStart - range.overscan);
          const end = Math.min(range.count - 1, qEnd + range.overscan);
          indexes = [];
          for (let index = start; index <= end; index += 1) indexes.push(index);
        } else {
          indexes = defaultRangeExtractor(range);
        }
        if (pinned != null && pinned >= 0 && pinned < count && !indexes.includes(pinned)) {
          indexes.push(pinned);
          indexes.sort((a, b) => a - b);
        }
        if (sameNumbers(previousRange, indexes)) return previousRange;
        previousRange = indexes;
        return indexes;
      };
    },
    get scrollMargin() { return margin(); },
    get overscan() { return props.overscan ?? ((scroller()?.clientHeight ?? 0) > 700 ? 12 : 8); },
  });
  // `estimateSize` is only consulted when the virtualizer measures.
  createEffect(on(rowH, () => virtualizer.measure(), { defer: true }));

  const slots = createSlots(() => virtualizer.getVirtualItems(), scrolling, () => canvas);

  return (
    <div
      ref={canvas}
      data-collection-rows
      class={props.class ? `${styles.canvas} ${props.class}` : styles.canvas}
      classList={{ [styles.scrollingFast]: fast() }}
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      <ScrollActivityContext.Provider value={fast}>
        <For each={slots()}>
          {(slot) => {
            const index = () => slot.place().index;
            // A shrinking list empties its last slots before the window follows.
            const item = () => props.items[index()];
            createEffect(() => {
              index();
              if (props.measureRows && slot.active() && slot.element) virtualizer.measureElement(slot.element);
            });
            return (
              <div
                ref={(element) => { slot.element = element; }}
                data-index={slot.active() ? index() : undefined}
                aria-hidden={!slot.active() ? 'true' : undefined}
                class={props.measureRows ? `${styles.slot} ${styles.slotMeasured}` : styles.slot}
                classList={{ [styles.slotHidden]: !slot.active() }}
                style={{
                  height: props.measureRows ? undefined : `${slot.place().size}px`,
                  transform: `translateY(${slot.place().start - margin()}px)`,
                }}
              >
                <Show when={item() !== undefined}>{props.children(item as Accessor<T>, index)}</Show>
              </div>
            );
          }}
        </For>
      </ScrollActivityContext.Provider>
    </div>
  );
}
