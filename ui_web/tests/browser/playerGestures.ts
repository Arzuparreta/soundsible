import { expect, type Locator, type Page } from '@playwright/test';

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

/**
 * A touch drag across an element, in the shape a gesture actually reads:
 * several moves rather than one jump, so the axis arbitration sees the
 * direction before the distance.
 */
export async function dragTouch(
  page: Page,
  selector: string,
  delta: { dx?: number; dy?: number },
  steps = 8,
) {
  const box = (await page.locator(selector).boundingBox())!;
  const dx = delta.dx ?? 0;
  const dy = delta.dy ?? 0;
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 60);
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= steps; step += 1) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * step) / steps, y: y + (dy * step) / steps }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

/**
 * Hold a row until its menu opens.
 *
 * The shell's panels draw no ⋯ — a 44px control costs more width there than it
 * gives — so this is the gesture that reaches the menu on a touch screen.
 * `lib/responsiveTap` activates on pointer events and only for a primary touch,
 * so that is the shape this sends, and it waits out the long-press timer before
 * lifting.
 */
export async function holdForMenu(page: Page, row: Locator) {
  const target = row.locator('[data-row-main]').first();
  const box = (await target.boundingBox())!;
  const point = {
    pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true,
    clientX: box.x + box.width / 2, clientY: box.y + box.height / 2,
  };
  await target.dispatchEvent('pointerdown', point);
  await page.waitForTimeout(600);
  await target.dispatchEvent('pointerup', point);
}
