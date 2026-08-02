import { For, Show, createEffect, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { state } from '../stores';

/**
 * Render only the rows a scroll container can actually show.
 *
 * `TrackList` and `LibrarySearchResults` each grew their own copy of this; the
 * library list inside Now Playing had none, so opening it built a DOM subtree
 * and a pointer handler for every track in the library at once.
 *
 * The caller owns the scroll element — these lists sit under a sticky header
 * inside a panel that scrolls as a whole — and passes an accessor to it.
 */
export function VirtualRows<T>(props: {
  items: readonly T[];
  /** The scrolling ancestor. May return null on the first render. */
  scrollElement: () => HTMLElement | null;
  /** Row height in pixels, or a CSS custom property to read it from. */
  rowHeight: number | { cssVar: string; fallback: number };
  overscan?: number;
  children: (item: () => T | undefined, index: number) => JSX.Element;
}) {
  // The virtualizer observes its scroll element once, when it mounts. This
  // component renders inside that element, so on the first pass the parent's
  // ref has not been assigned yet — building the virtualizer then would leave
  // it observing nothing and rendering no rows at all. Wait for the element.
  return (
    <Show when={props.scrollElement()} keyed>
      {(element) => <Rows {...props} scrollElement={() => element} />}
    </Show>
  );
}

function Rows<T>(props: {
  items: readonly T[];
  scrollElement: () => HTMLElement | null;
  rowHeight: number | { cssVar: string; fallback: number };
  overscan?: number;
  children: (item: () => T | undefined, index: number) => JSX.Element;
}) {
  const initialRect = () => {
    const element = props.scrollElement();
    return {
      width: element?.clientWidth || element?.offsetWidth || 0,
      height: element?.clientHeight || element?.offsetHeight || 0,
    };
  };
  const measure = (): number => {
    const height = props.rowHeight;
    if (typeof height === 'number') return height;
    if (typeof window === 'undefined') return height.fallback;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(height.cssVar);
    return Number.parseFloat(raw) || height.fallback;
  };

  const [rowH, setRowH] = createSignal(measure());

  onMount(() => {
    const sync = () => setRowH(measure());
    sync();
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(min-width: 1024px)');
      mq.addEventListener('change', sync);
      onCleanup(() => mq.removeEventListener('change', sync));
    }
    window.addEventListener('orientationchange', sync);
    onCleanup(() => window.removeEventListener('orientationchange', sync));
  });

  // Accessibility sizing changes CSS custom properties without crossing a media
  // query, so re-read the token once the root attribute has been applied.
  createEffect(() => {
    void state.interfaceSize;
    queueMicrotask(() => setRowH(measure()));
  });

  const virtualizer = createVirtualizer({
    get count() {
      return props.items.length;
    },
    getScrollElement: () => props.scrollElement(),
    estimateSize: () => rowH(),
    // The observer reports subsequent resizes, but the first virtual range is
    // calculated synchronously. Supplying the already-mounted scrollport keeps
    // an initially visible list from starting at a zero-height range and only
    // appearing after a tab switch forces another calculation.
    initialRect: initialRect(),
    get overscan() {
      return props.overscan ?? 10;
    },
  });

  // `estimateSize` is only consulted when the virtualizer measures.
  createEffect(on(rowH, () => virtualizer.measure(), { defer: true }));

  return (
    <div
      data-virtual-rows
      style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}
    >
      <For each={virtualizer.getVirtualItems()}>
        {(vi) => (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vi.start}px)`,
            }}
          >
            {/* Read the item through an accessor rather than capturing it: the
                virtualizer reconciles slots by index, so a row that stays on
                screen keeps its component while the list behind it changes. */}
            {props.children(() => props.items[vi.index], vi.index)}
          </div>
        )}
      </For>
    </div>
  );
}
