import { createSignal, For, onCleanup, onMount, type JSX, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createDismissSwipe, dismissExitTiming, type DismissAxis } from './dismissSwipe';
import { shieldGhostClicks } from './ghostClick';
import { scrollableAncestor, scrollOffset } from './scrollableAncestor';
import styles from './overlay.module.css';

/* Controls that own the touch themselves. Plain buttons are deliberately
   absent: a sheet is mostly a stack of full-width buttons, so excluding them
   would leave nothing to drag. A tap never captures the gesture anyway. */
const SWIPE_EXCLUDED = 'input, textarea, select, [role="slider"], [data-rail], [data-no-overlay-swipe]';

/* The breakpoint the stylesheet uses to put the sheet against an edge. Asked
   once per touch rather than subscribed to: a gesture only needs the answer at
   the moment a finger lands, and a module-level subscription here would put a
   `matchMedia` listener into the store's import graph for nothing. */
const MOBILE_QUERY = '(max-width: 1023px)';

function mobileComposition(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(MOBILE_QUERY).matches;
}

type OverlayRender = (close: (afterClose?: () => void) => void) => JSX.Element;

/**
 * `sheet` is the default surface: a bottom sheet on mobile, a centred card on
 * desktop, sized to its own content. `window` is the self-contained window —
 * full screen on mobile, a fixed-size pane on desktop — for a surface that owns
 * its own header and scrollers, like settings.
 */
type OverlayVariant = 'sheet' | 'window' | 'drawer';

/**
 * A thunk keeps the accessible name live. It matters for anything that can be
 * opened before the interface has settled — a window opened by a deep link at
 * boot would otherwise keep whichever language happened to be loaded in that
 * first frame, forever.
 */
type OverlayLabel = string | (() => string);

interface OverlayEntry {
  id: number;
  render: OverlayRender;
  dismissable: boolean;
  variant: OverlayVariant;
  ariaLabel?: OverlayLabel;
  returnFocus?: HTMLElement | null;
  historyBack?: (afterClose?: () => void) => void;
  cleanup?: () => void;
}

function labelOf(label: OverlayLabel | undefined): string | undefined {
  return typeof label === 'function' ? label() : label;
}

const [overlays, setOverlays] = createSignal<OverlayEntry[]>([]);
let nextId = 1;

function remove(id: number, afterClose?: () => void) {
  const entry = overlays().find((overlay) => overlay.id === id);
  if (!entry) return;
  if (entry.historyBack) {
    entry.historyBack(afterClose);
    return;
  }
  entry.cleanup?.();
  setOverlays((list) => list.filter((o) => o.id !== id));
  queueMicrotask(() => {
    entry.returnFocus?.focus();
    afterClose?.();
  });
}

/**
 * The ONE place overlays (modals, sheets) mount. Returns a `close` handle.
 * Because entries live in a reactive registry rendered through a single
 * <Portal>, closing an overlay — or unmounting the app, or navigating away —
 * disposes its DOM, listeners and reactive scope automatically. The legacy
 * "document.body.appendChild a modal and forget it" leak is impossible here.
 */
export function openOverlay(
  render: OverlayRender,
  opts: { dismissable?: boolean; ariaLabel?: OverlayLabel; variant?: OverlayVariant; history?: boolean } = {},
): () => void {
  const id = nextId++;
  setOverlays((list) => [
    ...list,
    {
      id,
      render,
      dismissable: opts.dismissable ?? true,
      variant: opts.variant ?? 'sheet',
      ariaLabel: opts.ariaLabel,
      returnFocus: typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null,
    },
  ]);
  // Navigation sheets consume Back without changing the URL. Wait for the
  // transient entry to be popped before navigating, so selection replaces its
  // forward entry instead of leaving a duplicate route behind.
  if (opts.history) {
    let pending: (() => void) | undefined;
    let closing = false;
    let closingEntry: OverlayEntry | undefined;
    const onPop = () => {
      if (closingEntry) {
        closingEntry.cleanup?.();
        const after = pending;
        pending = undefined;
        closingEntry = undefined;
        queueMicrotask(() => after?.());
        return;
      }
      const entry = overlays().find((item) => item.id === id);
      if (entry) entry.historyBack = undefined;
      remove(id, pending);
    };
    window.history.pushState({ ...window.history.state, __soundsibleSheet: id }, '');
    window.addEventListener('popstate', onPop);
    const entry = overlays().find((item) => item.id === id)!;
    entry.cleanup = () => window.removeEventListener('popstate', onPop);
    entry.historyBack = (afterClose) => {
      if (closing) return;
      closing = true;
      pending = afterClose;
      if (window.history.state?.__soundsibleSheet === id) {
        // Release the surface now; only navigation waits for browser history.
        closingEntry = entry;
        setOverlays(list => list.filter(item => item.id !== id));
        queueMicrotask(() => entry.returnFocus?.focus());
        window.history.back();
      }
      else onPop();
    };
  }
  return () => remove(id);
}

/**
 * Drag the surface out by hand: a bottom sheet downwards, a left drawer to the
 * left — each leaving the way it came in, which is what its own shape already
 * promises. The `sheet` even draws a grabber for it, and until now that pill
 * was decoration with nothing behind it.
 *
 * Touch only, and only in the mobile composition: on a desktop the sheet is a
 * centred card that is nowhere near an edge, and there is a pointer for the
 * scrim. Everything else about dismissal is left exactly as it was — this
 * always leaves through the entry's own `close`, so the history entry a drawer
 * pushed is still popped and focus still returns to whatever opened it.
 */
