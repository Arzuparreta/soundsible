import { createSignal, Show, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { ActionMenuList, openActionMenu, type ActionMenuOptions } from '../components/ActionMenu';
import styles from './contextMenu.module.css';

/** A getter the directive calls lazily so the menu reflects current state. */
export type MenuProvider = () => ActionMenuOptions | null;

function finePointer(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;
}

const [popover, setPopover] = createSignal<{ opts: ActionMenuOptions; x: number; y: number } | null>(null);

/**
 * Open a contextual action menu. With a mouse event on a fine pointer (desktop
 * right-click or a ⋯ button), anchors a popover at the cursor; on touch / coarse
 * pointers it falls back to the bottom-sheet action menu. One code path, one menu
 * definition — callers just describe what's actionable for the target.
 */
export function openContextMenu(opts: ActionMenuOptions, ev?: MouseEvent): void {
  if (!ev || !finePointer()) {
    openActionMenu(opts);
    return;
  }
  ev.preventDefault();
  setPopover({ opts, x: ev.clientX, y: ev.clientY });
}

/** Mounted once by the app shell; renders the cursor-anchored popover. */
export function ContextMenuOutlet() {
  return (
    <Show when={popover()}>
      {(p) => {
        const close = () => setPopover(null);
        let box: HTMLDivElement | undefined;
        const [pos, setPos] = createSignal({ x: p().x, y: p().y });

        onMount(() => {
          // Clamp into the viewport now that we can measure the menu.
          const r = box!.getBoundingClientRect();
          const pad = 8;
          let x = p().x;
          let y = p().y;
          if (x + r.width + pad > window.innerWidth) x = Math.max(pad, window.innerWidth - r.width - pad);
          if (y + r.height + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - r.height - pad);
          setPos({ x, y });

          const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
          window.addEventListener('keydown', onKey);
          window.addEventListener('resize', close);
          // capture so a scroll anywhere dismisses it
          window.addEventListener('scroll', close, true);
          onCleanup(() => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', close);
            window.removeEventListener('scroll', close, true);
          });
        });

        return (
          <Portal>
            <div class={styles.backdrop} onPointerDown={close} onContextMenu={(e) => (e.preventDefault(), close())} />
            <div
              ref={box}
              class={styles.popover}
              role="menu"
              style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              <ActionMenuList opts={p().opts} close={close} />
            </div>
          </Portal>
        );
      }}
    </Show>
  );
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
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const onTouchStart = () => {
    longFired = false;
    clearTimer();
    timer = window.setTimeout(() => {
      const opts = provide();
      if (!opts) return;
      longFired = true;
      openContextMenu(opts); // no event → bottom sheet
    }, 450);
  };
  // Swallow the click that follows a long-press so the row doesn't also activate.
  const onClickCapture = (e: MouseEvent) => {
    if (longFired) {
      e.preventDefault();
      e.stopPropagation();
      longFired = false;
    }
  };

  el.addEventListener('contextmenu', onContext);
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchend', clearTimer);
  el.addEventListener('touchmove', clearTimer, { passive: true });
  el.addEventListener('touchcancel', clearTimer);
  el.addEventListener('click', onClickCapture, true);

  onCleanup(() => {
    clearTimer();
    el.removeEventListener('contextmenu', onContext);
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchend', clearTimer);
    el.removeEventListener('touchmove', clearTimer);
    el.removeEventListener('touchcancel', clearTimer);
    el.removeEventListener('click', onClickCapture, true);
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
