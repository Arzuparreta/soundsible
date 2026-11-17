import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';

/**
 * The scrollport a bounded collection lives in, and how far down inside it the
 * collection starts.
 *
 * A list under a page header shares the page's scrollport with that header.
 * The virtualizer has to subtract the header from the scroll offset, and the
 * header changes height (artwork arriving, a wrapped title, a resize), so the
 * origin is observed, not read once.
 */
export function createScrollOrigin(
  content: () => HTMLElement | undefined,
  options: { scrollElement?: () => HTMLElement | null; onLayout?: () => void } = {},
): { scroller: Accessor<HTMLElement | null>; origin: Accessor<number> } {
  const [scroller, setScroller] = createSignal<HTMLElement | null>(null);
  const [origin, setOrigin] = createSignal(0);
  onMount(() => {
    const element = content();
    const port = options.scrollElement?.() ?? element?.closest<HTMLElement>('[data-primary-scroll]') ?? null;
    if (!element || !port) return;
    const read = () => {
      if (element !== port) {
        const top = element.getBoundingClientRect().top - port.getBoundingClientRect().top + port.scrollTop;
        setOrigin(Math.max(0, Math.round(top + (parseFloat(getComputedStyle(element).paddingTop) || 0))));
      }
      options.onLayout?.();
    };
    read();
    // After the origin: the virtualizer takes its first sample when it is
    // handed the scrollport.
    setScroller(port);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    // Whatever grows above the collection is an earlier sibling of it or of
    // one of its ancestors inside the scrollport.
    for (let node: HTMLElement | null = element; node && node !== port; node = node.parentElement) {
      for (let before = node.previousElementSibling; before; before = before.previousElementSibling) observer.observe(before);
    }
    onCleanup(() => observer.disconnect());
  });
  return { scroller, origin };
}