function attachDismissSwipe(
  element: HTMLElement,
  axis: DismissAxis,
  armed: () => boolean,
  close: () => void,
): void {
  const gesture = createDismissSwipe(axis, axis === 'left' ? { distance: 64 } : {});
  const scrollAxis = axis === 'down' ? 'y' : 'x';
  let active = false;
  let touchId: number | null = null;
  let scroller: HTMLElement | null = null;
  let exitTimer: number | undefined;

  const paint = (offset: number) => {
    element.style.transform = axis === 'down'
      ? `translateY(${offset}px)`
      : `translateX(${-offset}px)`;
  };

  const release = () => {
    active = false;
    touchId = null;
    scroller = null;
    delete element.dataset.swiping;
    element.style.transform = '';
  };

  const touchById = (touches: TouchList) => {
    if (touchId === null) return null;
    for (let index = 0; index < touches.length; index += 1) {
      const touch = touches.item(index);
      if (touch?.identifier === touchId) return touch;
    }
    return null;
  };

  const onStart = (event: TouchEvent) => {
    release();
    if (event.touches.length !== 1) return;
    const touch = event.touches.item(0);
    if (!touch) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(SWIPE_EXCLUDED)) return;
    // Resolved once, here: walking the ancestors with getComputedStyle on every
    // move is a layout read per frame, mid-gesture. The scrim is the boundary
    // so the sheet itself counts — it is its own scroller.
    scroller = scrollableAncestor(event.target, element.parentElement ?? undefined, scrollAxis);
    touchId = touch.identifier;
    gesture.begin(touch.clientX, touch.clientY, event.timeStamp, {
      enabled: armed(),
      scrolled: scrollOffset(scroller, scrollAxis) > 1,
    });
  };

  const onMove = (event: TouchEvent) => {
    const touch = touchById(event.touches);
    if (!touch) return;
    const frame = gesture.move(touch.clientX, touch.clientY, event.timeStamp);
    if (!frame.captured) return;
    // Re-checked at the moment of capture, as the list may have settled since.
    if (!active) {
      if (scrollOffset(scroller, scrollAxis) > 1) {
        gesture.cancel();
        release();
        return;
      }
      active = true;
      element.dataset.swiping = '';
    }
    if (event.cancelable) event.preventDefault();
    paint(frame.offset);
  };

  const onEnd = (event: TouchEvent) => {
    const touch = touchById(event.changedTouches);
    if (!touch) return;
    const result = gesture.end(event.timeStamp);
    if (!result.dismiss) {
      release();
      return;
    }
    // The sheet was covering the row the finger is over, and every row in this
    // app activates on pointerup. The compatibility click this touch still owes
    // would land there and play it; lib/ghostClick swallows it first.
    shieldGhostClicks();
    const extent = axis === 'down'
      ? element.getBoundingClientRect().height
      : element.getBoundingClientRect().width;
    const exit = dismissExitTiming(result.offset, extent, result.velocity);
    release();
    if (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      close();
      return;
    }
    element.style.setProperty('--overlay-exit-from', `${exit.from}px`);
    element.style.setProperty('--overlay-exit-duration', `${exit.duration}ms`);
    element.dataset.dismissing = '';
    const scrim = element.parentElement;
    if (scrim) scrim.dataset.dismissing = '';
    exitTimer = window.setTimeout(close, exit.duration);
  };

  const onCancel = () => {
    gesture.cancel();
    release();
  };

  element.addEventListener('touchstart', onStart, { passive: true });
  // Non-passive: claiming the drag means preventing the scroll behind it.
  element.addEventListener('touchmove', onMove, { passive: false });
  element.addEventListener('touchend', onEnd, { passive: true });
  element.addEventListener('touchcancel', onCancel, { passive: true });
  onCleanup(() => {
    window.clearTimeout(exitTimer);
    element.removeEventListener('touchstart', onStart);
    element.removeEventListener('touchmove', onMove);
    element.removeEventListener('touchend', onEnd);
    element.removeEventListener('touchcancel', onCancel);
  });
}

/** Mounted once by the app shell. */
export const OverlayOutlet: Component = () => {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const list = overlays();
      const top = list[list.length - 1];
      if (!top) return;
      if (e.key === 'Escape' && top.dismissable) {
        remove(top.id);
        return;
      }
      if (e.key !== 'Tab') return;
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0 || import.meta.env.MODE === 'test');
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  return (
    <Portal>
      <For each={overlays()}>
        {(entry) => {
          const close = (afterClose?: () => void) => remove(entry.id, afterClose);
          return (
            <div
              class={styles.scrim}
              data-variant={entry.variant}
              onClick={() => entry.dismissable && close()}
              role="presentation"
            >
              <div
                class={styles.sheet}
                data-variant={entry.variant}
                role="dialog"
                aria-modal="true"
                aria-label={labelOf(entry.ariaLabel)}
                tabindex="-1"
                ref={(element) => {
                  queueMicrotask(() => {
                    const first = element.querySelector<HTMLElement>(
                      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
                    );
                    (first ?? element).focus();
                  });
                  // `window` is full screen and owns its own header and close
                  // button; there is no edge to throw it at.
                  if (entry.variant === 'window') return;
                  attachDismissSwipe(
                    element,
                    entry.variant === 'drawer' ? 'left' : 'down',
                    () => entry.dismissable && mobileComposition(),
                    () => close(),
                  );
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {entry.render(close)}
              </div>
            </div>
          );
        }}
      </For>
    </Portal>
  );
};
