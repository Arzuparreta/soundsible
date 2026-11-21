import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor, type JSX } from 'solid-js';
import { createVirtualizer, defaultRangeExtractor } from '@tanstack/solid-virtual';
import { createScrollOrigin } from '../lib/scrollOrigin';
import {
  createScrollSettled,
  createSlots,
  gridSlotClass,
  hiddenSlotClass,
  scrollingFastClass,
} from './CollectionView';
import { ArtworkWidthContext, ScrollActivityContext } from '../lib/artworkSlot';

interface Tracks { columns: number; columnWidth: number; rowGap: number }

/** What the stylesheet resolved the grid's template to at its current width. */
function readTracks(grid: HTMLElement): Tracks {
  const style = getComputedStyle(grid);
  const widths = style.gridTemplateColumns.split(' ').map(parseFloat).filter((value) => Number.isFinite(value) && value > 0);
  return { columns: Math.max(1, widths.length), columnWidth: widths[0] ?? 160, rowGap: parseFloat(style.rowGap) || 0 };
}

/**
 * A card grid that keeps only the rows near its scrollport in the document.
 *
 * The grid stays one real CSS grid — `class` decides the columns, the gaps and
 * the padding exactly as it does for an unbounded grid — and the rows that are
 * not rendered are replaced by one spacer above and one below. A card that
 * scrolls out is reused for the card that scrolls in (see `createSlots`). The number of
 * columns is read back from the browser, so the stylesheet remains the only
 * place that knows the card recipe.
 */
