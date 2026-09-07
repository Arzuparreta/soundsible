import { expect, type Page } from '@playwright/test';

export async function snapCarousel(page: Page, panel: 'queue' | 'stage' | 'browser') {
  await page.locator('[data-now-playing-carousel]').evaluate(async (element, destination) => {
    const carousel = element as HTMLElement;
    const target = carousel.querySelector<HTMLElement>(`[data-now-playing-tile="${destination}"]`)!;
    const previousBehavior = carousel.style.scrollBehavior;
    carousel.style.scrollBehavior = 'auto';
    // Measured off the rects, like the component does: `offsetLeft` is relative
    // to the positioned workspace, not to the scroller, so it carries padding.
    carousel.scrollLeft += target.getBoundingClientRect().left - carousel.getBoundingClientRect().left;
    carousel.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    carousel.style.scrollBehavior = previousBehavior;
  }, panel);
}

export async function holdCarousel(page: Page, selector: string) {
  await page.locator(selector).dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: 200,
    clientY: 400,
  });
}

export async function releaseCarousel(page: Page, selector: string) {
  await page.locator(selector).dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: 80,
    clientY: 400,
  });
}

export async function snapPlayerCarousel(
  page: Page,
  scope: 'now-playing' | 'auto',
  panel: string,
) {
  await page.locator(`[data-${scope}-carousel]`).evaluate(async (element, args) => {
    const carousel = element as HTMLElement;
    const target = carousel.querySelector<HTMLElement>(`[data-${args.scope}-tile="${args.panel}"]`)!;
    const previousBehavior = carousel.style.scrollBehavior;
    carousel.style.scrollBehavior = 'auto';
    carousel.scrollLeft += target.getBoundingClientRect().left - carousel.getBoundingClientRect().left;
    carousel.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    carousel.style.scrollBehavior = previousBehavior;
  }, { scope, panel });
}
