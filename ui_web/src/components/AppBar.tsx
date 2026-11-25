import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { Control } from '../design/Control';
import { currentAppBar } from '../lib/appBar';
import { t } from '../lib/i18n';
import { desktopShell } from '../lib/shellLayout';
import { prefersReducedMotion } from '../lib/prefersReducedMotion';
import { BackIcon } from './icons';
import { NavigationMenuButton } from './NavigationMenu';
import { PageCommands } from './PageCommands';
import styles from './AppBar.module.css';

const SCROLLER = '[data-primary-scroll], [data-app-outlet]';

/** The scroller the page on screen reads from — its own, or the shell's. */
function pageScroller(from: HTMLElement): HTMLElement | null {
  const main = from.closest('main');
  return main?.querySelector<HTMLElement>('[data-primary-scroll]')
    ?? main?.querySelector<HTMLElement>('[data-app-outlet]')
    ?? null;
}

/** A page's own title tap if it set one, otherwise the page back to its top. */
function returnToTop(from: HTMLElement) {
  const custom = currentAppBar()?.onTitleTap;
  if (custom) return custom();
  pageScroller(from)?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/**
 * The top bar of the touch shell: one instance, mounted by the shell, never by
 * a page. The leading control is Menu or Back, with page commands at the
 * other end. Routine page names belong to PageIndicator. Entity names can
 * echo here after the heading scrolls away. Desktop toolbars use PageCommands
 * with the same definitions.
 */
export function AppBar() {
  const location = useLocation();
  const bar = currentAppBar;
  const [scrolled, setScrolled] = createSignal(false);
  const [headingOut, setHeadingOut] = createSignal(false);
  let root: HTMLElement | undefined;
  let frame = 0;

  /**
   * Read the page once: is anything scrolled up under the bar, and has the
   * page's own large title gone up behind it? Measured on scroll rather than
   * observed, because a scroll the app makes itself — returning to a saved
   * position — has to count as much as a finger's.
   */
  const measure = () => {
    frame = 0;
    if (!root) return;
    const scroller = pageScroller(root);
    setScrolled(!!scroller && scroller.scrollTop > 0);
    const heading = untrack(() => bar()?.heading?.());
    setHeadingOut(!!heading && heading.getBoundingClientRect().bottom <= root.getBoundingClientRect().bottom);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };

  onMount(() => {
    // Capture, because scroll does not bubble and pages mount their scrollers
    // long after the bar.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches(SCROLLER) && root?.parentElement?.contains(target)) schedule();
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    onCleanup(() => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      cancelAnimationFrame(frame);
    });
  });

  // A new page, or its title arriving, is measured as it stands: usually at
  // the top, at a saved position on the way back.
  createEffect(() => {
    void location.pathname;
    void bar()?.heading?.();
    schedule();
  });

  const toTop = () => root && returnToTop(root);

  const title = () => bar()?.indicator ? '' : bar()?.title() ?? '';
  const echoed = () => !!bar()?.heading;

  return (
    <Show when={!desktopShell()}>
      <header ref={root} class={styles.bar} data-app-bar data-scrolled={scrolled() ? '' : undefined}>
        <div class={styles.leading}>
          <Show
            when={bar()?.back}
            fallback={<NavigationMenuButton class={styles.icon} onViewChange={() => bar()?.onViewChange?.()} />}
          >
            {(back) => (
              <button
                type="button"
                class={styles.icon}
                aria-label={bar()?.backLabel?.() ?? t('common.back')}
                data-pressable
                onClick={() => back()()}
              >
                <BackIcon />
              </button>
            )}
          </Show>
        </div>

        {/* Keyed on the text, so a new title arrives with its own entrance
            instead of the letters swapping under the reader's eye. */}
        <Show when={title()} keyed>
          {(text) => (
            <Show
              when={echoed()}
              fallback={
                <h1 class={styles.title}>
                  <button type="button" class={styles.titleButton} onClick={toTop}>{text}</button>
                </h1>
              }
            >
              {/* The page's own heading is the one assistive tech reads; this is
                  its echo, for the eye only. */}
              <div class={styles.title} data-echo data-hidden={headingOut() ? undefined : ''} aria-hidden="true" onClick={toTop}>
                {text}
              </div>
            </Show>
          )}
        </Show>

        <div class={styles.actions}>
          {bar()?.trailing?.()}
          <PageCommands actions={bar()?.actions?.()} />
        </div>
      </header>
    </Show>
  );
}

/** Stays inside the view's column, including when a docked player narrows it. */
export function PageIndicator() {
  const bar = currentAppBar;
  const title = () => bar()?.indicator ? bar()?.title() : undefined;
  const toTop = (event: MouseEvent & { currentTarget: HTMLButtonElement }) => returnToTop(event.currentTarget);
  return <Show when={title()}>
    <h1 class={styles.indicator} data-page-indicator>
      <Control class={styles.indicatorButton} onClick={toTop}>{title()}</Control>
    </h1>
  </Show>;
}
