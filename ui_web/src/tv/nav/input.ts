/**
 * Normalized hardware & keyboard input mapping for Smart TV remotes.
 *
 * Covers webOS / Tizen Back keycodes alongside standard DOM KeyboardEvent keys,
 * suppresses key-repeat on OK/Select and Back so held buttons activate once,
 * and leaves horizontal cursor movement/backspace inside active text inputs intact.
 */

export type TvNavDirection = 'up' | 'down' | 'left' | 'right';

export type TvAction =
  | TvNavDirection
  | 'select'
  | 'back'
  | 'media_toggle'
  | 'media_play'
  | 'media_pause'
  | 'media_next'
  | 'media_prev'
  | 'media_stop';

const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'password',
  'email',
  'url',
  'tel',
  'number',
]);

export function isTextInputElement(element: Element | null | undefined): boolean {
  if (!element || typeof (element as HTMLElement).tagName !== 'string') return false;
  const tag = element.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = ((element as HTMLInputElement).type || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  return Boolean((element as HTMLElement).isContentEditable);
}

export interface TvKeyEventLike {
  key: string;
  code?: string;
  keyCode?: number;
  repeat?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export function normalizeTvKey(
  event: TvKeyEventLike,
  target?: Element | null,
): TvAction | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;

  const key = event.key;
  const code = event.code || '';
  const keyCode = event.keyCode ?? 0;
  const repeat = Boolean(event.repeat);
  const inInput = isTextInputElement(target);

  // Media hardware transport keys always pass through regardless of focus.
  if (key === 'MediaPlayPause' || key === 'MediaPlay' || keyCode === 415) {
    return repeat ? null : key === 'MediaPlay' ? 'media_play' : 'media_toggle';
  }
  if (key === 'MediaPause' || key === 'Pause' || keyCode === 19) {
    return repeat ? null : 'media_pause';
  }
  if (key === 'MediaTrackNext' || key === 'MediaFastForward' || keyCode === 417) {
    return repeat ? null : 'media_next';
  }
  if (key === 'MediaTrackPrevious' || key === 'MediaRewind' || keyCode === 412) {
    return repeat ? null : 'media_prev';
  }
  if (key === 'MediaStop' || keyCode === 413) {
    return repeat ? null : 'media_stop';
  }

  // Hardware/remote Back: Escape, GoBack, XF86Back, LG webOS (461), Samsung Tizen (10009).
  if (
    key === 'Escape' ||
    key === 'GoBack' ||
    key === 'BrowserBack' ||
    key === 'XF86Back' ||
    keyCode === 461 ||
    keyCode === 10009
  ) {
    return repeat ? null : 'back';
  }

  if (key === 'Backspace' || keyCode === 8) {
    if (inInput) return null;
    return repeat ? null : 'back';
  }

  // Directional navigation. Repeating Up/Down/Left/Right scrolls smoothly.
  if (key === 'ArrowUp' || key === 'Up' || keyCode === 38) return 'up';
  if (key === 'ArrowDown' || key === 'Down' || keyCode === 40) return 'down';
  if (key === 'ArrowLeft' || key === 'Left' || keyCode === 37) {
    return inInput ? null : 'left';
  }
  if (key === 'ArrowRight' || key === 'Right' || keyCode === 39) {
    return inInput ? null : 'right';
  }

  // OK / Select / Enter / Space. Repeat suppressed so held OK activates once.
  if (
    key === 'Enter' ||
    key === 'Select' ||
    code === 'NumpadEnter' ||
    keyCode === 13
  ) {
    if (inInput) return null;
    return repeat ? null : 'select';
  }

  if (key === ' ' || key === 'Spacebar' || code === 'Space' || keyCode === 32) {
    if (inInput) return null;
    return repeat ? null : 'select';
  }

  return null;
}

/**
 * Return true when an event was suppressed solely due to key repeat on a control
 * action (such as OK/Enter, Space, Back, or hardware media keys) so callers can
 * prevent the browser's default button click or navigation without acting twice.
 */
export function isSuppressedTvKeyRepeat(
  event: TvKeyEventLike,
  target?: Element | null,
): boolean {
  if (!event.repeat) return false;
  if (normalizeTvKey(event, target) !== null) return false;
  // Copy KeyboardEvent prototype getters explicitly; `{ ...event }` drops non-enumerable keys.
  return (
    normalizeTvKey(
      {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        repeat: false,
      },
      target,
    ) !== null
  );
}
