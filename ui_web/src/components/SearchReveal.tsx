import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';
import type { AppBarAction } from '../lib/appBar';
import { createTopSwipeReveal } from '../lib/topSwipeReveal';
import { createTouchMoveLease } from '../lib/touchMoveLease';
import { SearchField, type SearchFieldProps } from './SearchField';
import { SearchIcon } from './icons';
import styles from './SearchReveal.module.css';

/** A page owns its query and can request focus. The shell owns the touch field. */
export function createSearchReveal(field: Accessor<SearchFieldProps>, label?: Accessor<string>) {
  const [progress, setProgress] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let focusFrame: number | undefined;
  const attachInput = (element: HTMLInputElement) => { input = element; };
  const open = () => {
    setProgress(1);
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
    setProgress(0);
  };
  onCleanup(reset);

  const expanded = () => Boolean(field().value) || progress() > 0;
  const action = (): AppBarAction => ({
    label: label?.() ?? field().placeholder,
    icon: () => <SearchIcon />,
    onSelect: open,
    expanded: expanded(),
  });
  return { field, action, attachInput, reset, progress, setProgress, open, expanded };
}

export type SearchRevealState = ReturnType<typeof createSearchReveal>;

/** The same pull at the top works in short lists, virtual lists and entity pages. */
export function SearchReveal(props: {
  search: SearchRevealState;
  scope: (field: HTMLElement) => HTMLElement | null | undefined;
  scroller: (field: HTMLElement, target?: Element) => HTMLElement | null | undefined;
  /** Inline native sections lease the gesture only for touches in that section. */
  containsTouch?: (field: HTMLElement, target: Node) => boolean;
  contained?: boolean;
}) {
  let root!: HTMLDivElement;
  const [dragging, setDragging] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const progress = () => props.search.field().value ? 1 : props.search.progress();
  const hidden = () => progress() === 0;

  onMount(() => {
    const scope = props.scope(root);
    if (!scope) return;
    const gesture = createTopSwipeReveal();
    const cancel = () => {
      lease.release();
      if (gesture.cancel().captured) props.search.setProgress(0);
      setDragging(false);
    };
    const lease = createTouchMoveLease(scope, event => {
      if (event.touches.length !== 1 || !event.cancelable) return cancel();
      const touch = event.touches[0];
      const frame = gesture.move(touch.clientX, touch.clientY, event.timeStamp);
      if (!gesture.isTracking()) lease.release();
      if (!frame.captured) return;
      event.preventDefault();
      setDragging(true);
      props.search.setProgress(frame.progress);
    });
    const start = (event: TouchEvent) => {
      cancel();
      if (!hidden() || event.touches.length !== 1) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable]')) return;
      if (target.closest('[role="dialog"]') !== root.closest('[role="dialog"]')) return;
      if (props.containsTouch && !props.containsTouch(root, target)) return;
      const scroller = props.scroller(root, target);
      if (!scroller || scroller.scrollTop > 1) return;
      const touch = event.touches[0];
      gesture.begin(touch.clientX, touch.clientY, event.timeStamp, true, true);
      lease.arm();
    };
    const end = (event: TouchEvent) => {
      lease.release();
      const frame = gesture.end(event.timeStamp);
      if (!frame.captured) return;
      if (event.cancelable) event.preventDefault();
      setDragging(false);
      props.search.setProgress(frame.progress);
    };
    const scroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.scrollTop > 24 && !dragging() && !focused() &&
          !props.search.field().value && props.search.progress() === 1 && target === props.scroller(root, target)) {
        props.search.setProgress(0);
      }
    };

    scope.addEventListener('touchstart', start, { passive: true });
    scope.addEventListener('touchend', end);
    scope.addEventListener('touchcancel', cancel, { passive: true });
    scope.addEventListener('scroll', scroll, { capture: true, passive: true });
    onCleanup(() => {
      lease.release();
      scope.removeEventListener('touchstart', start);
      scope.removeEventListener('touchend', end);
      scope.removeEventListener('touchcancel', cancel);
      scope.removeEventListener('scroll', scroll, true);
      props.search.setProgress(0);
    });
  });

  return <div ref={root} class={styles.reveal} classList={{ [styles.dragging]: dragging(), [styles.contained]: props.contained }}
    data-search-reveal aria-hidden={hidden() ? 'true' : undefined} inert={hidden()}
    style={{ '--search-reveal': progress(), '--search-offset': `${(1 - progress()) * -8}px` }}>
    <SearchField {...props.search.field()} inputRef={props.search.attachInput}
      onFocus={() => { setFocused(true); props.search.setProgress(1); }}
      onBlur={() => setFocused(false)} />
  </div>;
}
