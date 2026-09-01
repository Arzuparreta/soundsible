/**
 * Global keyboard shortcuts for the desktop player.
 *
 * Kept out of the store so the decision table is a pure function of the event
 * plus a small context snapshot — the store only supplies callbacks. That makes
 * every rule testable without a DOM, an audio element, or a socket.
 *
 * Two guards matter more than the table itself:
 *
 * - **Modifier keys are never ours.** `Ctrl/Cmd/Alt` + anything belongs to the
 *   OS or the browser (Cmd+A, Ctrl+→ to switch desktops, Cmd+R to reload).
 *   Claiming those keys made the app fight the machine it runs on.
 * - **Focused controls keep their keys.** Space activates the button under the
 *   focus ring; if the player swallowed it, tabbing to Shuffle and pressing
 *   Space would toggle *playback* and leave shuffle alone.
 */

/** Seconds per arrow-key seek. */
export const SEEK_STEP_SEC = 5;
/** Volume delta per Shift+Arrow, as a fraction of perceptual slider travel. */
export const VOLUME_STEP = 0.05;

/** What the shortcut table needs to know about the app right now. */
export interface ShortcutContext {
  /** Auto Mode is driving the queue. */
  autoModeActive: boolean;
  /** The Now Playing sheet is open. */
  nowPlayingOpen: boolean;
  /** Auto Mode can be toggled: a music track (not a podcast) is loaded. */
  autoModeAvailable: boolean;
}

/** Everything a shortcut can do. The store binds these to real actions. */
export interface ShortcutActions {
  togglePlay(): void;
  next(): void;
  prev(): void;
  /** Seek relative to the current position, in seconds (may be negative). */
  seekBy(deltaSec: number): void;
  /** Change volume by a fraction of perceptual slider travel (may be negative). */
  nudgeVolume(delta: number): void;
  toggleMute(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  /** Favourite/unfavourite whatever is playing. */
  toggleFavourite(): void;
  enterAutoMode(): void;
  exitAutoMode(): void;
  closeNowPlaying(): void;
}

/** Surfaces where a keystroke is text, not a command. */
function isTextEntry(el: HTMLElement | null): boolean {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/**
 * Controls that consume Space/Enter themselves. Anything focusable and
 * clickable qualifies: letting the native activation through is always more
 * correct than guessing what the user meant.
 */
function isActivatable(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SELECT') return true;
  const role = el.getAttribute('role');
  return role === 'button' || role === 'link' || role === 'option' || role === 'checkbox';
}

/**
 * Build the global `keydown` listener.
 *
 * `getContext` is read per event so the handler never holds a stale snapshot of
 * a sheet that has since closed.
 */
export function createShortcutHandler(
  getContext: () => ShortcutContext,
  actions: ShortcutActions,
): (event: KeyboardEvent) => void {
  return (e: KeyboardEvent): void => {
    // Someone closer to the source already claimed it (a sheet's Escape, a
    // menu's arrow navigation).
    if (e.defaultPrevented) return;
    // Modifier combinations belong to the OS and the browser, not to us.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const el = e.target as HTMLElement | null;
    if (isTextEntry(el)) return;

    const ctx = getContext();

    if (e.code === 'Space') {
      if (isActivatable(el)) return; // the focused control owns Space
      e.preventDefault(); // otherwise the page scrolls
      actions.togglePlay();
      return;
    }

    if (e.key === 'Escape') {
      // The unified player surface can be dismissed without stopping Auto.
      // Choosing Now Playing (or starting another context) is what hands control
      // back; Escape only returns to the app.
      if (ctx.nowPlayingOpen) actions.closeNowPlaying();
      return;
    }

    switch (e.code) {
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) {
          actions.next();
        } else {
          actions.seekBy(SEEK_STEP_SEC);
        }
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) actions.prev();
        else actions.seekBy(-SEEK_STEP_SEC);
        return;
      // Volume rides Shift+Arrow so the bare Up/Down keys still scroll the
      // list the user is looking at.
      case 'ArrowUp':
        if (!e.shiftKey) return;
        e.preventDefault();
        actions.nudgeVolume(VOLUME_STEP);
        return;
      case 'ArrowDown':
        if (!e.shiftKey) return;
        e.preventDefault();
        actions.nudgeVolume(-VOLUME_STEP);
        return;
    }

    if (e.shiftKey) return; // letter shortcuts are unshifted

    switch (e.key.toLowerCase()) {
      case 'k': // the video-player convention, alongside Space
        actions.togglePlay();
        return;
      case 'm':
        actions.toggleMute();
        return;
      case 'f':
        actions.toggleFavourite();
        return;
      case 's':
        actions.toggleShuffle();
        return;
      case 'r':
        actions.cycleRepeat();
        return;
      case 'a':
        // Auto Mode is a Now Playing affordance; binding it globally would fire
        // while the user is browsing with no idea what changed.
        if (!ctx.nowPlayingOpen || !ctx.autoModeAvailable) return;
        if (ctx.autoModeActive) actions.exitAutoMode();
        else actions.enterAutoMode();
        return;
    }
  };
}
