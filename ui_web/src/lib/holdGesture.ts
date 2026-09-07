/**
 * Ownership of a press-and-hold, as far as the platform is concerned.
 *
 * Safari reads a long press as "select the text under the finger" at around
 * 500ms. Ours fires at 450ms and opens a sheet, so by the time the platform
 * resolves its own gesture, what sits under the finger is the menu the press
 * just opened — and WebKit selects that menu's title. No static `user-select`
 * rule can answer this: the element that needs protecting does not exist yet
 * when the gesture starts.
 *
 * So selection is blocked for the life of a hold the app has claimed, and only
 * then. Copying a song title or an error code stays possible everywhere else,
 * which is the whole reason not to reach for a blanket `user-select: none`.
 */

/** Set on <html> while a claimed hold is in flight. `app.css` does the paint. */
const ATTRIBUTE = 'data-hold-gesture';
/** WebKit can still resolve its own selection gesture on the very touchend
 * that ends ours, so the guard outlives the finger by a beat. */
const RELEASE_TAIL_MS = 400;
/** No claim survives this, released or not. Whatever leaks — a pointer lost to
 * a re-render, a handler that never runs — the app is never left permanently
 * unselectable. */
const MAX_HOLD_MS = 5_000;

let claims = 0;
let tailTimer: number | undefined;
let failsafeTimer: number | undefined;

const blockSelectStart = (event: Event) => event.preventDefault();

function stopTimer(id: number | undefined): undefined {
  if (id !== undefined) window.clearTimeout(id);
  return undefined;
}

function arm(): void {
  tailTimer = stopTimer(tailTimer);
  document.documentElement.setAttribute(ATTRIBUTE, '');
  // Capture phase: nothing downstream gets to let the selection through. The
  // same function/capture pair registers once however often this is called,
  // so re-arming never stacks listeners.
  document.addEventListener('selectstart', blockSelectStart, true);
  failsafeTimer = stopTimer(failsafeTimer);
  failsafeTimer = window.setTimeout(disarm, MAX_HOLD_MS);
}

function disarm(): void {
  claims = 0;
  tailTimer = stopTimer(tailTimer);
  failsafeTimer = stopTimer(failsafeTimer);
  clearTextSelection();
  document.documentElement.removeAttribute(ATTRIBUTE);
  document.removeEventListener('selectstart', blockSelectStart, true);
}

/**
 * Claim the current press-and-hold for the app. Returns the release, which is
 * idempotent — callers cancel a hold from several paths (lift, pan past the
 * slop, a cancelled pointer) and none of them need to know which ran first.
 *
 * Claims nest: two rows mid-gesture (a stray second finger) need two releases.
 */
export function claimHoldGesture(): () => void {
  if (typeof document === 'undefined') return () => {};
  claims += 1;
  arm();
  // Anything the platform selected before we got here dies with the claim.
  clearTextSelection();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims = Math.max(0, claims - 1);
    if (claims > 0) return;
    clearTextSelection();
    tailTimer = stopTimer(tailTimer);
    tailTimer = window.setTimeout(disarm, RELEASE_TAIL_MS);
  };
}

/**
 * Drop whatever the document has selected. Belt to the CSS braces: if WebKit
 * managed to open a range before the guard was armed, this is what closes it.
 */
export function clearTextSelection(): void {
  if (typeof window === 'undefined') return;
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  // A selection inside a field being edited is the user's, not the platform's
  // guess at what the finger was resting on.
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return;
  selection.removeAllRanges();
}

export const holdGestureConstants = {
  ATTRIBUTE,
  RELEASE_TAIL_MS,
  MAX_HOLD_MS,
} as const;
