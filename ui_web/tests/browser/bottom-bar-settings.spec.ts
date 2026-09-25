import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

/* The disclosure used to clip its overflow, which took away a grid item's
 * minimum height: in the settings grid WebKit squeezed the closed card until
 * its label was cut, and Chromium kept the closed height once it was opened.
 * The rows stayed in the DOM and passed `toBeVisible` either way, so this
 * measures whether the card holds its content. It measures before anything
 * scrolls, because a scroll relayouts the grid and hides the bug. */
const overflow = (details: HTMLElement) => details.scrollHeight - details.clientHeight;

test('the bottom bar card holds its label closed and its editor open', async ({ page }) => {
  await mockMusicEngine(page);
  await page.goto('/player/#/settings/accessibility');
  const disclosure = page.locator('details[data-setting="bottom-bar"]');
  const summary = disclosure.locator('summary');

  await expect(summary).toBeVisible();
  expect(await disclosure.evaluate(overflow)).toBeLessThanOrEqual(1);

  await summary.click();
  await expect(disclosure).toHaveAttribute('open');
  expect(await disclosure.evaluate(overflow)).toBeLessThanOrEqual(1);
  await page.locator('[id^="bottom-position-"]').last().click({ trial: true });

  await summary.click();
  await expect(disclosure).not.toHaveAttribute('open');
  expect(await disclosure.evaluate(overflow)).toBeLessThanOrEqual(1);
});

// The closed card collapsed to nothing as soon as the page was taller than the
// screen, which on a phone is always.
test('the closed bottom bar card keeps its label when the page scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await mockMusicEngine(page);
  await page.goto('/player/#/settings/accessibility');
  const disclosure = page.locator('details[data-setting="bottom-bar"]');
  await expect(disclosure.locator('summary')).toBeAttached();
  expect(await disclosure.evaluate(overflow)).toBeLessThanOrEqual(1);
});
