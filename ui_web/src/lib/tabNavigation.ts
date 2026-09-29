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

/** Navigation entries carry their destination here (TabBar, sidebar, drawer). */
const navHrefAttribute = 'data-nav-href';

/**
 * A heartbeat on the navigation entries that lead to `hrefs`: a save is
 * acknowledged where it can be found again instead of in a toast. Reduced
 * motion keeps the tint and drops the beat.
 */
export function pulseNavigation(hrefs: string[]): void {
  const selector = hrefs.map((href) => `[${navHrefAttribute}="${href}"] svg`).join(', ');
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-ink').trim();
  const keyframes: Keyframe[] = prefersReducedMotion()
    ? [{ color: accent, offset: 0.15 }, { color: accent, offset: 0.6 }]
    : [
        { transform: 'scale(1)', easing: 'ease-out' },
        { transform: 'scale(1.22)', color: accent, offset: 0.14, easing: 'ease-in' },
        { transform: 'scale(1)', offset: 0.28, easing: 'ease-out' },
        { transform: 'scale(1.12)', color: accent, offset: 0.42, easing: 'ease-in' },
        { transform: 'scale(1)', color: accent, offset: 0.56 },
        { transform: 'scale(1)' },
      ];
  for (const icon of document.querySelectorAll<SVGSVGElement>(selector)) icon.animate?.(keyframes, 900);
}
