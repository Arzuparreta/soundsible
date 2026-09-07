/**
 * The mouse events a touch leaves behind, and where they land.
 *
 * A tap ends with the browser synthesising mousedown/mouseup/click a beat after
 * the finger lifts. That click is hit-tested where the finger was, at the moment
 * it is dispatched — it is not delivered to the element the touch began on. So
 * anything that activates on `pointerup` (lib/responsiveTap, which is every row,
 * tab and menu item in the app) and changes what is on screen hands its own tap
 * to whatever has moved underneath: choosing "Download" in a song's action sheet
 * closed the sheet, and the click belonging to that same tap landed on the song
 * row the sheet had been covering, and played it.
 *
 * So after an activation that can move the ground under the finger, the mouse
 * events the platform still owes that touch are swallowed document-wide in the
 * capture phase, before delegation offers them to anybody's handler.
 *
 * Only the events of the gesture that armed the guard are ever eaten. Three
 * things close it, and every real interaction trips one of them:
 *
 * - **A fresh `pointerdown`.** A synthesised mouse event never has one; a
 *   deliberate press always does, mouse or finger. This is what keeps the guard
 *   from eating the next thing the user does, however quickly they do it.
 * - **The click itself.** One touch owes one click, and gets swallowed once.
 * - **Time.** WebKit drops the compatibility events altogether when it uses the
 *   touch to interrupt kinetic scrolling, so the guard cannot wait forever for
 *   a click that is not coming.
 *
 * One finger, one activation — the one it was aimed at.
 */

/** How long the platform may take to deliver the events a finished tap owes. */
const WINDOW_MS = 700;

/** Everything a synthesised tap produces. Swallowing the click alone would
 * still let a ghost `mousedown` move focus or open a menu on the way past. */
const SYNTHESISED = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'] as const;

let armed = false;
let expiry: number | undefined;

function drop(): void {
  armed = false;
  if (expiry !== undefined) window.clearTimeout(expiry);
  expiry = undefined;
  for (const type of SYNTHESISED) document.removeEventListener(type, swallow, true);
  document.removeEventListener('pointerdown', drop, true);
}

function swallow(event: Event): void {
  if (!armed) return;
  // Keyboard activation synthesises a click of its own, with no pointer behind
  // it: `detail` is 0. A guard about pointing must never eat it — nor the
  // `element.click()` the app makes on its own behalf, which reports the same.
  if ((event as MouseEvent).detail === 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === 'click') drop();
}

/**
 * Swallow the mouse events the finger is about to leave behind.
 *
 * Call it from whatever handled a touch before the platform has finished with
 * it — an activation on `pointerup`, a long press that has just opened a menu
 * under the finger. Calling it again re-arms the same guard rather than
 * stacking: the same function/capture pair registers once however often it is
 * added, and the window starts afresh.
 */
export function shieldGhostClicks(): void {
  if (typeof document === 'undefined') return;
  armed = true;
  for (const type of SYNTHESISED) document.addEventListener(type, swallow, true);
  document.addEventListener('pointerdown', drop, true);
  if (expiry !== undefined) window.clearTimeout(expiry);
  expiry = window.setTimeout(drop, WINDOW_MS);
}

export const ghostClickConstants = { WINDOW_MS } as const;
