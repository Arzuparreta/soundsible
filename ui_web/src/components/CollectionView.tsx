import { For, Show, createEffect, createMemo, createSignal, on, untrack, type Accessor, type JSX, type Setter } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { createRowHeight, type RowHeight } from '../lib/rowHeight';
import { createScrollOrigin } from '../lib/scrollOrigin';

export interface Place { index: number; start: number; size: number }
export interface Slot { place: Accessor<Place>; setPlace: Setter<Place>; element?: HTMLElement }

const samePlace = (a: Place, b: Place) => a.index === b.index && a.start === b.start && a.size === b.size;

/**
 * The slots that show `places`, reusing the slot of a place that left for a
 * place that arrived.
 *
 * Moving a node in the document makes the browser restyle and lay out its
 * whole subtree again, which costs as much as building it. While the
 * collection moves, a reused slot therefore keeps its position in the returned
 * array (and so in the document) and is positioned by style alone; the array
 * is put back in list order when the collection stops.
 */
export function createSlots(
  places: () => readonly Place[],
  scrolling: Accessor<boolean>,
  canvas: () => HTMLElement | undefined,
): Accessor<Slot[]> {
  const slots = createMemo<Slot[]>((previous) => {
    const wanted = places();
    const moving = scrolling();
    const held = new Map(previous.map((slot) => [untrack(slot.place).index, slot]));
    const keep = new Set(wanted.map((item) => item.index));
    const free = previous.filter((slot) => !keep.has(untrack(slot.place).index));
    const used = new Set<Slot>();
    const fresh: Slot[] = [];
    const ordered = wanted.map((item) => {
      const place = { index: item.index, start: item.start, size: item.size };
      let slot = held.get(item.index);
      if (!slot && (slot = free.pop())) {
        // Focus belongs to the item that had it, not to whichever item is
        // shown next in the same slot.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && slot.element?.contains(focused)) focused.blur();
      }
      if (slot) slot.setPlace(place);
      else {
        const [get, set] = createSignal(place, { equals: samePlace });
        slot = { place: get, setPlace: set };
        fresh.push(slot);
      }
      used.add(slot);
      return slot;
    });
    if (!moving) return ordered;
    return [...previous.filter((slot) => used.has(slot)), ...fresh];
  }, []);

  // Restoring document order moves nodes, and a moved node loses focus.
  createEffect(on(slots, () => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !canvas()?.contains(focused)) return;
    queueMicrotask(() => {
      if (focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    });
  }, { defer: true }));
  return slots;
}

/**
 * The rows of a fixed-row collection: only the ones the scrollport can show,
 * and none of them built twice.
 *
 * A row that scrolls out is not destroyed. Its slot is handed to the row that
 * scrolls in, so entering the window costs the handful of text, attribute and
 * style writes that differ between two tracks instead of a new subtree with
 * its listeners, memos and cleanup. Building and tearing down rows was most of
 * a fast scroll's script time (handoff item P2).
 *
 * At rest the slots are in list order in the document, so tab order and what
 * a screen reader walks match what is on screen.
 *
 * Because a slot outlives the item it shows, `children` receives accessors and
 * must read them where the value is used. State a row keeps for itself has to
 * be keyed on the item, or it will follow the slot to the next item.
 *
 * The rows live in the caller's scrollport, by default the route's primary
 * one, and start wherever the content above them ends.
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
  class?: string;
  children: (item: Accessor<T>, index: Accessor<number>) => JSX.Element;
}) {
  const rowH = createRowHeight(() => props.rowHeight ?? { cssVar: '--row-h', fallback: 56 });
  const [scrolling, setScrolling] = createSignal(false);
  let canvas: HTMLDivElement | undefined;
  // The virtualizer samples its scrollport when it first sees it. During setup
  // the caller's element exists but is not laid out, and a zero-height sample
  // is an empty window; `createScrollOrigin` hands it over once mounted.
  const { scroller, origin } = createScrollOrigin(() => canvas, { scrollElement: props.scrollElement });
  const margin = () => props.scrollMargin ?? origin();
  const virtualizer = createVirtualizer({
    get count() { return props.items.length; },
    getScrollElement: () => scroller(),
    estimateSize: () => rowH(),
    get scrollMargin() { return margin(); },
    get overscan() { return props.overscan ?? 6; },
    onChange: (instance) => setScrolling(instance.isScrolling),
  });
  // `estimateSize` is only consulted when the virtualizer measures.
  createEffect(on(rowH, () => virtualizer.measure(), { defer: true }));

  const slots = createSlots(() => virtualizer.getVirtualItems(), scrolling, () => canvas);

  return (
    <div
      ref={canvas}
      data-collection-rows
      class={props.class}
      style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}
    >
      <For each={slots()}>
        {(slot) => {
          const index = () => slot.place().index;
          // A shrinking list empties its last slots before the window follows.
          const item = () => props.items[index()];
          return (
            <div
              ref={(element) => { slot.element = element; }}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${slot.place().size}px`,
                // The row cannot change anything outside its box, so one row
                // changing never lays out its neighbours.
                contain: 'size layout style',
                transform: `translateY(${slot.place().start - margin()}px)`,
              }}
            >
              <Show when={item() !== undefined}>{props.children(item as Accessor<T>, index)}</Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}
