import type { MenuEvent } from './menuEvent';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { openOverlay } from './overlay';
import { ActionMenuList, openActionMenu, type ActionMenuOptions } from '../components/ActionMenu';
import { claimHoldGesture, clearTextSelection } from './holdGesture';
import { shieldGhostClicks } from './ghostClick';
import styles from './contextMenu.module.css';

/** A getter the directive calls lazily so the menu reflects current state. */
export type MenuProvider = () => ActionMenuOptions | null;

function finePointer(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;
}

interface PopoverState {
  opts: ActionMenuOptions;
  x: number;
  y: number;
  /** The control a keyboard activation came from; the menu hangs off it. */
  anchor?: DOMRect;
  keyboard: boolean;
}

let closePopover: (() => void) | undefined;

/** Dismiss only the cursor menu; touch sheets belong to the overlay registry. */
export function dismissContextMenu(): boolean {
  if (!closePopover) return false;
  closePopover();
  return true;
}

const VIEWPORT_PAD = 8;
const ANCHOR_GAP = 4;

/**
 * Where the popover goes, from its untransformed size. `offsetWidth` rather
 * than `getBoundingClientRect`: the entrance animation scales the box, and a
 * rect read mid-animation is smaller than the menu that ends up on screen.
 */
export function placePopover(
  state: Pick<PopoverState, 'x' | 'y' | 'anchor'>,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  let { x, y } = state;
  if (state.anchor) {
    x = state.anchor.left;
    y = state.anchor.bottom + ANCHOR_GAP;
    // No room underneath: open above the control instead of covering it.
    if (y + size.height + VIEWPORT_PAD > viewport.height && state.anchor.top - ANCHOR_GAP - size.height >= VIEWPORT_PAD) {
      y = state.anchor.top - ANCHOR_GAP - size.height;
    }
  }
  if (x + size.width + VIEWPORT_PAD > viewport.width) x = viewport.width - size.width - VIEWPORT_PAD;
  if (y + size.height + VIEWPORT_PAD > viewport.height) y = viewport.height - size.height - VIEWPORT_PAD;
  return { x: Math.max(VIEWPORT_PAD, x), y: Math.max(VIEWPORT_PAD, y) };
}

/**
 * Open a contextual action menu. With a mouse event on a fine pointer (desktop
 * right-click or a ⋯ button), anchors a popover at the cursor; on touch / coarse
 * pointers it falls back to the bottom-sheet action menu. One code path, one menu
 * definition — callers just describe what's actionable for the target.
 *
 * Enter or Space on a button arrives as a click with no coordinates, so that
 * one hangs off the control and takes focus into the menu.
 */
export function openContextMenu(opts: ActionMenuOptions, ev?: MenuEvent): void {
  if (!ev || !finePointer()) {
    openActionMenu(opts);
    return;
  }
  ev.preventDefault();
  const keyboard = ev instanceof KeyboardEvent || ev.type === 'click' && ev.detail === 0;
  const target = keyboard && ev.target instanceof Element
    ? ev.target.closest('button, a, [role="button"]') ?? ev.target
    : null;
  dismissContextMenu();
  const initial: PopoverState = {
    opts,
    x: 'clientX' in ev ? ev.clientX : 0,
    y: 'clientY' in ev ? ev.clientY : 0,
    anchor: target?.getBoundingClientRect(),
    keyboard,
  };
  closePopover = openOverlay(close => <ContextPopover state={initial} close={close} />, {
    variant: 'popover', ariaLabel: opts.title, closeOnNavigation: true,
  });
}

/** Kept as an import-compatible lifecycle boundary. Popovers and sheets now
 * render through OverlayOutlet and share its stack, navigation and disposal. */
export function ContextMenuOutlet() {
  onCleanup(() => dismissContextMenu());
  return null;
}