export function CollectionGrid<T>(props: {
  items: readonly T[];
  /** The CSS grid: columns, gaps and padding. */
  class: string;
  /** The scrolling ancestor; defaults to the route's primary scrollport. */
  scrollElement?: () => HTMLElement | null;
  /** Rows kept beyond each edge of the scrollport. */
  overscan?: number;
  /** Text and controls under the artwork, in pixels: the estimate for a row
   * that has not been measured yet. */
  captionHeight?: number;
  /** A card is reused for the next item: read the accessors where used. */
  children: (item: Accessor<T>, index: Accessor<number>) => JSX.Element;
}) {
  let grid: HTMLDivElement | undefined;
  let lastWidth = -1;
  const [tracks, setTracks] = createSignal<Tracks>({ columns: 1, columnWidth: 160, rowGap: 0 }, {
    equals: (a, b) => a.columns === b.columns && a.columnWidth === b.columnWidth && a.rowGap === b.rowGap,
  });
  const [captionExtra, setCaptionExtra] = createSignal<number>();
  let captionFrame = 0;
  onCleanup(() => cancelAnimationFrame(captionFrame));

  const measureCaptionOnce = (measuredTracks: Tracks) => {
    if (props.captionHeight != null || typeof requestAnimationFrame === 'undefined') return;
    cancelAnimationFrame(captionFrame);
    captionFrame = requestAnimationFrame(() => {
      if (!grid) return;
      const cardSlot = grid.querySelector<HTMLElement>(':scope > :not([data-grid-spacer])');
      if (!cardSlot) return;
      const box = cardSlot.getBoundingClientRect();
      if (box.width <= 0 || box.height <= measuredTracks.columnWidth) return;
      const extra = Math.ceil(box.height - measuredTracks.columnWidth);
      setCaptionExtra((prev) => (prev === extra ? prev : extra));
    });
  };

  // Spacer changes grow/shrink height during scroll; ignore same-width ResizeObserver callbacks
  // so scrolling never triggers getComputedStyle / getBoundingClientRect loops.
  const { scroller, origin: margin } = createScrollOrigin(() => grid, {
    scrollElement: props.scrollElement,
    onLayout: () => {
      if (!grid) return;
      const nextWidth = grid.clientWidth;
      if (nextWidth > 0 && nextWidth === lastWidth) return;
      lastWidth = nextWidth;
      const next = readTracks(grid);
      setTracks(next);
      measureCaptionOnce(next);
    },
  });
  const { scrolling, fast } = createScrollSettled(scroller);
  const rowCount = () => Math.ceil(props.items.length / tracks().columns);

  let previousGridRange: number[] = [];
  const virtualizer = createVirtualizer({
    get count() { return rowCount(); },
    getScrollElement: () => scroller(),
    estimateSize: () => tracks().columnWidth + (props.captionHeight ?? untrack(captionExtra) ?? 64),
    get gap() { return tracks().rowGap; },
    get scrollMargin() { return margin(); },
    get overscan() { return props.overscan ?? 2; },
    rangeExtractor: (range) => {
      if (rowCount() > 8 && (scroller()?.clientHeight ?? 0) > 700) {
        const step = 2;
        const qStart = Math.floor(range.startIndex / step) * step;
        const qEnd = Math.ceil((range.endIndex + 1) / step) * step - 1;
        const start = Math.max(0, qStart - range.overscan);
        const end = Math.min(range.count - 1, qEnd + range.overscan);
        const next: number[] = [];
        for (let index = start; index <= end; index += 1) next.push(index);
        if (previousGridRange.length === next.length && previousGridRange.every((v, i) => v === next[i])) {
          return previousGridRange;
        }
        previousGridRange = next;
        return next;
      }
      return defaultRangeExtractor(range);
    },
  });
  // A different column count or measured caption height changes row heights once per layout pass.
  createEffect(on([() => tracks().columns, captionExtra], () => virtualizer.measure(), { defer: true }));

  const rows = () => virtualizer.getVirtualItems();
  const first = () => rows()[0];
  const last = () => rows()[rows().length - 1];
  const places = createMemo(() => {
    const from = first(), to = last();
    if (!from || !to) return [];
    const columns = tracks().columns;
    const end = Math.min(props.items.length, (to.index + 1) * columns);
    const wanted = [];
    for (let index = from.index * columns; index < end; index += 1) wanted.push({ index, start: 0, size: 0 });
    return wanted;
  });
  const slots = createSlots(places, scrolling, () => grid);

  // A spacer is a grid row of its own, so the gap after it is already there.
  const before = () => Math.max(0, (first()?.start ?? margin()) - margin() - tracks().rowGap);
  const after = () => {
    const to = last();
    return to ? Math.max(0, virtualizer.getTotalSize() - (to.end - margin()) - tracks().rowGap) : 0;
  };
  /** The grid line of the first rendered row: the spacer above takes line 1. */
  const firstLine = () => (before() > 0 ? 2 : 1);

  return (
    <div ref={grid} class={props.class} classList={{ [scrollingFastClass]: fast() }} data-collection-grid>
      <Show when={before() > 0}>
        <div data-grid-spacer aria-hidden="true" style={{ 'grid-area': '1 / 1 / 2 / -1', height: `${before()}px` }} />
      </Show>
      <ScrollActivityContext.Provider value={fast}>
        <For each={slots()}>
          {(slot) => {
            const index = () => slot.place().index;
            const item = () => props.items[index()];
            return (
              // Placed by line, not by document order, so a reused slot does not
              // have to move in the document while the grid scrolls.
              <div
                ref={(element) => { slot.element = element; }}
                class={gridSlotClass}
                classList={{ [hiddenSlotClass]: !slot.active() }}
                aria-hidden={!slot.active() ? 'true' : undefined}
                style={{
                  'grid-row': Math.floor(index() / tracks().columns) - (first()?.index ?? 0) + firstLine(),
                  'grid-column': (index() % tracks().columns) + 1,
                }}
              >
                <ArtworkWidthContext.Provider value={() => tracks().columnWidth}>
                  <Show when={item() !== undefined}>{props.children(item as Accessor<T>, index)}</Show>
                </ArtworkWidthContext.Provider>
              </div>
            );
          }}
        </For>
      </ScrollActivityContext.Provider>
      <Show when={after() > 0}>
        <div data-grid-spacer aria-hidden="true" style={{ 'grid-area': `${rows().length + firstLine()} / 1 / auto / -1`, height: `${after()}px` }} />
      </Show>
    </div>
  );
}
