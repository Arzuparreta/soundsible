/** Preserve the activation control for keyboard context menus as well as the
 * pointer coordinates for mouse menus. Touch holds deliberately omit it. */
export type MenuEvent = MouseEvent | KeyboardEvent;