function ContextPopover(props: { state: PopoverState; close: (afterClose?: () => void) => void }) {
  onCleanup(() => { closePopover = undefined; });
  const dismiss = () => props.close();
  let box: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ x: props.state.x, y: props.state.y });
  const items = () => [...box!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];

  onMount(() => {
    const place = () => setPos(placePopover(
      props.state,
      { width: box!.offsetWidth, height: box!.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    ));
    place();
    // The box can still grow after it mounts — a web font arriving widens
    // the labels — and a menu placed against an edge would cross it.
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    resized?.observe(box!);
    onCleanup(() => resized?.disconnect());
    // A keyboard user lands on the first action; a pointer user gets the
    // arrow keys without a focus ring appearing on an item nobody chose.
    (props.state.keyboard ? items()[0] ?? box! : box!).focus({ preventScroll: true });

    // capture so a scroll anywhere dismisses it — except its own, when
    // the menu is taller than the window and scrolls inside itself
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && box!.contains(e.target)) return;
      props.close();
    };
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', onScroll, true);
    // Back leaves the page this menu was about.
    window.addEventListener('popstate', dismiss);
    onCleanup(() => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('popstate', dismiss);
    });
  });

  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      // The menu is one tab stop: leaving it closes it.
      e.preventDefault();
      props.close();
      return;
    }
    const list = items();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % list.length;
    else if (e.key === 'ArrowUp') next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else return;
    e.preventDefault();
    list[next].focus();
  };

  return <div ref={box} class={styles.popover} role="menu" aria-label={props.state.opts.title}
    tabindex="-1" style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
    onClick={event => event.stopPropagation()} onKeyDown={onMenuKey}>
    <ActionMenuList opts={props.state.opts} close={props.close} deferSelection menu />
  </div>;
}

/**
 * Attach a contextual menu to any element. Right-click opens a cursor popover
 * (desktop); long-press opens the sheet (touch). Returning null from `provide`
 * disables the menu for that element. Use via a ref:
 *   `ref={(el) => attachContextMenu(el, () => menuOptions)}`
 * or via the `ctxMenu` directive: `use:ctxMenu={() => menuOptions}`.
 */
export function attachContextMenu(el: HTMLElement, provide: MenuProvider) {
  const onContext = (e: MouseEvent) => {
    const opts = provide();
    if (!opts) return;
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(opts, e);
  };

  let timer: number | undefined;
  let longFired = false;
  let releaseHold: (() => void) | undefined;
  const endPress = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    releaseHold?.();
    releaseHold = undefined;
  };
  const onTouchStart = () => {
    longFired = false;
    endPress();
    // Nothing to open means no gesture to claim: an element without a menu
    // leaves the long press to the platform, selection and all.
    if (!provide()) return;
    // This listener is passive (the platform needs its scroll), so the native
    // long press cannot be cancelled here. Claiming the gesture is what keeps
    // Safari from selecting the sheet this press is about to open.
    releaseHold = claimHoldGesture();
    timer = window.setTimeout(() => {
      const opts = provide();
      if (!opts) return;
      longFired = true;
      clearTextSelection();
      openContextMenu(opts); // no event → bottom sheet
    }, 450);
  };
  // The sheet this press opened is under the finger, and the mouse events the
  // platform still owes the touch would land in it — choosing an item nobody
  // asked for. lib/ghostClick swallows them wherever they land, which includes
  // the row underneath: a press that opened a menu never also activates.
  const onTouchEnd = () => {
    if (longFired) shieldGhostClicks();
    longFired = false;
    endPress();
  };

  el.addEventListener('contextmenu', onContext);
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchend', onTouchEnd);
  el.addEventListener('touchmove', endPress, { passive: true });
  el.addEventListener('touchcancel', endPress);

  onCleanup(() => {
    endPress();
    el.removeEventListener('contextmenu', onContext);
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchend', onTouchEnd);
    el.removeEventListener('touchmove', endPress);
    el.removeEventListener('touchcancel', endPress);
  });
}

/** Solid directive form: `use:ctxMenu={() => menuOptions}`. */
export function ctxMenu(el: HTMLElement, value: () => MenuProvider) {
  attachContextMenu(el, value());
}

declare module 'solid-js' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface Directives {
      ctxMenu: MenuProvider;
    }
  }
}
