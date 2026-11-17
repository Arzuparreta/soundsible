import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type Accessor, type JSX } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { createScrollOrigin } from '../lib/scrollOrigin';
import { createSlots } from './CollectionView';
import { ArtworkWidthContext } from '../lib/artworkSlot';

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
 *
 * Rows can differ in height (a title that wraps), so each rendered row is
 * measured and the spacers use the measured heights.
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
  const [tracks, setTracks] = createSignal<Tracks>({ columns: 1, columnWidth: 160, rowGap: 0 }, {
    equals: (a, b) => a.columns === b.columns && a.columnWidth === b.columnWidth && a.rowGap === b.rowGap,
  });
  // The grid's width decides its columns.
  const { scroller, origin: margin } = createScrollOrigin(() => grid, {
    scrollElement: props.scrollElement,
    onLayout: () => setTracks(readTracks(grid!)),
  });
  const rowCount = () => Math.ceil(props.items.length / tracks().columns);

  const virtualizer = createVirtualizer({
    get count() { return rowCount(); },
    getScrollElement: () => scroller(),
    estimateSize: () => tracks().columnWidth + (props.captionHeight ?? 64),
    get gap() { return tracks().rowGap; },
    get scrollMargin() { return margin(); },
    get overscan() { return props.overscan ?? 2; },
    onChange: (instance) => setScrolling(instance.isScrolling),
  });
  // A different column count is a different set of rows: forget their sizes.
  createEffect(on(() => tracks().columns, () => virtualizer.measure(), { defer: true }));

  const [scrolling, setScrolling] = createSignal(false);
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

  // Every card of a grid row is stretched to the row, so one card is the row.
  createEffect(() => {
    const from = first();
    const held = slots();
    if (!from || !held.length || typeof requestAnimationFrame === 'undefined') return;
    const columns = tracks().columns;
    const frame = requestAnimationFrame(() => {
      for (const slot of held) {
        const index = slot.place().index;
        const height = index % columns === 0 ? slot.element?.offsetHeight ?? 0 : 0;
        if (height > 0) virtualizer.resizeItem(Math.floor(index / columns), height);
      }
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  return (
    <div ref={grid} class={props.class} data-collection-grid>
      <Show when={before() > 0}>
        <div data-grid-spacer aria-hidden="true" style={{ 'grid-area': '1 / 1 / 2 / -1', height: `${before()}px` }} />
      </Show>
      <For each={slots()}>
        {(slot) => {
          const index = () => slot.place().index;
          const item = () => props.items[index()];
          return (
            // Placed by line, not by document order, so a reused slot does not
            // have to move in the document while the grid scrolls.
            <div
              ref={(element) => { slot.element = element; }}
              style={{
                display: 'grid',
                'min-width': 0,
                contain: 'layout style',
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
      <Show when={after() > 0}>
        <div data-grid-spacer aria-hidden="true" style={{ 'grid-area': `${rows().length + firstLine()} / 1 / auto / -1`, height: `${after()}px` }} />
      </Show>
    </div>
  );
}
