import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Wait for a surface to stop moving before measuring or auditing it.
 *
 * Two races this exists for, both WebKit-mobile and both previously reported as
 * a defect in the app:
 *
 * - Axe can see a sheet on its first animation frame, when ancestor opacity is
 *   still near zero and every descendant reads as dark text on dark background.
 *   One such frame produced 688 contrast violations on a page that has none.
 * - `boundingBox()` taken while the mode pill's marker is sliding measures
 *   where the pill was passing through, against an assertion that allows a
 *   single pixel.
 *
 * `reducedMotion: 'reduce'` does not cover either: the app still runs its
 * entrances, just shorter.
 *
 * Two things keep this from becoming a hang, which is what a naive version did
 * — it timed out two tests at sixty seconds each:
 *
 * - **Looping animations are skipped.** An equalizer bar or a spinner repeats
 *   forever, so its `finished` promise never settles. Waiting on the set
 *   without filtering waits for the page to stop being alive.
 * - **The wait is capped.** Even a finite animation can be left pending by a
 *   suspended compositor. A settle that cannot finish must still return.
 */
export async function settle(page: Page, selector?: string, capMs = 2_000): Promise<void> {
  await page.evaluate(
    async ({ sel, cap }) => {
      const scope = sel ? document.querySelector(sel) : null;
      if (sel && !scope) return;
      const animations = scope
        ? scope.getAnimations({ subtree: true })
        : document.getAnimations();
      const finite = animations.filter((animation) => {
        const iterations = animation.effect?.getTiming().iterations ?? 1;
        return Number.isFinite(iterations);
      });
      await Promise.race([
        Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, cap)),
      ]);
    },
    { sel: selector ?? null, cap: capMs },
  );
}

/**
 * A box worth touching: the element has stopped moving, and the point the tap
 * or drag will land on is on screen.
 *
 * `settle()` above is not enough for this. It gives up after 2s and skips the
 * looping animations these surfaces keep running, so a rect read straight after
 * it can still be a rect of something in flight — `player-panel-swipe` measured
 * its lane at y=905 in an 844px viewport, below the fold, and the drag then
 * landed on nothing at all. Raw `touchscreen.tap` and CDP touch events run no
 * actionability checks of their own, so the wait has to be here.
 *
 * `probe` names the point the caller is about to touch; the centre by default.
 */
export async function settledBox(
  page: Page,
  target: Locator,
  probe: (box: { x: number; y: number; width: number; height: number }) => number =
    (box) => box.y + box.height / 2,
): Promise<{ x: number; y: number; width: number; height: number }> {
  let previous: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    const box = await target.boundingBox();
    const viewport = page.viewportSize()!;
    const still = !!box && !!previous && box.x === previous.x && box.y === previous.y;
    previous = box && { x: box.x, y: box.y };
    return !!box && still && probe(box) >= 0 && probe(box) < viewport.height;
  }, { message: 'the touch point must stop moving and be on screen' }).toBe(true);
  return (await target.boundingBox())!;
}
