/**
 * Keep a focus ring for the keyboard that put it there.
 *
 * Browsers draw `:focus-visible` when they think the last interaction was the
 * keyboard. A window-manager shortcut breaks that guess: switching i3
 * workspaces with mod+n delivers the modifier's keydown to the page before the
 * window loses focus, so when the listener comes back the browser restores
 * focus to the button they last clicked — and, believing they came from the
 * keyboard, rings it. Nothing they did here asked for that ring.
 *
 * So the page keeps its own record of how the listener last moved: only keys
 * that navigate (Tab, arrows, Enter, Space, Escape, Home/End, Page Up/Down),
 * pressed without a modifier, count as the keyboard; a pointer press counts as
 * a pointer. When the window loses focus after a pointer, the control that
 * click left focused is let go, so there is nothing to ring on the way back.
 * Text fields keep focus (and their caret), and focus a listener reached with
 * the keyboard stays where it is, ring included. Tab still continues from the
 * released control: browsers keep it as the starting point.
 */

export type FocusSource = 'keyboard' | 'pointer';

const NAVIGATION_KEYS = new Set([
  'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ',
  'Escape', 'Home', 'End', 'PageUp', 'PageDown',
]);

/** Whether a keydown is the listener moving through the page, rather than a
 * modifier, a shortcut, or typing. */
export function isNavigationKey(event: KeyboardEvent): boolean {
  return NAVIGATION_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** Whether an element keeps focus whatever moved it there: somewhere to type. */
function keepsFocus(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color', 'file', 'image'].includes(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

export function installFocusSource(): () => void {
  let source: FocusSource = 'pointer';
  const set = (next: FocusSource) => { source = next; };
  const onKeyDown = (event: KeyboardEvent) => { if (isNavigationKey(event)) set('keyboard'); };
  const onPointerDown = () => set('pointer');
  const onWindowBlur = () => {
    const active = document.activeElement;
    if (source !== 'pointer' || !(active instanceof HTMLElement) || active === document.body || keepsFocus(active)) return;
    active.blur();
  };
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('blur', onWindowBlur);
  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('blur', onWindowBlur);
  };
}
