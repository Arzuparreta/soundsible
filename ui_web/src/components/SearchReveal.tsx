import { batch, createSignal, onCleanup, onMount, type Accessor, type JSX } from 'solid-js';
import type { AppBarAction } from '../lib/appBar';
import { createTopSwipeReveal } from '../lib/topSwipeReveal';
import { createTouchMoveLease } from '../lib/touchMoveLease';
import { SearchField, type SearchFieldProps } from './SearchField';
import { SearchIcon } from './icons';
import styles from './SearchReveal.module.css';

/** A page owns its query and can request focus. The shell owns the touch field. */
export function createSearchReveal(field: Accessor<SearchFieldProps>, label?: Accessor<string>) {
  const [opened, setOpened] = createSignal(false);
  let input: HTMLInputElement | undefined;
  let focusFrame: number | undefined;
  const attachInput = (element: HTMLInputElement) => { input = element; };
  const open = () => {
    setOpened(true);
    // Keep a user-initiated focus synchronous on iOS so it opens the keyboard.
    if (input?.isConnected) input.focus();
    else focusFrame ??= requestAnimationFrame(() => {
      focusFrame = undefined;
      if (input?.isConnected) input.focus();
    });
  };
  const reset = () => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    focusFrame = undefined;
    input?.blur();
    setOpened(false);
  };
  onCleanup(reset);

  const expanded = () => Boolean(field().value) || opened();
  const action = (): AppBarAction => ({
    label: label?.() ?? field().placeholder,
    icon: () => <SearchIcon />,
    onSelect: open,
    expanded: expanded(),
  });
  const desktopField = () => <SearchField {...field()} inputRef={attachInput} />;
  const mobileField = (viewport: SearchViewport): JSX.Element => <SearchReveal search={search} {...viewport} />;
  const search = { field, action, attachInput, reset, setOpened, open, expanded, desktopField, mobileField };
  return search;
}

export type SearchRevealState = ReturnType<typeof createSearchReveal>;

const DISMISS_DISTANCE = 24;

interface SearchViewport {
  scope: (field: HTMLElement) => HTMLElement | null | undefined;
  scroller: (field: HTMLElement, target?: Element) => HTMLElement | null | undefined;
  /** Inline native sections lease the gesture only for touches in that section. */
  containsTouch?: (field: HTMLElement, target: Node) => boolean;
  contained?: boolean;
}

/** The same pull at the top works in short lists, virtual lists and entity pages. */
function SearchReveal(props: SearchViewport & { search: SearchRevealState }) {
  let root!: HTMLDivElement;
  const [dragProgress, setDragProgress] = createSignal<number>();
  const [focused, setFocused] = createSignal(false);
  const progress = () => dragProgress() ?? (props.search.expanded() ? 1 : 0);
  const hidden = () => !props.search.expanded();

  onMount(() => {
    const scope = props.scope(root);
    if (!scope) return;
    let gesture: ReturnType<typeof createTopSwipeReveal> | undefined;
    let touchScroller: HTMLElement | undefined;
    let direction: 1 | -1 = 1;
    let openScroller: HTMLElement | null | undefined;
    let scrollFloor = 0;

    const release = () => {
      lease.release();
      scope.removeEventListener('touchmove', observe);
      gesture = undefined;
      touchScroller = undefined;
      setDragProgress(undefined);
    };
    const move = (event: TouchEvent, blocking: boolean) => {
      if (!gesture || !touchScroller) return;
      if (event.touches.length !== 1 || event.defaultPrevented) return release();
      const touch = event.touches[0];
      const frame = gesture.move(touch.clientX, touch.clientY, event.timeStamp,
        gesture.isCaptured() || touchScroller.scrollTop <= 1);
      if (!gesture.isTracking()) return release();
      if (!frame.captured) return;
      if (blocking && event.cancelable) event.preventDefault();
      setDragProgress(direction === 1 ? frame.progress : 1 - frame.progress);
    };
    const observe = (event: TouchEvent) => move(event, false);
    const lease = createTouchMoveLease(scope, event => move(event, true));

    const start = (event: TouchEvent) => {
      release();
      if (event.touches.length !== 1 || focused() || props.search.field().value) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable]')) return;
      if (target.closest('[role="dialog"]') !== root.closest('[role="dialog"]')) return;
      if (props.containsTouch && !props.containsTouch(root, target)) return;
      const scroller = props.scroller(root, target);
      if (!scroller) return;

      const offset = Math.max(0, scroller.scrollTop);
      const open = props.search.expanded();
      // A populated scrollport dismisses the empty field as the list advances.
      // A short list has no such travel, so the inverse pull dismisses it.
      if (open && (offset > 1 || scroller.scrollHeight - scroller.clientHeight > DISMISS_DISTANCE)) return;
      direction = open ? -1 : 1;
      touchScroller = scroller;
      const touch = event.touches[0];
      gesture = createTopSwipeReveal(touch.clientX, touch.clientY, direction, offset <= 1 ? 0 : offset);
      // Once native scrolling is underway, observe the remaining pull at its
      // boundary without delaying or taking over the scroll.
      if (offset <= 1) lease.arm();
      else scope.addEventListener('touchmove', observe, { passive: true });
    };
    const end = (event: TouchEvent) => batch(() => {
      if (gesture?.isCaptured()) {
        if (event.cancelable) event.preventDefault();
        if (gesture.commit(event.timeStamp)) {
          openScroller = touchScroller;
          scrollFloor = Math.max(0, openScroller?.scrollTop ?? 0);
          props.search.setOpened(direction === 1);
        }
      }
      release();
    });
    const scroll = (event: Event) => {
      if (!props.search.expanded() || dragProgress() !== undefined) return;
      // Library search can swap the results scrollport while the field stays open.
      if (!openScroller?.isConnected) {
        openScroller = props.scroller(root);
        scrollFloor = 0;
      }
      if (!openScroller || event.target !== openScroller) return;
      const top = Math.max(0, openScroller.scrollTop);
      scrollFloor = focused() || props.search.field().value ? top : Math.min(scrollFloor, top);
      if (top - scrollFloor > DISMISS_DISTANCE) props.search.setOpened(false);
    };
    const setScrollOrigin = () => {
      openScroller = props.scroller(root);
      scrollFloor = Math.max(0, openScroller?.scrollTop ?? 0);
    };
    root.addEventListener('focusin', setScrollOrigin);
    root.addEventListener('focusout', setScrollOrigin);
    scope.addEventListener('touchstart', start, { passive: true });
    scope.addEventListener('touchend', end);
    scope.addEventListener('touchcancel', release, { passive: true });
    scope.addEventListener('scroll', scroll, { capture: true, passive: true });
    onCleanup(() => {
      release();
      root.removeEventListener('focusin', setScrollOrigin);
      root.removeEventListener('focusout', setScrollOrigin);
      scope.removeEventListener('touchstart', start);
      scope.removeEventListener('touchend', end);
      scope.removeEventListener('touchcancel', release);
      scope.removeEventListener('scroll', scroll, true);
      props.search.setOpened(false);
    });
  });

  return <div ref={root} class={styles.reveal} classList={{ [styles.dragging]: dragProgress() !== undefined, [styles.contained]: props.contained }}
    data-search-reveal aria-hidden={hidden() ? 'true' : undefined} inert={hidden()}
    style={{ '--search-reveal': progress(), '--search-offset': `${(1 - progress()) * -8}px` }}>
    <SearchField {...props.search.field()} inputRef={props.search.attachInput}
      onFocus={() => { setFocused(true); props.search.setOpened(true); }}
      onBlur={() => setFocused(false)} />
  </div>;
}
