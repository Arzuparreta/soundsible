const PRIMARY_SCROLL_SELECTOR = '[data-primary-scroll]';

function prefersReducedMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Native-app tab re-selection: the active root tab returns its own surface to
 * the top. Search only opens the keyboard when it was already at the top.
 */
export function reselectPrimaryTab(href: string): void {
  const surface = document.querySelector<HTMLElement>(PRIMARY_SCROLL_SELECTOR);
  if (!surface) return;
  const wasAtTop = surface.scrollTop <= 1;
  surface.scrollTo({
    top: 0,
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
  if (href === '/search' && wasAtTop) {
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('[data-global-search-input]')?.focus();
    });
  }
}

export const primaryScrollAttribute = 'data-primary-scroll';
